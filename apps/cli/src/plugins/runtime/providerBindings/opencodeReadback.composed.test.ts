import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionModelsSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../../packages/plugins/opencode/src/agent/providerBinding/adapter.js';
import { createOpenCodeServerRuntimeAssembly } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.js';
import { createContextFixture } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.managedServices.testkit.js';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';

describe('OpenCode Provider native model readback', () => {
  it.each(['v1', 'v2'] as const)('publishes native evidence rather than configured dispatch on %s create and resume', async dialect => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-model-readback-'));
    const prepared = OPENCODE_PROVIDER_BINDING_ADAPTER_V1.prepare({ v: 1,
      agentTargetKey: 'backend:opencode:built_in', connectionId: 'pc_native_readback' });
    const materialized = await OPENCODE_PROVIDER_BINDING_ADAPTER_V1.materialize({ v: 1, prepared,
      binding: { v: 1, agentTargetKey: 'backend:opencode:built_in',
        selection: { connectionId: 'pc_native_readback', model: { id: 'vendor/configured-x', name: 'Configured X' } },
        contributionKey: 'happier.provider.openrouter/openrouter',
        endpoint: { endpointTemplateId: 'chat', protocol: 'openai-chat', normalizedUrl: 'https://gateway.example.test/v1', publicHeaders: {} },
        runtimeCredentialTransport: null, compatibilityFingerprint: 'pcf1:native-readback' }, credential: { kind: 'none' } });
    if (materialized.kind !== 'configFile') throw new Error('Expected native config');
    for (const file of materialized.files) {
      await mkdir(join(root, file.relativePath, '..'), { recursive: true });
      await writeFile(join(root, file.relativePath), file.utf8);
    }
    try {
      for (const kind of ['create', 'resume'] as const) {
        let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
        let userId = '';
        const observed: Array<{ providerID: string; modelID: string }> = [];
        let inventoryReads = 0;
        let historyReads = 0;
        const snapshots: AgentSessionModelsSnapshot[] = [];
        const publications = createNativeAgentSessionPublications({ agentId: 'opencode', session: null,
          signal: new AbortController().signal, isCurrent: () => true, supportsInFlightSteer: false });
        const subscription = publications.modelsSource.subscribe(snapshot => snapshots.push(snapshot));
        const emit = () => {
          if (!stream) throw new Error('Native stream unavailable');
          stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(dialect === 'v2'
            ? { type: 'session.execution.succeeded', data: { sessionID: 'oc-readback' } }
            : { type: 'session.idle', properties: { sessionID: 'oc-readback' } })}\n\n`));
        };
        const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49217', managedServerRequest: async input => {
          const path = input.pathAndQuery.split('?')[0]!;
          if (path.endsWith('/event')) return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' },
            body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(dialect === 'v2'
                ? { type: 'server.connected', data: {} } : { type: 'server.connected', properties: {} })}\n\n`));
              input.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }) };
          const body = input.body ? JSON.parse(new TextDecoder().decode(input.body)) : {};
          const isPrompt = input.method === 'POST' && (path.endsWith('/prompt') || path.endsWith('/message'));
          if (isPrompt) userId = body.id ?? body.messageID ?? 'native-user-readback';
          if (path.endsWith('/message') && input.method === 'GET') historyReads++;
          if (path === '/provider' || path === '/api/provider' || path === '/api/model') inventoryReads++;
          const messages = userId ? dialect === 'v2'
            ? [{ id: userId, type: 'user', text: 'Read native model', time: { created: '2026-10-25T00:00:00.000Z' } },
              ...observed.map((model, index) => ({ id: `assistant-readback-${index}`, type: 'assistant', model: { providerID: model.providerID, id: model.modelID },
                content: [{ type: 'text', text: 'Native answer' }], finish: 'stop', time: { created: new Date(1_792_886_401_000 + index * 1000).toISOString(), completed: new Date(1_792_886_401_500 + index * 1000).toISOString() } }))]
            : [{ info: { id: userId, role: 'user', sessionID: 'oc-readback', time: { created: 1 } }, parts: [{ type: 'text', text: 'Read native model' }] },
              ...observed.map((model, index) => ({ info: { id: `assistant-readback-${index}`, role: 'assistant', sessionID: 'oc-readback', parentID: userId, ...model,
                finish: 'stop', time: { created: 2 + index * 2, completed: 3 + index * 2 } }, parts: [{ type: 'text', text: 'Native answer' }] }))] : [];
          const data = path.endsWith('/message') && input.method === 'GET' ? messages
            : path === '/session' || path === '/api/session' || path.endsWith('/oc-readback') ? { id: 'oc-readback', agent: 'build' }
              : path.endsWith('/agent') ? [{ id: 'build', name: 'build', mode: 'primary' }]
                : path.endsWith('/config') ? { model: `${prepared.adapterBindingKey}/vendor/configured-x` }
                  : isPrompt ? { id: userId } : [];
          return { ok: true, status: 200, headers: { 'content-type': 'application/json' },
            body: new Response(JSON.stringify(dialect === 'v2' ? { data } : data)).body };
        } });
        const assembly = await createOpenCodeServerRuntimeAssembly({ ctx, directory: '/repo', happierSessionId: 'happy-readback', endpoint: { mode: 'managed-spawn' },
          models: publications.services.models,
          request: { kind, sessionId: 'happy-readback', cwd: '/repo', ...(kind === 'resume' ? { providerSessionId: 'oc-readback' } : {}),
            configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 },
              options: { opencodeCliGeneration: { value: dialect, updatedAtMs: 1 } } },
            providerBinding: { connectionId: 'pc_native_readback', model: { id: 'vendor/configured-x', name: 'Configured X' },
              upstream: { protocol: 'openai-chat', normalizedUrl: 'https://gateway.example.test/v1', credential: 'none' },
              materialization: { v: 1, kind: 'configFile', rootPath: root, relativePaths: ['opencode/opencode.json'] } } } });
        try {
          expect(snapshots.at(-1)?.currentModelId).toBeNull();
          await expect(assembly.runtime.send({ inputIds: ['readback-input'], input: { text: 'Read native model' }, delivery: { kind: 'newTurn', turnId: 'readback-turn' } })).resolves.toEqual({ status: 'admitted' });
          expect(snapshots.at(-1)?.currentModelId).toBeNull();
          observed.push({ providerID: 'actual-provider', modelID: 'native-y' });
          emit();
          await expect.poll(() => snapshots.at(-1)?.currentModelId).toBe('actual-provider/native-y');
          expect(snapshots.at(-1)?.models).toBeNull();
          if (!('updateConfiguration' in assembly.runtime) || !assembly.runtime.updateConfiguration) throw new Error('Session configuration unavailable');
          await assembly.runtime.updateConfiguration({ model: { value: 'vendor/configured-x', updatedAtMs: 2 }, mode: { value: null, updatedAtMs: 0 },
            permissionIntent: { value: null, updatedAtMs: 0 }, options: {} });
          expect(snapshots.at(-1)?.currentModelId).toBe('actual-provider/native-y');
          const count = snapshots.length;
          const reads = historyReads;
          emit();
          await expect.poll(() => historyReads).toBeGreaterThan(reads);
          expect(snapshots).toHaveLength(count);
          observed.push({ providerID: 'unrelated-private-provider', modelID: 'vendor/configured-x' });
          emit();
          await expect.poll(() => snapshots.at(-1)?.currentModelId).toBe('unrelated-private-provider/vendor/configured-x');
          observed.push({ providerID: prepared.adapterBindingKey!, modelID: 'vendor/configured-x' });
          emit();
          await expect.poll(() => snapshots.at(-1)?.currentModelId).toBe('vendor/configured-x');
          const finalCount = snapshots.length;
          const finalReads = historyReads;
          emit();
          await expect.poll(() => historyReads).toBeGreaterThan(finalReads);
          expect(snapshots).toHaveLength(finalCount);
          expect(inventoryReads).toBe(0);
        } finally { await assembly.dispose(); subscription.dispose(); publications.dispose(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
