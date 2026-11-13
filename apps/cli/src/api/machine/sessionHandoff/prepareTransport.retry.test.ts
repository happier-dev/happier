import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineTransferReceiveEnvelope } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createDirectPeerTransferApp, createDirectPeerTransferRegistry, requestDirectPeerTransferToFile } from '../../../machines/transfer/directPeerTransport';
import { registerServerRoutedTransferResponder, type MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
import { createSessionHandoffAgentBundlePayloadSource } from '../../../session/handoff/agentBundle/file';
import { resolvePrepareAgentBundle } from './prepareTransport';

describe('handoff direct transfer recovery', () => {
  it.each(['dead', 'protocol', 'reset', 'persistent-reset', 'owner-reset'] as const)(
    'uses one retry owner for %s with real encrypted transfer and fallback', async mode => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-handoff-retry-'));
      const destinationPath = join(directory, 'bundle');
      const payloadSource = await createSessionHandoffAgentBundlePayloadSource({ agentId: 'claude', remoteSessionId: 'retry-session' });
      const { sizeBytes, manifestHash } = payloadSource;
      if (sizeBytes === undefined || manifestHash === undefined) throw new Error('Agent bundle payload must publish size and manifest hash');
      const transferId = 'handoff-retry';
      const registry = createDirectPeerTransferRegistry({ advertisedPort: 46001 });
      const publication = registry.publishTransfer({ transferId, payloadSource });
      const app = createDirectPeerTransferApp({ readPublishedTransfer: registry.readPublishedTransfer });
      let opens = 0;
      let fallbackOpens = 0;
      let reset = false;
      // Only the network boundary is replaced; requests reach the real app,
      // schemas, encryption and file sink on both transport paths.
      const fetchFn: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/open')) {
          opens += 1;
          if (mode === 'dead') throw new TypeError('fetch failed');
          if (mode === 'protocol') return new Response('{}', { headers: { 'content-type': 'application/json' } });
        }
        const response = await app.inject({
          method: init?.method === 'POST' ? 'POST' : 'GET',
          url: url.pathname,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        if (url.pathname.includes('/chunks/') && (mode === 'persistent-reset' || !reset)) {
          reset = true;
          // Native fetch on a socket closed after headers reports exactly this
          // TypeError/cause code (reproduced with a local HTTP server).
          let bodyStarted = false;
          const body = new ReadableStream<Uint8Array>({ pull(controller) {
            if (!bodyStarted) {
              bodyStarted = true;
              controller.enqueue(new TextEncoder().encode('{'));
            } else {
              controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
            }
          } });
          return new Response(body, { headers: { 'content-type': 'application/json' } });
        }
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      };
      type Listener = (payload: MachineTransferReceiveEnvelope) => void;
      const listeners = new Map<string, Set<Listener>>();
      const channel = (machineId: string): MachineTransferChannel => ({
        onEnvelope(listener) {
          const entries = listeners.get(machineId) ?? new Set<Listener>();
          listeners.set(machineId, entries);
          entries.add(listener);
          return () => { entries.delete(listener); };
        },
        sendEnvelope(payload) {
          for (const listener of listeners.get(payload.targetMachineId) ?? []) {
            listener({ ...payload, sourceMachineId: machineId });
          }
        },
      });
      const stopResponder = registerServerRoutedTransferResponder({
        machineTransferChannel: channel('source'),
        loadTransferPayloadSource: () => { fallbackOpens += 1; return payloadSource; },
      });
      try {
        if (mode === 'owner-reset') {
          await requestDirectPeerTransferToFile({ transferId, endpointCandidates: publication.endpointCandidates, destinationPath, fetchFn });
          expect(opens).toBe(2);
        } else {
          const result = resolvePrepareAgentBundle({
            request: { handoffId: 'retry', sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/repo',
              sourceSessionStorageMode: 'persisted', negotiatedTransportStrategy: 'direct_peer',
              allowServerRoutedFallback: mode !== 'reset' && mode !== 'persistent-reset', endpointCandidates: publication.endpointCandidates },
            actualTransportStrategy: 'direct_peer',
            handoffMetadataV2: { agentBundleTransferPublication: { transferId, sizeBytes,
              manifestHash, endpointCandidates: publication.endpointCandidates } },
            machineTransferChannel: channel('target'),
            directPeerTransfer: { publishTransfer: () => [], clearPublishedTransfer: () => undefined,
              requestPayloadFile: input => requestDirectPeerTransferToFile({ ...input, fetchFn }) },
            receivedAgentBundlePath: destinationPath,
          });
          if (mode === 'protocol') {
            await expect(result).rejects.toThrow('Invalid direct peer transfer response');
            expect(opens).toBe(1);
          } else if (mode === 'persistent-reset') {
            await expect(result).rejects.toThrow('Direct peer transfer is unavailable');
            expect(opens).toBe(3);
          } else {
            await expect(result).resolves.toMatchObject({ agentId: 'claude', remoteSessionId: 'retry-session' });
            expect(opens).toBe(mode === 'dead' ? 3 : 2);
          }
        }
        expect(fallbackOpens).toBe(mode === 'dead' ? 1 : 0);
        if (mode !== 'protocol' && mode !== 'persistent-reset') {
          expect((await readFile(destinationPath)).length).toBe(payloadSource.sizeBytes);
        }
      } finally {
        stopResponder();
        await app.close();
        await payloadSource.dispose?.();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
