import { readFileSync } from 'node:fs';
import path from 'node:path';
import axios from 'axios';

import { accountSettingsParse, sealSavedSecretResourceStoredContentV1, formatSharedSavedSecretRefV1, FeaturesResponseSchema } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { EngineAdapterResolution } from '../engineRegistryTypes';
import type { StoredCredentials } from '@/persistence';
import { setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, commitActiveAcpCatalog,
  getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveCliEngineRegistry } from './registry';
import { waitForCondition } from '@/testkit/async/waitFor';
import { withTempDir } from '@/testkit/fs/tempDir';

const mocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: mocks.readStoredCredentials,
}));

const { resolveAccountConfiguredAcpBackend } = await import('./accountConfiguredAcp');

const BACKEND_ID = 'review-bot';
const PROVIDER_SESSION_ID = 'configured-provider-session';
let observedMaterialStatus: 'ready' | 'access_removed' = 'ready';

function createCredentials(): StoredCredentials {
  return {
    token: 'token-1',
    encryption: null,
  };
}

function writeConfiguredAcpAgentScript(dir: string, fileName = 'configured-acp-agent.mjs'): string {
  return writeAcpTestAgentScript({
    dir,
    fileName,
    source: `
      import { writeFileSync } from 'node:fs';
      import path from 'node:path';
      import { fileURLToPath } from 'node:url';

      const here = path.dirname(fileURLToPath(import.meta.url));
      const observed = { pid: process.pid, scriptPath: fileURLToPath(import.meta.url), env: { ...process.env }, methods: [], loadedSessionIds: [] };
      const persist = () => writeFileSync(
        path.join(here, 'observed.json'),
        JSON.stringify(observed),
        'utf8',
      );
      persist();

      const decoder = new TextDecoder();
      let buffer = '';
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
      let cancellablePromptId = null;

      process.stdin.on('data', (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (typeof request.method !== 'string') continue;
          observed.methods.push(request.method);
          persist();
          if (request.method === 'initialize') {
            ok(request.id, {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [],
            });
          } else if (request.method === 'session/new') {
            ok(request.id, { sessionId: '${PROVIDER_SESSION_ID}' });
          } else if (request.method === 'session/load') {
            observed.loadedSessionIds.push(request.params.sessionId);
            persist();
            ok(request.id, {});
          } else if (request.method === 'session/prompt') {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: request.params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'configured reply' },
                },
              },
            });
            if (request.params.prompt.some((block) => block.type === 'text' && block.text === 'wait for cancellation')) {
              cancellablePromptId = request.id;
            } else {
              ok(request.id, { stopReason: 'end_turn' });
            }
          } else if (request.method === 'session/cancel') {
            if (cancellablePromptId !== null) {
              ok(cancellablePromptId, { stopReason: 'cancelled' });
              cancellablePromptId = null;
            }
          } else if (request.id !== undefined && request.id !== null) {
            ok(request.id, {});
          }
        }
      });
    `,
  });
}

function readObserved(dir: string): Readonly<{
  pid: number;
  scriptPath: string;
  env: Record<string, string>;
  methods: string[];
  loadedSessionIds: string[];
}> {
  return JSON.parse(readFileSync(path.join(dir, 'observed.json'), 'utf8'));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Host disposal owns the configured ACP child process. Proving the exact pid is
 * gone keeps this composed journey from passing while leaking the very process
 * the retired parallel runtime used to own.
 */
async function expectAcpChildExited(pid: number): Promise<void> {
  await waitForCondition(
    () => !isProcessAlive(pid),
    { timeoutMs: 10_000, intervalMs: 25, label: `configured ACP child ${pid} exit` },
  );
}

function setConfiguredAcpAccountSettings(scriptPath: string): void {
  setActiveAccountSettingsSnapshot({
    source: 'network',
    settings: accountSettingsParse({
      schemaVersion: 6,
    }),
    acpCatalog: { status: 'ready', revision: 4, record: AcpCatalogRecordV1Schema.parse({
        v: 1,
        definitions: [{
          id: BACKEND_ID,
          name: BACKEND_ID,
          title: 'Review Bot',
          command: process.execPath,
          args: [scriptPath],
          env: {
            CONFIGURED_ACP_LITERAL: { t: 'literal', v: 'from-account-declaration' },
            CONFIGURED_ACP_SECRET: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('acp-secret-resource') },
          },
          capabilities: {
            supportsLoadSession: true,
            supportsModes: 'unknown',
            supportsModels: 'unknown',
            supportsConfigOptions: 'unknown',
            promptImageSupport: 'no',
          },
          createdAt: 1,
          updatedAt: 2,
        }],
    }) },
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey(createCredentials()),
    savedSecretCatalogState: 'ready',
    savedSecretResources: [{ resourceId: 'acp-secret-resource', ownerAccountId: 'account-owner', displayName: 'ACP token',
      kind: 'token', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'acp-secret-resource', mode: 'plain',
        content: { v: 1, name: 'ACP token', kind: 'token', value: 'plain-runtime-secret' } }) }],
  });
}

function createComposedRuntime(resolution: EngineAdapterResolution | null, cwd: string) {
  if (!resolution) throw new Error('Expected the configured engine adapter');
  const runtime = resolution.engineAdapter.runtimeCore.createExecutionRunBackend({
    cwd, backendId: BACKEND_ID, runId: 'configured-host-run',
    controllerOccurrenceId: 'configured-controller', scope: 'session_owned', permissionMode: 'read_only',
    start: { runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
    sessionInteractionHost: {
      machineId: 'configured-machine',
      permissionHandler: createExecutionRunPermissionHandler({ permissionMode: 'read_only', backendId: BACKEND_ID }),
      // Genuine Session transport boundary, matching the incumbent native
      // Session context testkit. All runtime/context/ACP composition is real.
      session: {
        sessionId: 'configured-host-session', getMetadataSnapshot: () => null,
        updateMetadata: vi.fn(async () => {}), updateAgentState: vi.fn(async () => {}),
        enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      },
    },
  });
  if (!runtime) throw new Error('Expected the composed retained Session runtime');
  return runtime;
}

describe('Account-configured ACP composed Session journey', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readStoredCredentials.mockReset();
    mocks.readStoredCredentials.mockResolvedValue(createCredentials());
    resetActiveAccountSettingsSnapshotForTests();
    observedMaterialStatus = 'ready';
    // Genuine Home transport boundaries; admission, hydration, and resource
    // materialization remain real throughout the composed launch.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      if (!String(input).endsWith('/v1/features/authenticated')) throw new Error('Unexpected Home feature request');
      return new Response(JSON.stringify(FeaturesResponseSchema.parse({
        features: { teams: { enabled: true } }, capabilities: {},
      })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (!String(url).endsWith('/v1/account/saved-secrets/resources/materials')) throw new Error('Unexpected Home materials request');
      const ref = formatSharedSavedSecretRefV1('acp-secret-resource');
      return { status: 200, data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
        resourceId: 'acp-secret-resource', encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'ACP token', kind: 'token',
          ownerAccountId: 'account-owner', revision: observedMaterialStatus === 'ready' ? 1 : 2,
          materialStatus: observedMaterialStatus,
          capabilities: { use: observedMaterialStatus === 'ready', rename: true, rotate: true, manageAccess: true, delete: true } },
        storedContent: observedMaterialStatus === 'ready'
          ? sealSavedSecretResourceStoredContentV1({ resourceId: 'acp-secret-resource', mode: 'plain',
            content: { v: 1, name: 'ACP token', kind: 'token', value: 'plain-runtime-secret' } }) : null,
      }] }) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('re-resolves configured launches after a catalog-only update through the retained registry', async () => {
    await withTempDir('happier-configured-acp-catalog-update-', async (dir) => {
    setConfiguredAcpAccountSettings(writeConfiguredAcpAgentScript(dir, 'first-acp.mjs'));
    const registry = await resolveCliEngineRegistry({ contributes: createResolvedContributionRegistry({}) });
    const first = await registry.resolveForBackendId(BACKEND_ID);
    const changedScript = writeConfiguredAcpAgentScript(dir, 'changed-acp.mjs');
    const active = getActiveAccountSettingsSnapshot()!;
    if (active.acpCatalog?.status !== 'ready') throw new Error('Missing test catalog');
    commitActiveAcpCatalog({ scopeKey: active.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { status: 'ready', revision: 5, record: { ...active.acpCatalog.record,
        definitions: active.acpCatalog.record.definitions.map(definition => ({ ...definition, args: [changedScript] })) } } });
    const second = await registry.resolveForBackendId(BACKEND_ID);
    expect(second?.engineAdapter).not.toBe(first?.engineAdapter);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(1);
    const runtime = createComposedRuntime(second, dir);
    try {
      await runtime.provisionRuntime();
      expect(readObserved(dir).scriptPath).toBe(changedScript);
    } finally { await runtime.dispose(); }
    await expectAcpChildExited(readObserved(dir).pid);
    });
  });

  it('does not cache a configured miss after the Account row adds the backend', async () => {
    setConfiguredAcpAccountSettings('/tmp/new-acp.mjs');
    const active = getActiveAccountSettingsSnapshot()!;
    if (active.acpCatalog?.status !== 'ready') throw new Error('Missing test catalog');
    const record = active.acpCatalog.record;
    const scope = { scopeKey: active.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    commitActiveAcpCatalog({ ...scope, catalog: { status: 'ready', revision: 5, record: { v: 1, definitions: [] } } });
    const registry = await resolveCliEngineRegistry({ contributes: createResolvedContributionRegistry({}) });
    expect(await registry.resolveForBackendId(BACKEND_ID)).toBeNull();
    commitActiveAcpCatalog({ ...scope, catalog: { status: 'ready', revision: 6, record } });
    expect(await registry.resolveForBackendId(BACKEND_ID)).toMatchObject({ backendId: BACKEND_ID, provenance: 'configured' });
  });

  it('resolves the configured runtime from the owning invocation without borrowing the focused Account', async () => {
    await withTempDir('happier-configured-acp-owning-invocation-', async (dir) => {
    const script = writeConfiguredAcpAgentScript(dir);
    setConfiguredAcpAccountSettings(script);
    const captured = getActiveAccountSettingsSnapshot()!;
    const operationContext = createInvocationSavedSecretOperationContextV1({
      credentials: createCredentials(), snapshot: captured,
      serverHttpBaseUrl: resolveServerHttpBaseUrl(), isCurrent: async () => true,
    });
    const focusedCredentials: StoredCredentials = { token: 'focused-other-account', encryption: null };
    const focused = { ...captured, scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
      acpCatalog: { status: 'ready' as const, revision: 1, record: { v: 1 as const, definitions: [] } } };
    setActiveAccountSettingsSnapshot(focused);
    const focusedSnapshot = getActiveAccountSettingsSnapshot();
    mocks.readStoredCredentials.mockResolvedValue(focusedCredentials);
    const params = { contributes: createResolvedContributionRegistry({}), savedSecretOperationContext: operationContext };
    const registry = await resolveCliEngineRegistry(params);
    const resolution = await registry.resolveForBackendId(BACKEND_ID);
    expect(resolution).toMatchObject({ backendId: BACKEND_ID, provenance: 'configured' });
    const runtime = createComposedRuntime(resolution, dir);
    try {
      await runtime.provisionRuntime();
      expect(readObserved(dir)).toMatchObject({ scriptPath: script, env: { CONFIGURED_ACP_SECRET: 'plain-runtime-secret' } });
    } finally { await runtime.dispose(); }
    await expectAcpChildExited(readObserved(dir).pid);
    expect(getActiveAccountSettingsSnapshot()).toBe(focusedSnapshot);
    });
  });

  it('creates, streams, and terminates one configured ACP turn through the canonical composer and host launch custody', async () => {
    await withTempDir('happier-configured-acp-composed-create-', async (dir) => {
      setConfiguredAcpAccountSettings(writeConfiguredAcpAgentScript(dir));

      const resolution = await resolveAccountConfiguredAcpBackend(BACKEND_ID);
      expect(resolution?.provenance).toBe('configured');

      const runtime = createComposedRuntime(resolution, dir);
      expect(runtime.interaction?.capabilities.open).toEqual(['create', 'resume']);
      const events: AgentSessionRuntimeEvent[] = [];
      const unsubscribe = runtime.subscribeRuntimeEvents?.((event) => { events.push(event); });
      try {
        const { runtimeId } = await runtime.provisionRuntime();
        await runtime.deliverInput(runtimeId, { text: 'hello configured backend' }, { localId: 'configured-input-1' });
        await waitForCondition(
          () => events.some((event) => event.kind === 'turn-complete'),
          { timeoutMs: 15_000, intervalMs: 10, label: 'configured ACP turn-complete' },
        );
        await expect(runtime.deliverInput(runtimeId, { text: 'hello configured backend' }, {
          localId: 'configured-input-1',
        })).rejects.toBeInstanceOf(Error);

        const observed = readObserved(dir);
        expect(observed.methods.filter((method) => method === 'session/prompt')).toHaveLength(1);
        expect(observed.env.CONFIGURED_ACP_LITERAL).toBe('from-account-declaration');
        expect(observed.env.CONFIGURED_ACP_SECRET).toBe('plain-runtime-secret');
        expect(observed.methods).toContain('session/new');
        expect(observed.methods).not.toContain('session/load');

        expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-start', startedBy: 'provider' }));
        expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);
        expect(
          events.filter((event) => event.kind === 'provider-session-id'),
        ).toEqual([expect.objectContaining({ providerSessionId: PROVIDER_SESSION_ID })]);
        expect(
          events
            .filter((event): event is Extract<AgentSessionRuntimeEvent, { kind: 'message-delta' }> => (
              event.kind === 'message-delta'
            ))
            .map((event) => event.text)
            .join(''),
        ).toContain('configured reply');
      } finally {
        await runtime.dispose();
        unsubscribe?.();
      }
      expect(events.filter((event) => ['turn-complete', 'turn-failed', 'turn-cancelled'].includes(event.kind))).toEqual([
        expect.objectContaining({ kind: 'turn-complete' }),
      ]);
      await expectAcpChildExited(readObserved(dir).pid);
    });
  }, 40_000);

  it('refuses a configured launch after Home revokes its shared credential without a local notification', async () => {
    await withTempDir('happier-configured-acp-revoked-launch-', async (dir) => {
      setConfiguredAcpAccountSettings(writeConfiguredAcpAgentScript(dir));
      const runtime = createComposedRuntime(await resolveAccountConfiguredAcpBackend(BACKEND_ID), dir);
      const active = getActiveAccountSettingsSnapshot()!;
      const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
      expect(active.savedSecretResources?.[0]?.materialStatus).toBe('ready');
      expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toBe(active.acpCatalog);
      expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(lifetimeToken);
      observedMaterialStatus = 'access_removed';
      try {
        await expect(runtime.provisionRuntime()).rejects.toMatchObject({ code: 'saved_secret_resolution_failed', status: 'forbidden' });
      } finally {
        await runtime.dispose();
      }
    });
  }, 40_000);

  it('resumes a configured ACP Session natively through one provider load and no replay re-import', async () => {
    await withTempDir('happier-configured-acp-composed-resume-', async (dir) => {
      setConfiguredAcpAccountSettings(writeConfiguredAcpAgentScript(dir));

      const runtime = createComposedRuntime(await resolveAccountConfiguredAcpBackend(BACKEND_ID), dir);
      const events: AgentSessionRuntimeEvent[] = [];
      const unsubscribe = runtime.subscribeRuntimeEvents?.((event) => { events.push(event); });
      try {
        const { runtimeId } = await runtime.provisionRuntime({ resumeRuntimeId: PROVIDER_SESSION_ID });
        await runtime.deliverInput(runtimeId, { text: 'hello resumed backend' }, { localId: 'resumed-input' });
        await waitForCondition(() => events.some((event) => event.kind === 'turn-complete'), {
          timeoutMs: 15_000, intervalMs: 10, label: 'resumed configured ACP turn-complete',
        });
        const observed = readObserved(dir);
        expect(observed.loadedSessionIds).toEqual([PROVIDER_SESSION_ID]);
        expect(observed.methods).not.toContain('session/new');
      } finally {
        await runtime.dispose();
        unsubscribe?.();
      }
      expect(events.filter((event) => ['turn-complete', 'turn-failed', 'turn-cancelled'].includes(event.kind))).toEqual([
        expect.objectContaining({ kind: 'turn-complete' }),
      ]);
      await expectAcpChildExited(readObserved(dir).pid);
    });
  }, 40_000);

  it('cancels one provider-observed configured ACP turn without accepting uncertain input', async () => {
    await withTempDir('happier-configured-acp-composed-cancel-', async (dir) => {
      setConfiguredAcpAccountSettings(writeConfiguredAcpAgentScript(dir));
      const runtime = createComposedRuntime(await resolveAccountConfiguredAcpBackend(BACKEND_ID), dir);
      const events: AgentSessionRuntimeEvent[] = [];
      const unsubscribe = runtime.subscribeRuntimeEvents?.((event) => { events.push(event); });
      try {
        const { runtimeId } = await runtime.provisionRuntime();
        await runtime.deliverInput(runtimeId, { text: 'wait for cancellation' }, { localId: 'cancelled-input' });
        await waitForCondition(() => events.some((event) => event.kind === 'message-delta'), {
          timeoutMs: 15_000, intervalMs: 10, label: 'configured ACP output before cancel',
        });
        await runtime.cancel(runtimeId);
        await waitForCondition(() => events.some((event) => event.kind === 'turn-cancelled'), {
          timeoutMs: 15_000, intervalMs: 10, label: 'configured ACP turn-cancelled',
        });
        expect(events.some((event) => event.kind === 'input-accepted')).toBe(false);
        expect(readObserved(dir).methods.filter((method) => method === 'session/prompt')).toHaveLength(1);
      } finally {
        await runtime.dispose();
        unsubscribe?.();
      }
      expect(events.filter((event) => ['turn-complete', 'turn-failed', 'turn-cancelled'].includes(event.kind))).toEqual([
        expect.objectContaining({ kind: 'turn-cancelled', cause: 'user' }),
      ]);
      await expectAcpChildExited(readObserved(dir).pid);
    });
  }, 40_000);
});
