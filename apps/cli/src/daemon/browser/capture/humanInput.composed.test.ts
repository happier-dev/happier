import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol';
import { BrowserEventBatchV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { createBrowserSidecarCdpControlAdapterFactory } from '../sidecar/controlAdapterFactory';
import type { BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { createMachineLiveStreamRelayTerminator } from '../../peer/mediation/stream/relay';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import { createBrowserCdpScreencastProducer } from './cdpScreencast';
import { registerBrowserLiveCapture } from './registration';

describe('human browser input relay', () => {
  it('admits only the controlling human viewer and current epoch through real relay, service and CDP wiring', async () => {
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const transport = {
      openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
      dispatchPageCommand: async (command: (typeof commands)[number]) => {
        commands.push(command);
        return command.method === 'Runtime.evaluate' ? { result: { value: 'selected text' } } : {};
      },
      dispatchBrowserCommand: async () => ({ success: true }),
      subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
    };
    const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId: 'browser', sidecarId: 'sidecar',
      pipe: { readable: new PassThrough(), writable: new PassThrough() },
      connectTransport: async () => ({ transport }),
    });
    const result = await factory({ machineId: 'machine' });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.contextCapture) return;
    const contextCapture = result.contextCapture;
    const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
      transport: createControlAdapterAutomationTransport({ adapter: result.adapter, contextCapture }),
    }) });
    const producer = createBrowserCdpScreencastProducer({ contextCapture });
    const registry = createMachineLiveStreamCaptureRegistry();
    const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => automation });
    const envelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
    const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), machineId: 'machine', nowMs: Date.now,
      emitEnvelope: envelope => {
        envelopes.push(envelope);
        if (envelope.message.kind === 'frame') relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
          message: { kind: 'control', control: { v: 1, streamId: envelope.message.frame.streamId, kind: 'ack', nextSequence: envelope.message.frame.sequence + 1 } } });
      } });
    const view = { browserSessionId: 'browser', viewId: 'view' };
    const sourceId = browserViewKey(view);
    const start = (streamId: string, authority: 'present_user' | 'account_automation') => relay.start({ v: 1, streamId,
      streamFamily: 'browser.streamed', sourceId, sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'server_relay',
      authorization: { payload: { v: 1, grantId: `grant:${streamId}`, accountId: 'account', flowKind: 'live_stream', routeKind: 'server_relay',
        sourceMachineId: 'machine', targetMachineId: 'viewer', streamId, streamFamily: 'browser.streamed', sourceId, iat: Date.now(), exp: Date.now() + 60_000,
        aud: 'happier-live-stream-relay-authorization' }, signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AQID' } } }, authority);
    const input = (streamId: string, controlEpoch: number, eventId: string) => relay.applyControl({ v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
      message: { kind: 'sideband_control', control: { v: 1, streamId, sourceId, eventId, kind: 'browser_input', controlEpoch,
        event: { kind: 'wheel', target: 'page', x: 0.5, y: 0.25, deltaX: 12, deltaY: 240, sequence: 1 } } } });
    try {
      await result.adapter.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
      for (const [stream, authority] of [['one', 'present_user'], ['two', 'present_user'], ['agent', 'account_automation']] as const) {
        expect(await start(stream, authority)).toMatchObject({ ok: true });
      }
      for (const listener of [...listeners]) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
        params: { sessionId: 1, data: 'AQID', metadata: { deviceWidth: 400, deviceHeight: 200 } } });
      expect(input('agent', 0, 'agent')).toEqual({ ok: false, reasonCode: 'input_not_supported' });
      expect(input('one', 0, 'first')).toEqual({ ok: true });
      await vi.waitFor(() => expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent'))
        .toContainEqual(expect.objectContaining({ params: expect.objectContaining({ type: 'mouseWheel', x: 200, y: 50, deltaX: 12, deltaY: 240 }) })));
      const epoch = automation.getStatus(view).controlEpoch;
      expect(input('two', epoch, 'other')).toEqual({ ok: false, reasonCode: 'viewer_not_controlling' });
      expect(input('one', epoch - 1, 'stale')).toEqual({ ok: false, reasonCode: 'stale_control' });
      const effectCount = commands.filter(command => command.method === 'Input.dispatchMouseEvent').length;
      expect(effectCount).toBe(1);
      for (const listener of [...listeners]) listener({ method: 'Page.javascriptDialogOpening', sessionId: 'cdp-page', params: { type: 'prompt', message: 'private dialog' } });
      await vi.waitFor(() => expect(envelopes.some(envelope => envelope.message.kind === 'frame' && envelope.message.frame.payloadKind === 'metadata'
        && Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8').includes('private dialog'))).toBe(true));
      const privateFrames = envelopes.filter(envelope => envelope.message.kind === 'frame' && envelope.message.frame.payloadKind === 'metadata'
        && Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8').includes('private dialog'));
      expect(privateFrames.every(envelope => envelope.message.kind === 'frame' && envelope.message.frame.streamId !== 'agent')).toBe(true);
      for (const envelope of privateFrames) if (envelope.message.kind === 'frame') {
        expect(BrowserEventBatchV1Schema.safeParse(JSON.parse(Buffer.from(envelope.message.frame.payloadBase64, 'base64').toString('utf8'))).success).toBe(true);
      }
      await automation.getInputControl(view).beginConfidentialityHold();
      const clipboardRequest = { v: 1 as const, ...view, automationRequestId: 'private-copy', navigationGeneration: 0,
        requestedBy: 'user' as const, requesterRef: { kind: 'streamViewer' as const, id: 'one' },
        actionKind: 'clipboardRead' as const, payload: {}, timeoutMs: 5_000 };
      expect(await automation.execute(clipboardRequest)).toMatchObject({ status: 'succeeded',
        interactionResult: { kind: 'clipboard', text: 'selected text' } });
      expect(await automation.execute({ ...clipboardRequest, automationRequestId: 'private-agent', requestedBy: 'agent',
        requesterRef: { kind: 'agent', id: 'agent' } })).toMatchObject({ status: 'failed', errorCode: 'policy_denied' });
    } finally { await relay.dispose(); registration.dispose(); await producer.dispose(); automation.dispose(); await result.dispose?.(); }
  });
});
