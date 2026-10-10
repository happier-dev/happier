import { readFileSync } from 'node:fs';
import path from 'node:path';
import axios from 'axios';

import { accountSettingsParse, sealSavedSecretResourceStoredContentV1, formatSharedSavedSecretRefV1, FeaturesResponseSchema } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { createExecutionRunRuntime } from '@/agent/runtime/bridges/executionRun/runtime/create';
import { SessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { EngineAdapterResolution } from '../engineRegistryTypes';
import type { StoredCredentials } from '@/persistence';
import { setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, commitActiveAcpCatalog,
  getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createCustomAcpAdmittedRuntimeFixture } from '@/plugins/testkit/customAcp';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/custom-acp/src/manifest';
import type { ResolveEngineRegistryParams } from './types';
import { resolveBackendEngineAdapterResolution, resolveCliEngineRegistry } from './registry';
import { waitForCondition } from '@/testkit/async/waitFor';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } from '../../../../../../../apps/ui/sources/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { flushSessionDraft, resetSessionDraftRepositoryForTests } from '../../../../../../../apps/ui/sources/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildNewSessionAuthoringDraftFromPersistedDraft, buildSessionSpawnNewInputV2FromAuthoringDraft } from '../../../../../../../apps/ui/sources/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';

const mocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: mocks.readStoredCredentials,
}));

const BACKEND_ID = 'review-bot';
const PROVIDER_SESSION_ID = 'configured-provider-session';
const CUSTOM_ACP_ID = 'custom-acp';
let observedMaterialStatus: 'ready' | 'access_removed' = 'ready';
const runtimeCleanups: Array<() => Promise<void>> = [];

async function createContributedRuntimeFixture(definitionId = BACKEND_ID, savedSecretOperationContext?: ResolveEngineRegistryParams['savedSecretOperationContext']) {
  const fixture = await createCustomAcpAdmittedRuntimeFixture();
  runtimeCleanups.push(fixture.dispose);
  const agent = [...fixture.registry.contributes.agentDefinitionsById.values()].find(value => value.identity?.pluginId === PLUGIN_MANIFEST.id);
  if (!agent) throw new Error('The actual activation fixture did not project its Agent');
  const registryParams = {
    backendId: agent.id,
    runtimeRegistry: fixture.registry,
    agentTarget: { kind: 'agent', identity: { pluginId: PLUGIN_MANIFEST.id, localId: CUSTOM_ACP_ID }, definitionId },
    savedSecretOperationContext,
  } satisfies ResolveEngineRegistryParams;
  return { fixture, registryParams };
}

async function createContributedRegistryParams(definitionId = BACKEND_ID, savedSecretOperationContext?: ResolveEngineRegistryParams['savedSecretOperationContext']) {
  return (await createContributedRuntimeFixture(definitionId, savedSecretOperationContext)).registryParams;
}

async function resolveContributedConfiguredRuntime(definitionId = BACKEND_ID, savedSecretOperationContext?: ResolveEngineRegistryParams['savedSecretOperationContext']) {
  const params = await createContributedRegistryParams(definitionId, savedSecretOperationContext);
  const registry = await resolveCliEngineRegistry(params);
  return registry.resolveForBackendId(params.backendId);
}

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
    cwd, backendId: resolution.backendId, runId: 'configured-host-run',
    controllerOccurrenceId: 'configured-controller', scope: 'session_owned', permissionMode: 'read_only',
    start: { runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
    sessionInteractionHost: {
      machineId: 'configured-machine',
      permissionHandler: createExecutionRunPermissionHandler({ permissionMode: 'read_only', backendId: resolution.backendId }),
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

  afterEach(async () => {
    for (const dispose of runtimeCleanups.splice(0).reverse()) await dispose();
    resetSessionDraftRepositoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refuses a definition ID that has no declared executable Agent contribution', async () => {
    setConfiguredAcpAccountSettings('/tmp/custom-acp.mjs');
    const registry = await resolveCliEngineRegistry({ contributes: createResolvedContributionRegistry({}) });
    expect(await registry.resolveForBackendId(BACKEND_ID)).toBeNull();
  });

  it('refuses a selected Agent target paired with another backend before sharing in-flight resolution', async () => {
    setConfiguredAcpAccountSettings('/tmp/custom-acp.mjs');
    const params = await createContributedRegistryParams();
    const registry = await resolveCliEngineRegistry(params);
    const selected = registry.resolveForBackendId(params.backendId);
    await expect(registry.resolveForBackendId('another-agent')).rejects.toMatchObject({
      code: 'AGENT_TARGET_CONTRIBUTION_MISMATCH',
    });
    expect(await selected).toMatchObject({ backendId: params.backendId });
    await expect(resolveBackendEngineAdapterResolution('another-agent', params)).rejects.toMatchObject({
      code: 'AGENT_TARGET_CONTRIBUTION_MISMATCH',
    });
  });

  it('refuses a direct Session bridge target whose runtime descriptor names another contribution or definition', async () => {
    setConfiguredAcpAccountSettings('/tmp/custom-acp.mjs');
    const { fixture, registryParams } = await createContributedRuntimeFixture();
    for (const [agentId, definitionId, reason] of [
      [registryParams.backendId, 'another-definition', 'definition-mismatch'],
      ['codex', BACKEND_ID, 'contribution-mismatch'],
    ]) {
      const outcome = await new SessionHostBridge().createSessionRuntime(registryParams.backendId, {
        credentials: createCredentials(), directory: process.cwd(), startedBy: 'terminal',
        agentTarget: registryParams.agentTarget,
        runtimeDescriptorV1: { v: 1, agentId, agent: { definitionId } },
      }, { pluginRuntimeRegistryLease: fixture.lease }).then(async plan => {
        await plan.config.pluginRuntimeRegistryLease?.release();
        return { ok: true };
      }, (error: unknown) => ({
        ok: false,
        code: error instanceof Error && 'code' in error ? error.code : undefined,
        reason: error instanceof Error && 'reason' in error ? error.reason : undefined,
      }));
      expect(outcome).toEqual({
        ok: false, code: 'ACP_CATALOG_UNAVAILABLE', reason,
      });
    }
  });

  it('binds a direct Session bridge definition from its existing runtime descriptor', async () => {
    setConfiguredAcpAccountSettings('/tmp/custom-acp.mjs');
    const { fixture, registryParams } = await createContributedRuntimeFixture();
    const runtimeDescriptorV1 = { v: 1, agentId: registryParams.backendId, agent: { definitionId: BACKEND_ID } };
    const outcome = await new SessionHostBridge().createSessionRuntime(registryParams.backendId, {
      credentials: createCredentials(), directory: process.cwd(), startedBy: 'terminal', runtimeDescriptorV1,
    }, { pluginRuntimeRegistryLease: fixture.lease }).then(async plan => {
      const descriptor = plan.opts.runtimeDescriptorV1;
      await plan.config.pluginRuntimeRegistryLease?.release();
      return { ok: true, runtimeDescriptorV1: descriptor };
    }, (error: unknown) => ({
      ok: false, code: error instanceof Error && 'code' in error ? error.code : undefined,
    }));
    expect(outcome).toEqual({ ok: true, runtimeDescriptorV1 });
  });

  it('flushes and reopens two definitions before launching each through the same contributed Agent with its own command and environment', async () => {
    await withTempDir('happier-custom-acp-two-definitions-', async (dir) => {
      const firstScript = writeConfiguredAcpAgentScript(dir, 'first.mjs');
      const secondScript = writeConfiguredAcpAgentScript(dir, 'second.mjs');
      setConfiguredAcpAccountSettings(firstScript);
      const active = getActiveAccountSettingsSnapshot()!;
      if (active.acpCatalog?.status !== 'ready') throw new Error('Missing test catalog');
      const firstDefinition = active.acpCatalog.record.definitions[0]!;
      commitActiveAcpCatalog({ scopeKey: active.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        catalog: { ...active.acpCatalog, revision: 5, record: { v: 1, definitions: [firstDefinition,
          { ...firstDefinition, id: 'second-definition', name: 'second-definition', args: [secondScript],
            env: { CONFIGURED_ACP_LITERAL: { t: 'literal', v: 'second-environment' } } },
        ] } } });
      const definitions = [
        [BACKEND_ID, firstScript, 'from-account-declaration'],
        ['second-definition', secondScript, 'second-environment'],
      ] as const;
      const scope = { serverId: 'server-a', accountId: 'account-a' };
      resetSessionDraftRepositoryForTests();
      for (const [definitionId] of definitions) {
        writeNewSessionDraftToRepository({ scope, draftId: definitionId, draft: {
          input: 'Review this repository', composerAttachments: [], selectedMachineId: 'machine-b', selectedPath: dir,
          entryIntent: 'session', selectedProfileId: null, selectedSecretId: null, agentType: 'codex',
          permissionMode: 'default', acpSessionModeId: null, updatedAt: 10,
          agentTarget: { kind: 'agent', identity: { pluginId: PLUGIN_MANIFEST.id, localId: CUSTOM_ACP_ID }, definitionId },
          backendTarget: { kind: 'backend', backendId: definitionId, configuredBackendId: definitionId },
          executionTarget: { kind: 'machine', target: { serverId: scope.serverId, machineId: 'machine-b' } },
        } });
        await flushSessionDraft({ scope, address: { kind: 'newSession', draftId: definitionId } });
      }
      resetSessionDraftRepositoryForTests();
      for (const [definitionId, scriptPath, literal] of definitions) {
        const reopened = readNewSessionDraftFromRepository({ scope, draftId: definitionId });
        if (!reopened) throw new Error('Expected the flushed Custom ACP selection');
        const spawn = buildSessionSpawnNewInputV2FromAuthoringDraft({
          draft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened),
          creationKey: `manual:configured-${definitionId}`, permissionMode: 'default', configurationUpdatedAtMs: 10,
        });
        expect(spawn.agentTarget).toEqual({ kind: 'agent',
          identity: { pluginId: PLUGIN_MANIFEST.id, localId: CUSTOM_ACP_ID }, definitionId });
        const params = await createContributedRegistryParams();
        const registry = await resolveCliEngineRegistry({ ...params, agentTarget: spawn.agentTarget });
        const resolution = await registry.resolveForBackendId(params.backendId);
        expect(resolution).toMatchObject({
          runtimeOwner: { selected: { kind: 'plugin_engine', pluginId: 'happier.agent.custom-acp' } } });
        const runtime = createComposedRuntime(resolution, dir);
        try {
          await runtime.provisionRuntime();
          expect(readObserved(dir)).toMatchObject({ scriptPath, env: { CONFIGURED_ACP_LITERAL: literal } });
        } finally { await runtime.dispose(); }
        await expectAcpChildExited(readObserved(dir).pid);
      }
      resetSessionDraftRepositoryForTests();
    });
  }, 40_000);

  it('re-resolves configured launches after a catalog-only update through the retained registry', async () => {
    await withTempDir('happier-configured-acp-catalog-update-', async (dir) => {
    setConfiguredAcpAccountSettings(writeConfiguredAcpAgentScript(dir, 'first-acp.mjs'));
    const params = await createContributedRegistryParams();
    const registry = await resolveCliEngineRegistry(params);
    const first = await registry.resolveForBackendId(params.backendId);
    const changedScript = writeConfiguredAcpAgentScript(dir, 'changed-acp.mjs');
    const active = getActiveAccountSettingsSnapshot()!;
    if (active.acpCatalog?.status !== 'ready') throw new Error('Missing test catalog');
    commitActiveAcpCatalog({ scopeKey: active.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { status: 'ready', revision: 5, record: { ...active.acpCatalog.record,
        definitions: active.acpCatalog.record.definitions.map(definition => ({ ...definition, args: [changedScript] })) } } });
    const second = await registry.resolveForBackendId(params.backendId);
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

  it('uses the selected definition resume capability for detached execution runs', async () => {
    setConfiguredAcpAccountSettings('/tmp/custom-acp.mjs');
    async function readDetachedResumeSupport() {
      const resolution = await resolveContributedConfiguredRuntime();
      if (!resolution) throw new Error('Expected the declared Agent runtime');
      const runtime = resolution.engineAdapter.runtimeCore.createExecutionRunBackend({
        cwd: process.cwd(), backendId: resolution.backendId, runId: 'configured-detached-run',
        controllerOccurrenceId: 'configured-controller', callId: 'configured-call', sidechainId: 'configured-sidechain',
        scope: 'detached', permissionMode: 'read_only',
        start: { profileId: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
      });
      if (!runtime) throw new Error('Expected the detached runtime');
      try { return await runtime.readResumeSupport(); }
      finally { await runtime.dispose(); }
    }
    expect(await readDetachedResumeSupport()).toBe(true);
    const active = getActiveAccountSettingsSnapshot()!;
    if (active.acpCatalog?.status !== 'ready') throw new Error('Missing test catalog');
    commitActiveAcpCatalog({ scopeKey: active.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { status: 'ready', revision: 5, record: { ...active.acpCatalog.record,
        definitions: active.acpCatalog.record.definitions.map(definition => ({
          ...definition, capabilities: { ...definition.capabilities, supportsLoadSession: false },
        })),
      } },
    });
    expect(await readDetachedResumeSupport()).toBe(false);
  });

  it('migrates a selected configured execution-run target through the contributed Agent', async () => {
    await withTempDir('happier-custom-acp-selected-run-', async dir => {
      const script = writeConfiguredAcpAgentScript(dir);
      setConfiguredAcpAccountSettings(script);
      const params = await createContributedRegistryParams();
      const registry = await resolveCliEngineRegistry(params);
      const runtime = createExecutionRunRuntime({
        cwd: dir, backendId: params.backendId,
        backendTarget: { kind: 'configuredAcpBackend', backendId: BACKEND_ID },
        engineRegistry: registry, runId: 'selected-configured-run', controllerOccurrenceId: 'selected-controller',
        scope: 'session_owned', permissionMode: 'read_only',
        start: { runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
        sessionInteractionHost: {
          machineId: 'configured-machine',
          permissionHandler: createExecutionRunPermissionHandler({ permissionMode: 'read_only', backendId: params.backendId }),
          session: {
            sessionId: 'configured-host-session', getMetadataSnapshot: () => null,
            updateMetadata: vi.fn(async () => {}), updateAgentState: vi.fn(async () => {}),
            enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
          },
        },
      });
      try {
        await runtime.provisionRuntime();
        expect(readObserved(dir)).toMatchObject({ scriptPath: script, env: { CONFIGURED_ACP_LITERAL: 'from-account-declaration' } });
      } finally { await runtime.dispose(); }
      await expectAcpChildExited(readObserved(dir).pid);
    });
  }, 40_000);

  it('does not cache a configured miss after the Account row adds the backend', async () => {
    setConfiguredAcpAccountSettings('/tmp/new-acp.mjs');
    const active = getActiveAccountSettingsSnapshot()!;
    if (active.acpCatalog?.status !== 'ready') throw new Error('Missing test catalog');
    const record = active.acpCatalog.record;
    const scope = { scopeKey: active.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    commitActiveAcpCatalog({ ...scope, catalog: { status: 'ready', revision: 5, record: { v: 1, definitions: [] } } });
    const params = await createContributedRegistryParams();
    const registry = await resolveCliEngineRegistry(params);
    await expect(registry.resolveForBackendId(params.backendId)).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE', reason: 'definition-not-found' });
    commitActiveAcpCatalog({ ...scope, catalog: { status: 'ready', revision: 6, record } });
    expect(await registry.resolveForBackendId(params.backendId)).toMatchObject({ backendId: params.backendId, provenance: 'first_party' });
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
    const params = await createContributedRegistryParams(BACKEND_ID, operationContext);
    const registry = await resolveCliEngineRegistry(params);
    const resolution = await registry.resolveForBackendId(params.backendId);
    expect(resolution).toMatchObject({ backendId: params.backendId, provenance: 'first_party' });
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

      const resolution = await resolveContributedConfiguredRuntime(BACKEND_ID);
      expect(resolution?.agent.identity).toEqual({ pluginId: PLUGIN_MANIFEST.id, localId: CUSTOM_ACP_ID });

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
      const runtime = createComposedRuntime(await resolveContributedConfiguredRuntime(BACKEND_ID), dir);
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

      const runtime = createComposedRuntime(await resolveContributedConfiguredRuntime(BACKEND_ID), dir);
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
      const runtime = createComposedRuntime(await resolveContributedConfiguredRuntime(BACKEND_ID), dir);
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
