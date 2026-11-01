import '@/unistyles';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { buildArtifactHtmlDocumentV1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';
import { HOSTED_HTML_GUEST_BOOTSTRAP_SCRIPT } from '../../../plugins/hostedWeb/guestBootstrap.generated';
import { validatePluginHostedWebBridgeMessage } from '../../../plugins/hostedWeb/bridge';
import { WebIframeEngine } from './WebIframeEngine';
import type { BrowserFrameMessageReceipt } from '../types';

const root = createRoot(document.getElementById('root')!);
const events: string[] = [];
const activations: boolean[] = [];
const rejections: string[] = [];
const identity = { instanceId: 'browser-visual', mountNonce: 'browser-nonce' };
let sendHost: ((message: unknown) => void) | null = null;
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
    events.length = 0;
    activations.length = 0;
    rejections.length = 0;
    const html = buildArtifactHtmlDocumentV1(artifactHtmlBundleFromBodyV1(body), {
        requestedCapabilities: networkOrigins ? { networkOrigins } : { network },
        ...(generatedSdk ? {
            bootstrapConfig: { identity, hostOrigin: location.origin, frameOrigin: 'null' },
            guestBootstrapScript: HOSTED_HTML_GUEST_BOOTSTRAP_SCRIPT,
        } : {}),
    });
    root.render(<WebIframeEngine title="Authored visual" testID="guest" html={html}
        sandbox="allow-scripts" revokeOnUnexpectedNavigation webMessageBridge={bridge}
        onLoad={() => events.push('load')}
        onUnexpectedNavigation={() => events.push('retired')} />);
}

Object.assign(globalThis, { hostedFrameHarness: { mount, events, activations, rejections, push: (message: unknown) => sendHost?.(message) } });
