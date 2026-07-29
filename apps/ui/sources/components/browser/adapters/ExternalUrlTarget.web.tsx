import * as React from 'react';
import { View } from 'react-native';

import {
    WEBVIEW_LOAD_FAILED_ERROR_CODE,
    type BrowserControlViewState,
    type BrowserViewLifecycleEmitter,
} from '@/sync/domains/browser/control';
import {
    buildOpenExternalTabSelection,
    openBrowserExternalTabSelection,
} from '@/sync/domains/browser/adapters/selection';
import { resolveExternalUrlIframeSandbox } from '@/sync/domains/browser/adapters/targets/localPreview';

import { BrowserFrameExternalEscape } from '../frame/BrowserFrameExternalEscape';
import { BrowserFrameNonFramable } from '../frame/BrowserFrameNonFramable';
import { BrowserFrameUnavailable } from '../frame/BrowserFrameUnavailable';
import { BrowserViewFrame } from '../frame/BrowserViewFrame.web';
import { browserFrameStyles } from '../frame/styles';
import { DesktopWebViewEngine, type DesktopWebViewEngineBridge } from '../frame/engines/DesktopWebViewEngine';
import { useWebIframeFramability } from '../frame/engines/useWebIframeFramability';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '../frame/types';

function resolveExternalUrl(view: BrowserControlViewState): string | null {
    if (view.target.kind !== 'externalUrl') {
        return null;
    }
    return view.pendingUrl ?? view.currentUrl ?? view.target.url ?? null;
}

/**
 * The web-platform external-URL frame (also the Tauri web bundle). Three render paths:
 * - `desktopWebView` engine (Tauri desktop): a real Wry child WebView hosts arbitrary sites.
 * - `webIframe` engine (plain browser): embed the site in a sandboxed iframe, with the engine's
 *   load-vs-timeout framability heuristic. On the non-framable outcome render the fulfilled
 *   open-in-system-browser fallback (BRW-4 / §3.4) — framability is decided HERE, not by the
 *   selector.
 * - otherwise fail closed with the resolved reason code.
 */
export function ExternalUrlTarget(props: Readonly<{
    testID: string;
    view?: BrowserControlViewState | null;
    profileId?: string | null;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig | null;
    bridge?: DesktopWebViewEngineBridge;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    onLifecycle?: BrowserViewLifecycleEmitter;
    nowMs?: () => number;
    reasonCode?: string;
}>): React.ReactElement {
    const view = props.view;
    const isExternalUrl = view?.target.kind === 'externalUrl' && view.adapterKind === 'externalUrl';
    const externalUrl = view && isExternalUrl ? resolveExternalUrl(view) : null;
    const onLifecycle = props.onLifecycle;
    const framability = useWebIframeFramability({
        url: view?.engineKind === 'webIframe' ? externalUrl : null,
        navigationKey: props.navigationKey,
    });

    if (view && isExternalUrl && view.engineKind === 'desktopWebView') {
        if (!props.profileId) {
            return (
                <BrowserFrameUnavailable
                    testID={props.testID}
                    reasonCode="browser_profile_missing"
                />
            );
        }
        return (
            <DesktopWebViewEngine
                view={view}
                profileId={props.profileId}
                testID={props.testID}
                diagnostics={props.diagnostics}
                bridge={props.bridge}
                onLifecycle={onLifecycle}
                nowMs={props.nowMs}
            />
        );
    }

    if (view && isExternalUrl && view.engineKind === 'webIframe' && externalUrl) {
        // ONE open-in-system-browser action, shared by the definitive non-framable fallback and
        // the always-present escape, so both fulfil the identical OWNER-OPEN external path.
        const openInSystemBrowser = () => {
            void openBrowserExternalTabSelection(buildOpenExternalTabSelection(externalUrl));
        };
        if (framability.verdict === 'nonFramable') {
            return (
                <BrowserFrameNonFramable
                    testID={props.testID}
                    onOpenInSystemBrowser={openInSystemBrowser}
                />
            );
        }
        // The iframe renders for the pending/framable verdict; the escape is always overlaid
        // because the verdict can be a false "framable" for an X-Frame-Options site that fires
        // onLoad on a blank document — the user must always be able to escape to their browser.
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
                    }}
                />
                <BrowserFrameExternalEscape
                    testID={props.testID}
                    onOpenInSystemBrowser={openInSystemBrowser}
                />
            </View>
        );
    }

    return (
        <BrowserFrameUnavailable
            testID={props.testID}
            reasonCode={props.reasonCode ?? 'external_url_unavailable'}
        />
    );
}
