import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { collectTransferRelayV2Traffic } from './transferRelayV2TrafficCapture';

type Handler = (value: any) => void;

function createPageHarness() {
  const handlers = new Map<string, Handler[]>();

  const page = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return page;
    },
  };

  return {
    page,
    emit(event: string, value: any) {
      for (const handler of handlers.get(event) ?? []) {
        handler(value);
      }
    },
  };
}

describe('collectTransferRelayV2Traffic', () => {
  it('redacts synthetic Bearer and token credentials from captured frames and HTTP evidence', async () => {
    const harness = createPageHarness();
    // Only Playwright's external event boundary is replaced; capture and redaction stay real.
    const traffic = collectTransferRelayV2Traffic(harness.page as unknown as Page);
    const websocketHarness = createPageHarness();
    const bearerSentinel = 'synthetic-Bearer._-+/=';
    const tokenSentinel = 'synthetic-token+/=';
    const payload = JSON.stringify({ kind: 'chunk', authorization: `Bearer ${bearerSentinel}`, token: tokenSentinel });
    const redacted = JSON.stringify({ kind: 'chunk', authorization: 'Bearer <redacted>', token: '<redacted>' });
    const url = 'https://example.test/v1/updates/session-1';

    harness.emit('websocket', websocketHarness.page);
    websocketHarness.emit('framesent', { payload });
    websocketHarness.emit('framereceived', { payload: Buffer.from(payload) });
    harness.emit('request', { url: () => url, method: () => 'POST', postData: () => payload });
    harness.emit('response', { url: () => url, status: () => 200, text: async () => payload });
    await Promise.resolve();

    expect(traffic.frames).toEqual([redacted, redacted]);
    expect(traffic.updateBodies).toEqual([`[request POST] ${url}\n${redacted}`, `[response 200] ${url}\n${redacted}`]);
    for (const entry of [...traffic.frames, ...traffic.updateBodies]) {
      expect(entry).not.toContain(bearerSentinel);
      expect(entry).not.toContain(tokenSentinel);
    }
    expect(traffic.sawRelayV2EventName()).toBe(true);
  });

  it('captures renamed daemon.transfer chunk RPC requests when bulk-transfer capture is enabled', () => {
    const harness = createPageHarness();
    const traffic = collectTransferRelayV2Traffic(harness.page as any, { captureBulkTransfer: true });

    harness.emit('request', {
      url: () => 'https://example.test/rpc',
      method: () => 'POST',
      postData: () => JSON.stringify({ machineMethod: 'daemon.transfer.download.chunk', request: { downloadId: 'd1', index: 0 } }),
    });

    expect(traffic.updateBodies.some((entry) => entry.includes('daemon.transfer.download.chunk'))).toBe(true);
  });

    it('captures renamed daemon.transfer chunk RPC websocket frames when bulk-transfer capture is enabled', () => {
        const harness = createPageHarness();
        const traffic = collectTransferRelayV2Traffic(harness.page as any, { captureBulkTransfer: true });
    const websocketHarness = createPageHarness();

    harness.emit('websocket', websocketHarness.page);
    websocketHarness.emit('framesent', {
      payload: JSON.stringify({ machineMethod: 'daemon.transfer.download.chunk', request: { downloadId: 'd1', index: 0 } }),
    });

        expect(traffic.frames.some((entry) => entry.includes('daemon.transfer.download.chunk'))).toBe(true);
    });

    it('captures renamed daemon.transfer RPC responses when bulk-transfer capture is enabled', async () => {
        const harness = createPageHarness();
        const traffic = collectTransferRelayV2Traffic(harness.page as any, { captureBulkTransfer: true });

        harness.emit('response', {
            url: () => 'https://example.test/rpc',
            status: () => 500,
            text: async () => JSON.stringify({
                machineMethod: 'daemon.transfer.download.chunk',
                error: 'chunk unavailable',
                errorCode: 'CHUNK_UNAVAILABLE',
            }),
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(traffic.updateBodies.some((entry) => entry.includes('daemon.transfer.download.chunk'))).toBe(true);
        expect(traffic.updateBodies.some((entry) => entry.includes('CHUNK_UNAVAILABLE'))).toBe(true);
    });

    it('treats captured relay request envelopes as relay-v2 traffic even when the raw event name is omitted', () => {
        const harness = createPageHarness();
        const traffic = collectTransferRelayV2Traffic(harness.page as any);

    harness.emit('request', {
      url: () => 'https://example.test/v1/updates/session-1',
      method: () => 'POST',
      postData: () => JSON.stringify({
        kind: 'chunk',
        encryptedDataKeyEnvelopeBase64: 'key-envelope',
        payloadBase64: 'payload',
      }),
    });

    expect(traffic.sawRelayV2EventName()).toBe(true);
  });
});
