import { createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { applyDisplayTitleSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { waitForCondition } from '@/testkit/async/waitFor';
import { createPublicAcpRuntimeProtocols } from './createPublicAcpRuntimeProtocols';

it.each(['openExecutionRunV1', 'openExecutionRunConversationV1'] as const)('reports the selected ACP source before %s connects', async (method) => {
  await withTempDir('happier-acp-run-source-', async cwd => {
    let selectedProtocol = 'native';
    const protocolsAtInitialize: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line) as { id?: string | number; method?: string };
          if (request.id === undefined) continue;
          if (request.method === 'initialize') protocolsAtInitialize.push(selectedProtocol);
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
            ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
            : request.method === 'session/new' ? { sessionId: 'native-run' } : { stopReason: 'end_turn' } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const protocols = createPublicAcpRuntimeProtocols({ pluginId: 'fixture', agentId: 'fixture',
      onSessionOpening: () => { selectedProtocol = 'acp'; },
      signal: new AbortController().signal, isCurrent: () => true, services: createUnavailablePluginServices() });
    let runtime: Awaited<ReturnType<NonNullable<typeof protocols.acp[typeof method]>>> | undefined;
    try {
      const open = protocols.acp[method];
      if (!open) throw new Error('Expected ACP execution-run opener');
      runtime = await open({ kind: 'create', runId: 'run', cwd,
        profile: { pluginId: 'fixture', localId: 'review' }, input: { text: 'Review' } },
      { transport: { kind: 'tcp', host: '127.0.0.1', port: address.port } });
      expect(protocolsAtInitialize).toEqual(['acp']);
    } finally {
      await runtime?.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

it('seeds native titles outside turns, preserves user renames, and does not republish repeated info', async () => {
  await withTempDir('happier-acp-native-title-', async cwd => {
    // FX 0.0.14 captured 2026-10-27: E-fx-live-probe.md:226.
    const info = { sessionUpdate: 'session_info_update', title: 'Request to Reply OK', updatedAt: '2026-10-27T09:51:22Z' };
    const created = createSessionMetadata({ flavor: 'fixture', machineId: 'machine', directory: cwd,
      launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }) });
    expect(created.metadata.summary).toBeUndefined();
    const storage = createSessionClientWithMetadata({ initialMetadata: created.metadata });
    let publications = 0;
    let processedUpdates = 0;
    // Replace only persisted Session transport. The registered display.title
    // updater, ACP connection, notification handler and composer remain real.
    const titleSession = {
      async updateMetadata(updater: Parameters<typeof storage.session.updateMetadata>[0]) {
        const before = storage.getMetadata();
        storage.session.updateMetadata(updater);
        if (storage.getMetadata() !== before) publications++;
        processedUpdates++;
      },
    };
    let selectedProtocol = 'native';
    const protocolsAtInitialize: string[] = [];
    let peer: Socket | undefined;
    const server = createServer(socket => {
      peer = socket;
      let buffer = '';
      const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
      const notify = (update: unknown) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session', update } });
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line) as { id?: string | number; method?: string };
          if (request.id === undefined) continue;
          if (request.method === 'initialize') protocolsAtInitialize.push(selectedProtocol);
          if (request.method === 'session/new') {
            notify({ ...info, title: null });
            notify({ ...info, title: '  ' });
            notify(info);
          }
          send({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
            ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
            : request.method === 'session/new' ? { sessionId: 'native-session' } : {} });
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const protocols = createPublicAcpRuntimeProtocols({ pluginId: 'fixture', agentId: 'fixture',
      onSessionOpening: () => { selectedProtocol = 'acp'; },
      signal: new AbortController().signal, isCurrent: () => true,
      services: createUnavailablePluginServices(), titleSession });
    let runtime: Awaited<ReturnType<typeof protocols.acp.open>> | undefined;
    try {
      runtime = await protocols.acp.open({ kind: 'create', sessionId: 'session', cwd },
        { transport: { kind: 'tcp', host: '127.0.0.1', port: address.port } });
      expect(protocolsAtInitialize).toEqual(['acp']);
      await waitForCondition(() => processedUpdates === 1, { timeoutMs: 2_000, label: 'opening native title' });
      expect(storage.getMetadata().summary).toEqual({ text: info.title, updatedAt: Date.parse(info.updatedAt) });
      expect(publications).toBe(1);

      const notify = (update: unknown) => {
        if (!peer) throw new Error('Expected native ACP peer');
        peer.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session', update } })}\n`);
      };
      notify({ ...info, updatedAt: '2026-10-27T10:00:00Z' });
      await waitForCondition(() => processedUpdates === 2, { timeoutMs: 2_000, label: 'idle duplicate native title' });
      expect(publications).toBe(1);

      // UI Rename/session.title.set consumes this registered title updater.
      const renamedAt = Date.parse('2026-10-27T10:01:00Z');
      await titleSession.updateMetadata(metadata => applyDisplayTitleSessionMetadata(metadata, {
        title: 'My chosen title', updatedAt: renamedAt,
      }));
      notify({ ...info, title: 'Later native title', updatedAt: '2026-10-27T10:02:00Z' });
      await waitForCondition(() => processedUpdates === 4, { timeoutMs: 2_000, label: 'native info after user rename' });
      expect(storage.getMetadata().summary).toEqual({ text: 'My chosen title', updatedAt: renamedAt });
      expect(publications).toBe(2);
    } finally {
      await runtime?.dispose();
      peer?.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
