import '@/unistyles';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { artifactHtmlBundleFromBodyV1, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { buildArtifactHtmlDocumentV1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';
import { HOSTED_HTML_GUEST_BOOTSTRAP_SCRIPT } from '../../../plugins/hostedWeb/guestBootstrap.generated';
import { validatePluginHostedWebBridgeMessage } from '../../../plugins/hostedWeb/bridge';
import { WebIframeEngine } from './WebIframeEngine';
import type { BrowserFrameMessageReceipt } from '../types';
import { HostedHtmlSurfaceAdapter, type CallerHostedHtmlRuntime } from '../../../ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { createSessionCallerHostedHtmlRequestController } from '../../../ui/surfaces/hostedHtml/sessionCallerHostedHtmlRequestController';
import { UnistylesRuntime } from 'react-native-unistyles';

const root = createRoot(document.getElementById('root')!);
const events: string[] = [];
const activations: boolean[] = [];
const rejections: string[] = [];
const identity = { instanceId: 'browser-visual', mountNonce: 'browser-nonce' };
let sendHost: ((message: unknown) => void) | null = null;
const heights: number[] = [];
const bridge = {
    targetOrigin: '*', allowWildcardTargetOrigin: true, exactDocumentChannel: true,
    onMessage: (event: MessageEvent, receipt: BrowserFrameMessageReceipt) => {
        const result = validatePluginHostedWebBridgeMessage({
            message: event.data, origin: event.origin, expectedOrigin: 'null', identity,
            allowedMessageKinds: new Set(['ready']),
        });
        if (!result.ok) { rejections.push(result.code); return; }
        const envelope = result.envelope;
        events.push(envelope.kind);
        activations.push(receipt.consumeTransientActivation());
        return { version: 1 as const, identity, sequence: 0, requestSequence: envelope.sequence, kind: 'ack' as const, payload: envelope.payload };
    },
    attachHostMessages: (send: (message: unknown) => void) => {
        sendHost = send;
        return () => { events.push('detached'); sendHost = null; };
    },
};

function mount(body: string, network: 'none' | 'open', networkOrigins?: string[], generatedSdk = false) {
    mountBundle(artifactHtmlBundleFromBodyV1(body), {
        requestedCapabilities: networkOrigins ? { networkOrigins } : { network },
        ...(generatedSdk ? {
            bootstrapConfig: { identity, hostOrigin: location.origin, frameOrigin: 'null' },
            guestBootstrapScript: HOSTED_HTML_GUEST_BOOTSTRAP_SCRIPT,
        } : {}),
    });
}

const callerRuntime: CallerHostedHtmlRuntime = {
    serverIdentityId: 'browser-home', accountId: 'browser-account', accountEncryptionMode: 'plain', hostOrigin: location.origin,
    admittedHostMethods: ['context', 'watchContext'],
    lifetime: { isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
    createRequestController: publishResourceEvent => createSessionCallerHostedHtmlRequestController({
        serverId: 'browser-home', serverIdentityId: 'browser-home', accountId: 'browser-account',
        isAccountCurrent: () => true, isSessionCurrent: () => true, pluginTarget: null, publishResourceEvent,
        executeHostAction: async () => { throw new Error('Presentation must not execute an Action'); },
        notify: () => undefined,
    }),
};

function CallerPresentation(props: { body: string }) {
    const [height, setHeight] = React.useState(280);
    return <div style={{ height, display: 'flex', flexDirection: 'column' }}><HostedHtmlSurfaceAdapter title="Caller presentation" recordRevision="1"
        approvalSubject="browser-presentation" source={artifactHtmlBundleFromBodyV1(props.body)} target={{ kind: 'app' }}
        runtime={callerRuntime} testID="caller" onIntrinsicHeightChange={value => { heights.push(value); setHeight(value); }} /></div>;
}

function mountCaller(body: string) {
    heights.length = 0;
    root.render(<CallerPresentation body={body} />);
}

function mountBundle(bundle: ArtifactHtmlBundleV1, options: Parameters<typeof buildArtifactHtmlDocumentV1>[1] = {}) {
    renderFrame({ html: buildArtifactHtmlDocumentV1(bundle, options) });
}

function renderFrame(source: { html: string }) {
    events.length = 0;
    activations.length = 0;
    rejections.length = 0;
    root.render(<WebIframeEngine title="Authored visual" testID="guest" {...source}
        sandbox="allow-scripts" revokeOnUnexpectedNavigation webMessageBridge={bridge}
        onLoad={() => events.push('load')}
        onUnexpectedNavigation={() => events.push('retired')} />);
}

Object.assign(globalThis, { hostedFrameHarness: { mount, mountBundle, mountCaller, heights, events, activations, rejections,
    setCallerTheme: (theme: 'light' | 'dark') => UnistylesRuntime.setTheme(theme),
    push: (message: unknown) => sendHost?.(message) } });
