import * as React from 'react';
import { View } from 'react-native';

import {
    WEBVIEW_LOAD_FAILED_ERROR_CODE,
    type BrowserViewLifecycleEmitter,
} from '@/sync/domains/browser/control/lifecycle';
import type { BrowserControlViewState } from '@/sync/domains/browser/control/state';
import { resolveExternalUrlIframeSandbox } from '@/sync/domains/browser/adapters/targets/localPreview';
import { t } from '@/text';

import { BrowserFrameNonFramable } from '../frame/BrowserFrameNonFramable';
import { BrowserFrameStatusCapsule } from '../frame/BrowserFrameStatusCapsule';
import { BrowserFrameUnavailable } from '../frame/BrowserFrameUnavailable';
import { BrowserViewFrame } from '../frame/BrowserViewFrame.web';
import { browserFrameStyles } from '../frame/styles';
import { DesktopWebViewEngine, type DesktopWebViewEngineBridge } from '../frame/engines/DesktopWebViewEngine';
import { useWebIframeFramability } from '../frame/engines/useWebIframeFramability';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '../frame/types';
import type { BrowserSurfaceLifecycleState } from '../surfaces/browserSurfaceLifecycle';

function resolveExternalUrl(view: BrowserControlViewState): string | null {
    if (view.target.kind !== 'externalUrl') {
        return null;
    }
    return view.pendingUrl ?? view.currentUrl ?? view.target.url ?? null;
}

/**
 * The web-platform external-URL frame (also the Tauri web bundle). Three render paths:
 * - `desktopWebView` engine (Tauri desktop): a real Wry child WebView hosts arbitrary sites.
 * - `webIframe` engine (plain browser): embed the site in a sandboxed iframe. A frame error renders
 *   the fulfilled open-in-system-browser fallback (BRW-4 / §3.4); a slow load keeps the page and
 *   offers the same escape in a quiet status capsule — framability is decided HERE, not by the
 *   selector. The escape is always also in the chrome's `⋯` ("Open in your browser"), so nothing
 *   floats over the page's own controls.
 * - otherwise fail closed with the resolved reason code.
 */
export function ExternalUrlTarget(props: Readonly<{
    testID: string;
    view?: BrowserControlViewState | null;
    profileId?: string | null;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig | null;
    automation?: BrowserAutomationEngineBridgeConfig;
    bridge?: DesktopWebViewEngineBridge;
    occlusionProbe?: () => boolean;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    onLifecycle?: BrowserViewLifecycleEmitter;
    lifecycleState?: BrowserSurfaceLifecycleState;
    nowMs?: () => number;
    reasonCode?: string;
    onOpenInSystemBrowser?: () => void;
}>): React.ReactElement {
    const view = props.view;
    const isExternalUrl = view?.target.kind === 'externalUrl' && view.adapterKind === 'externalUrl';
    const externalUrl = view && isExternalUrl ? resolveExternalUrl(view) : null;
    const onLifecycle = props.onLifecycle;
    const framability = useWebIframeFramability({
        url: view?.engineKind === 'webIframe' ? externalUrl : null,
        navigationKey: props.navigationKey,
    });
    // R-3: ONE open-in-system-browser action for every branch of this target — the definitive
    // non-framable fallback, the slow-load hint, AND the unavailable card. All three
    // fulfil the identical OWNER-OPEN external path, so an unavailable in-app engine can never
    // dead-end while the URL is still known.
    const openInSystemBrowser = props.onOpenInSystemBrowser;
    const escapeAction = externalUrl ? openInSystemBrowser : undefined;

    if (view && isExternalUrl && view.engineKind === 'desktopWebView') {
        if (!props.profileId) {
            return (
                <BrowserFrameUnavailable
                    testID={props.testID}
                    reasonCode="browser_profile_missing"
                    onOpenInSystemBrowser={escapeAction}
                />
            );
        }
        return (
            <DesktopWebViewEngine
                view={view}
                profileId={props.profileId}
                testID={props.testID}
                diagnostics={props.diagnostics}
                automation={props.automation}
                bridge={props.bridge}
                occlusionProbe={props.occlusionProbe}
                // G8 break #2: the Wry child view dispatches reload/stop SOLELY from this prop. It
                // was declared here and forwarded only into the webIframe config below, so the
                // desktop toolbar's reload/stop reached no engine at all.
                navigationCommand={props.navigationCommand}
                onLifecycle={onLifecycle}
                lifecycleState={props.lifecycleState}
                onOpenInSystemBrowser={escapeAction}
                nowMs={props.nowMs}
            />
        );
    }

    if (view && isExternalUrl && view.engineKind === 'webIframe' && externalUrl) {
        if (framability.verdict === 'nonFramable') {
            if (!openInSystemBrowser) {
                return <BrowserFrameUnavailable testID={props.testID} reasonCode="browser_control_route_unavailable" />;
            }
            return (
                <BrowserFrameNonFramable
                    testID={props.testID}
                    onOpenInSystemBrowser={openInSystemBrowser}
                />
            );
        }
        // The iframe renders for every verdict but a definite error. A slow page keeps loading under
        // a quiet hint that offers the escape; a late load removes it.
        return (
            <View style={browserFrameStyles.root}>
                <BrowserViewFrame
                    engine={{
                        kind: 'webIframe',
                        title: view.title ?? view.target.display?.title ?? externalUrl,
                        url: externalUrl,
                        sandbox: resolveExternalUrlIframeSandbox(),
                        testID: props.testID,
                        navigationKey: props.navigationKey,
                        navigationCommand: props.navigationCommand,
                        referrerPolicy: 'no-referrer',
                        // B-2 cause-2: the iframe load result drives BOTH the framability heuristic
                        // AND the control-reducer lifecycle (loading → ready/failed). The loaded URL
                        // is the iframe `src` (`externalUrl`), so `loadFinished` commits it.
                        onLoad: () => {
                            framability.onLoad();
                            onLifecycle?.({ kind: 'loadFinished', url: externalUrl });
                        },
                        onError: () => {
                            framability.onError();
                            onLifecycle?.({ kind: 'loadFailed', errorCode: WEBVIEW_LOAD_FAILED_ERROR_CODE, url: externalUrl });
                        },
                        ...(props.diagnostics ? { diagnostics: props.diagnostics } : {}),
                        ...(props.automation ? { automation: props.automation } : {}),
                    }}
                />
                <BrowserFrameStatusCapsule
                    visible={framability.verdict === 'slow'}
                    testID={`${props.testID}-slow-hint`}
                    text={t('browserPresence.slowPage')}
                    busy
                    action={openInSystemBrowser ? { label: t('browserPresence.openInYourBrowser'), onPress: openInSystemBrowser } : undefined}
                />
            </View>
        );
    }

    return (
        <BrowserFrameUnavailable
            testID={props.testID}
            reasonCode={props.reasonCode ?? 'external_url_unavailable'}
            onOpenInSystemBrowser={escapeAction}
        />
    );
}
