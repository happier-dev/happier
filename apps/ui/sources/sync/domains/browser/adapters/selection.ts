import type {
    BrowserAdapterCapabilitiesV1,
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetKindV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';

import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { buildBrowserAdapterCapabilities } from './capabilities';
import {
    resolveDesktopWebViewUnavailableReason,
    resolveBrowserAdapterUnavailableReason,
    resolveExternalUrlPolicyDeniedReason,
    type BrowserAdapterUnavailableReason,
    type BrowserAdapterUnavailableReasonCode,
} from './availability';
import {
    desktopWebViewAvailabilitySupportsBrowsing,
    type DesktopWebViewNativeAvailability,
} from './desktopWebView';
import type { BrowserAdapterPlatform } from './engines';

export type BrowserAdapterSelection =
    | Readonly<{
        ok: true;
        outcome: 'renderEngine';
        adapterKind: BrowserSemanticAdapterKindV1;
        engineKind: Exclude<BrowserRenderEngineKindV1, 'unavailable'>;
        capabilities: BrowserAdapterCapabilitiesV1;
      }>
    | Readonly<{
        // A sandboxed web iframe cannot host arbitrary cross-origin sites, so an allowed web
        // external URL is fulfilled by opening it in a new OS browser tab rather than embedding.
        ok: true;
        outcome: 'openExternalTab';
        adapterKind: 'externalUrl';
        url: string;
      }>
    | Readonly<{
        ok: false;
        adapterKind: BrowserSemanticAdapterKindV1;
        engineKind: 'unavailable';
        reasonCode: BrowserAdapterUnavailableReasonCode;
        reason: BrowserAdapterUnavailableReason;
      }>;

export type SelectBrowserTargetAdapterInput = Readonly<{
    target: BrowserViewTargetV1;
    platform: BrowserAdapterPlatform;
    targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
}>;

function success(
    adapterKind: BrowserSemanticAdapterKindV1,
    targetKind: BrowserViewTargetKindV1,
    engineKind: Exclude<BrowserRenderEngineKindV1, 'unavailable'>,
    options: Readonly<{
        desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    }> = {},
): BrowserAdapterSelection {
    return {
        ok: true,
        outcome: 'renderEngine',
        adapterKind,
        engineKind,
        capabilities: buildBrowserAdapterCapabilities({
            adapterKind,
            supportedTargetKinds: [targetKind],
            supportedRenderEngines: [engineKind],
            desktopWebViewSupport: options.desktopWebViewAvailability?.supports,
        }),
    };
}

/**
 * The semantic adapter each target kind resolves to. Used to describe a target that never reaches
 * its branch — a policy denial refuses it before any engine is chosen.
 */
const ADAPTER_KIND_BY_TARGET_KIND = {
    localServicePreview: 'localPreview',
    hostedPluginWeb: 'hostedPlugin',
    externalUrl: 'externalUrl',
    streamedBrowser: 'streamedBrowserSurface',
    simulatorPreview: 'simulatorPreview',
} as const satisfies Record<BrowserViewTargetKindV1, BrowserSemanticAdapterKindV1>;

/**
 * Build the `openExternalTab` selection outcome — the explicit, fulfilled non-framable web
 * fallback. The selector itself never returns this (framability is decided by the engine, §3.4);
 * the web iframe engine constructs it when its load-vs-timeout heuristic concludes a site refuses
 * embedding, then hands it to {@link openBrowserExternalTabSelection}. One owner of the outcome.
 */
export function buildOpenExternalTabSelection(url: string): BrowserAdapterSelection {
    return {
        ok: true,
        outcome: 'openExternalTab',
        adapterKind: 'externalUrl',
        url,
    };
}

function unavailable(
    adapterKind: BrowserSemanticAdapterKindV1,
    reason: BrowserAdapterUnavailableReason,
): BrowserAdapterSelection {
    return {
        ok: false,
        adapterKind,
        engineKind: 'unavailable',
        reasonCode: reason.reasonCode,
        reason,
    };
}

/**
 * The engine that ACTUALLY renders a first-party embedded target — a local-service preview or a
 * hosted plugin UI, both of which the app serves itself.
 *
 * G17: on Tauri desktop these render through the WEB bundle. `LocalPreviewTarget.web.tsx` and
 * `HostedPluginTarget.web.tsx` hard-code `kind: 'webIframe'` and never mount the Wry child view —
 * that engine is reserved for arbitrary third-party sites, which a sandboxed iframe cannot host.
 * Claiming `desktopWebView` here made `buildBrowserAdapterCapabilities` hit its desktop-webview
 * gate with no `desktopWebViewSupport`, collapsing the WHOLE capability set to
 * `supportedRenderEngines: ['unavailable']`, so a Local Services preview tab on desktop shipped a
 * dead address bar and reload while the identical tab on web worked.
 */
function selectEmbeddedFrameEngine(
    platform: BrowserAdapterPlatform,
): 'webIframe' | 'nativeWebView' | null {
    if (platform === 'web' || platform === 'desktop') return 'webIframe';
    if (platform === 'ios' || platform === 'android') return 'nativeWebView';
    return null;
}

/**
 * The engine that can host an ARBITRARY third-party site. Deliberately has no `desktop` arm: the
 * desktop route is the Wry child view (or the system-browser handoff), both resolved earlier in the
 * `externalUrl` branch. Desktop reaching this helper means the target policy was never resolved,
 * which fails closed.
 */
function selectExternalSiteFrameEngine(
    platform: BrowserAdapterPlatform,
): 'webIframe' | 'nativeWebView' | null {
    if (platform === 'web') return 'webIframe';
    if (platform === 'ios' || platform === 'android') return 'nativeWebView';
    return null;
}

export function selectBrowserTargetAdapter(input: SelectBrowserTargetAdapterInput): BrowserAdapterSelection {
    // The policy owner's decision is the authority for EVERY target kind (E2-F6). It used to be
    // read only inside the `externalUrl` branch, so `evaluateBrowserTargetPolicy` could deny a
    // hosted-plugin or streamed target and this selector would still hand back a fully renderable
    // engine — the policy owner and the selector disagreeing about the same question. Denial is a
    // refusal to select anything, so it belongs before any engine is chosen. An ABSENT decision
    // still means "not evaluated here" and is not treated as a denial; callers that must enforce
    // policy pass one.
    const policyDecision = input.targetPolicyDecision;
    if (policyDecision && policyDecision.state !== 'allowed') {
        const adapterKind = ADAPTER_KIND_BY_TARGET_KIND[input.target.kind];
        return unavailable(
            adapterKind,
            input.target.kind === 'externalUrl'
                ? resolveExternalUrlPolicyDeniedReason(input.target.kind)
                : resolveBrowserAdapterUnavailableReason({ adapterKind, targetKind: input.target.kind }),
        );
    }
    switch (input.target.kind) {
        case 'localServicePreview': {
            const engineKind = selectEmbeddedFrameEngine(input.platform);
            return engineKind
                ? success('localPreview', input.target.kind, engineKind)
                : unavailable('localPreview', resolveBrowserAdapterUnavailableReason({
                    adapterKind: 'localPreview',
                    targetKind: input.target.kind,
                }));
        }
        case 'hostedPluginWeb': {
            const engineKind = selectEmbeddedFrameEngine(input.platform);
            return engineKind
                ? success('hostedPlugin', input.target.kind, engineKind)
                : unavailable('hostedPlugin', resolveBrowserAdapterUnavailableReason({
                    adapterKind: 'hostedPlugin',
                    targetKind: input.target.kind,
                }));
        }
        case 'externalUrl': {
            if (input.targetPolicyDecision?.state === 'allowed' && input.platform === 'desktop') {
                if (desktopWebViewAvailabilitySupportsBrowsing(input.desktopWebViewAvailability)) {
                    return success('externalUrl', input.target.kind, 'desktopWebView', {
                        desktopWebViewAvailability: input.desktopWebViewAvailability,
                    });
                }
                // R-3: the in-app engine cannot host this site here, but the user asked for an
                // ALLOWED page — hand it to their system browser instead of dead-ending. Windows,
                // X11, Wayland, headless Linux and pre-14 macOS all land here, and until now every
                // one of them disabled the launchpad row and silently dropped a typed URL. This is
                // the SAME fulfilled `openExternalTab` outcome the web build already uses for a
                // non-framable site — one owner, one escape.
                //
                // Gated on a RESOLVED availability: a null availability means the native probe has
                // not answered yet (or the Tauri host is missing), and silently opening an OS tab
                // during that window would be a wrong, invisible action. That case still fails
                // closed.
                if (input.desktopWebViewAvailability) {
                    return buildOpenExternalTabSelection(input.target.url);
                }
                return unavailable('externalUrl', resolveDesktopWebViewUnavailableReason(input.target.kind));
            }
            // Web: the selector ALWAYS returns a renderable `webIframe` for an allowed (non-denied)
            // external URL. Framability is NOT knowable synchronously here (cross-origin frames are
            // unreadable and response headers are not observable from the parent), so the engine —
            // not the selector — decides framable vs. non-framable and surfaces the open-in-system-
            // browser fallback via `openBrowserExternalTabSelection` (BRW-5, §3.4).
            //
            // ios/android: mobile WebViews can host arbitrary third-party sites, so an allowed
            // external URL renders inline through the native WebView engine.
            if (input.targetPolicyDecision?.state !== 'denied') {
                const engineKind = selectExternalSiteFrameEngine(input.platform);
                if (engineKind) {
                    return success('externalUrl', input.target.kind, engineKind);
                }
            }
            return unavailable('externalUrl', resolveBrowserAdapterUnavailableReason({
                adapterKind: 'externalUrl',
                targetKind: input.target.kind,
            }));
        }
        case 'streamedBrowser':
            // DEC-5: CONTRACTED, and now unconditional. Nothing in production produces a
            // `streamedBrowser` target, no renderer for the kind exists, and the server excludes it
            // outright — so a reachable daemon control transport is not evidence of a surface. The
            // old success branch published a full navigable capability set to agents and plugins
            // for something that could never paint. The `streamedSurface` ENGINE kind is retained;
            // only this adapter branch is gone.
            return unavailable('streamedBrowserSurface', resolveBrowserAdapterUnavailableReason({
                adapterKind: 'streamedBrowserSurface',
                targetKind: input.target.kind,
            }));
        case 'simulatorPreview':
            return success('simulatorPreview', input.target.kind, 'streamedSurface');
    }
}

/**
 * Canonical fulfilment for the web `openExternalTab` selection outcome: hands the URL to the
 * shared {@link openExternalUrl} opener (new OS browser tab on web, system handler on native).
 * No-ops and returns `false` for render-engine or unavailable selections — it is a plain OS-tab
 * handoff and never injects into or scripts the opened page. The open-target host calls this
 * before dispatching an `openView`, so an external web target never dead-ends as unavailable.
 */
export async function openBrowserExternalTabSelection(
    selection: BrowserAdapterSelection,
): Promise<boolean> {
    if (selection.ok && selection.outcome === 'openExternalTab') {
        return openExternalUrl(selection.url);
    }
    return false;
}

export { resolveBrowserAdapterUnavailableReason };
