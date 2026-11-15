import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageEventIngestRequestSchema, ingestPluginManifestV2 } from '@happier-dev/protocol';
import { UsageSourceResultV1Schema, UsageSourcesListV1Schema, parseUsageSourceActionResult } from '@happier-dev/protocol/usage/usageSources';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-pi/manifest';
import { createPiExternalSessionsContribution } from '../../../../../packages/plugins/pi/src/agent/externalSessions/contribution';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createNativeUsageCaptureStore } from '@/usage/collector/nativeUsageCaptureState';
import { createNativeUsageCollector } from '@/usage/collector/nativeUsageCollector';
import { discoverNativeUsageSourceMetadata, resolveNativeUsageSourceMetadata } from '@/usage/collector/nativeUsageSourceDiscovery';
import { createUsageObservationPublisher } from '@/usage/createUsageObservationPublisher';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import { registerMachineUsageSourceRpcHandlers } from './rpcHandlers.usageSources';

describe('native source Machine RPC with real capture custody', () => {
  it('admits caller-local Home labels for private sources and delegates consent, stop, root replacement and scoped deletion without a Session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-source-rpc-'));
    const lifetime = new AbortController();
    let collector: ReturnType<typeof createNativeUsageCollector> | undefined;
    try {
      const agentDir = join(directory, 'pi');
      const overrideDir = join(directory, 'override');
      const observedAt = 1767225601000;
      for (const root of [join(agentDir, 'sessions'), overrideDir]) {
        const nativeDir = join(root, '--project--');
        await mkdir(nativeDir, { recursive: true });
        await writeFile(join(nativeDir, 'session.jsonl'), [
          { type: 'session', version: 3, id: 'native-session', timestamp: '2026-01-01T00:00:00.000Z' },
          { type: 'message', id: 'paid-inference', parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
            message: { role: 'assistant', model: 'model', provider: 'provider', timestamp: observedAt,
              usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
              content: [{ type: 'text', text: 'private native content' }] } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
      }
      const ingested = ingestPluginManifestV2(PLUGIN_MANIFEST);
      if (!ingested.ok) throw new Error(JSON.stringify(ingested.diagnostics));
      const manifest = ingested.manifest;
      const agents = manifest.contributes.agents.map(definition => projectManifestAgentContribution({
        definition, pluginId: manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
      }));
      const bounded = createBoundedAgentExternalSessionsContribution({
        contribution: createPiExternalSessionsContribution({ env: { NODE_ENV: 'test', PI_CODING_AGENT_DIR: agentDir } }),
        identity: { pluginId: manifest.id, agentId: 'pi', occurrenceId: 'occurrence',
          contributionQualifiedId: `${manifest.id}/agents/pi`, sourceCustody: { kind: 'development', registeredRootId: 'root' } },
        retirementSignal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
        createInvocationExec: async () => createUnavailablePluginServices().exec,
      });
      const boundary = { catalogEntry: agents.find(agent => agent.id === 'pi')?.catalogEntry ?? null, externalSessions: bounded, occurrenceId: 'occurrence', retirementSignal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted };
      const authority = { serverId: 'home', accountId: 'owner', machineId: 'machine' };
      const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
      const store = createNativeUsageCaptureStore({ path: join(directory, 'capture.sealed'), authority, storage });
      let supported = false;
      let current = true;
      let retireWhenConsented: string | undefined;
      const published: unknown[] = [];
      const deleted: unknown[] = [];
      const publisher = createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://server.test',
        emitUsageEvent: () => null, // Authenticated HTTP is the boundary; codec, publication and custody remain real.
        postJson: async (request: Parameters<NonNullable<Parameters<typeof createUsageObservationPublisher>[0]['postJson']>>[0]) => { if (!(supported)) throw Object.assign(new Error('Not found'), { response: { status: 404 } }); return await (async request => { published.push(request.body); return { ok: true }; })(request); },
      });
      const activeServerDir = join(directory, 'home');
      collector = createNativeUsageCollector({ authority, storage, store, publisher,
        budgetRegistry: new ExecutionBudgetRegistry(),
        discoverSources: () => discoverNativeUsageSourceMetadata({ agents, account: { connectedServicesV2: [] },
          activeServerId: authority.serverId, activeServerDir, signal: lifetime.signal, resolveBoundary: async () => boundary }),
        resolveRoot: async (source, root) => {
          const resolved = await resolveNativeUsageSourceMetadata({ agents, agentId: 'pi', activeServerDir,
            boundary, signal: lifetime.signal, source: { kind: 'piAgentDir', agentDir,
              ...(root === null ? {} : { sessionsRoot: expandHomeDirPath(root) }) } });
          if (!resolved) throw new Error('Root unavailable');
          return { ...resolved.descriptor, rootKind: root === null ? 'default' : 'override' };
        },
        readAccounting: async (source, signal) => bounded.readAccounting({ source: source.source, cursor: source.cursor, signal }),
        // File-event delivery is an OS boundary; no internal source service is mocked.
        subscribeSource: async () => ({ dispose() {} }),
        deleteHistory: async (source, dateRange) => {
          deleted.push({ machineId: authority.machineId, sourceRootKey: source.sourceId, dateRange });
          return { success: true, deletedEventCount: 1 };
        },
      });
      // The transport registrar erases request generics; handlers validate their raw payload themselves.
      const handlers = new Map<string, RpcHandler>();
      const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
      registerMachineUsageSourceRpcHandlers({ ...authority, custodianAccountId: authority.accountId,
        installationId: 'installation', service: collector, rpcHandlerManager: registrar });
      const context: RpcHandlerContext = { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        // Authentication is an external boundary: retire the actor after actual durable consent admission.
        verifyMachineAdmissionCurrent: async () => current && !(retireWhenConsented
          && (await store.load()).sources.some(row => row.sourceId === retireWhenConsented && row.consented)) };
      const target = { serverId: 'browser-home', machineId: 'machine' };
      const call = async (method: string, input: unknown, ctx = context) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error(`Missing source RPC: ${method}`);
        return await handler(input, ctx);
      };
      const discoveredResponse = await call('usage.sources.discover', target);
      expect(discoveredResponse).toMatchObject({ sources: expect.any(Array) });
      expect(parseUsageSourceActionResult('usage.sources.discover', target, discoveredResponse)).not.toBeNull();
      const discovered = UsageSourcesListV1Schema.parse(discoveredResponse).sources[0]!;
      expect(discovered.serverId).toBe(target.serverId);
      expect(discovered).toMatchObject({ root: { path: join(agentDir, 'sessions') }, consent: 'disabled', pendingCount: 0 });
      expect((await store.load()).sources[0]).toMatchObject({ pending: [] });
      expect(published).toEqual([]);
      const selected = { ...target, sourceId: discovered.sourceId };
      expect(await call('usage.sources.root.set', { ...target, sourceId: 'missing-source', root: overrideDir }))
        .toMatchObject({ ok: false, errorCode: 'usage_source_not_found' });
      expect(await call('usage.sources.consent.set', { ...selected, enabled: true }, { ...context,
        machineAdmission: { ...context.machineAdmission!, actorAccountId: 'other' } })).toMatchObject({ ok: false, errorCode: 'access_denied' });
      expect(await call('usage.sources.get', { ...selected, machineId: 'other' })).toMatchObject({ ok: false, errorCode: 'access_denied' });
      expect(await call('usage.sources.get', selected, { ...context,
        machineAdmission: { ...context.machineAdmission!, installationId: 'replaced' } })).toMatchObject({ ok: false, errorCode: 'access_denied' });
      current = false;
      expect(await call('usage.sources.get', selected)).toMatchObject({ ok: false, errorCode: 'access_denied' });
      current = true;
      const consentInput = { ...selected, enabled: true };
      const consentResponse = await call('usage.sources.consent.set', consentInput);
      expect(parseUsageSourceActionResult('usage.sources.consent.set', consentInput, consentResponse)).not.toBeNull();
      expect(UsageSourceResultV1Schema.parse(consentResponse).source)
        .toMatchObject({ consent: 'enabled' });
      // Serving a caller's routing label must never rebind durable capture custody.
      expect((await store.load()).authority).toEqual(authority);
      expect((await collector.get(discovered.sourceId))[0]?.serverId).toBe(authority.serverId);
      await collector.flushPending();
      expect(UsageSourcesListV1Schema.parse(await call('usage.sources.get', selected)).sources[0]?.pendingCount).toBe(1);
      expect(UsageSourceResultV1Schema.parse(await call('usage.sources.stop', selected)).source)
        .toMatchObject({ consent: 'disabled', pendingCount: 1 });
      const replacement = UsageSourceResultV1Schema.parse(await call('usage.sources.root.set', { ...selected, root: overrideDir })).source;
      expect(replacement).toMatchObject({ root: { kind: 'override', path: overrideDir }, consent: 'disabled' });
      expect(replacement.sourceId).not.toBe(discovered.sourceId);
      expect(UsageSourcesListV1Schema.parse(await call('usage.sources.get', selected)).sources[0]?.pendingCount).toBe(1);
      expect(await call('usage.sources.history.delete', { ...selected, dateRange: { startMs: observedAt, endMs: observedAt } }))
        .toEqual({ success: true, deletedEventCount: 1 });
      expect(deleted).toEqual([{ machineId: 'machine', sourceRootKey: discovered.sourceId, dateRange: { startMs: observedAt, endMs: observedAt } }]);
      expect((await store.load()).sources.find(row => row.sourceId === discovered.sourceId)?.pending).toEqual([]);
      supported = true; retireWhenConsented = replacement.sourceId;
      const late = await call('usage.sources.consent.set', { ...target, sourceId: replacement.sourceId, enabled: true });
      expect(late).toMatchObject({ ok: false, errorCode: 'usage_source_mutation_acknowledged_scope_retired',
        details: { mutationStatus: 'applied' } });
      expect(JSON.stringify(late)).not.toContain(overrideDir);
      expect((await store.load()).sources.find(row => row.sourceId === replacement.sourceId)?.consented).toBe(true);
      await collector.flushPending();
      const body = UsageEventIngestRequestSchema.parse(published[0]);
      expect(body).toMatchObject({ subject: { kind: 'native', machineId: 'machine' }, tokens: { total: 12 } });
      expect(body.sessionId).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('private native content');
      expect(JSON.stringify(body)).not.toContain(overrideDir);
    } finally {
      lifetime.abort(); await collector?.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
});
