import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, AccountEncryptionCurrentnessResponseSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema, ProviderSettingsV1Schema, V2SessionRecordSchema } from '@happier-dev/protocol';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { join } from 'node:path';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveAgentSpawnPurposeDeclarations } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { inspectSessionContinuation } from '@/session/agentTransition/sessionContinuationInspection';
import { commitActiveConnectedAccountCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { resolveAgentNativeSpawnDefinitiveRejection, resolveCurrentProviderSpawnDefinitiveRejection } from './currentDefinitiveRejection';

describe('resolveCurrentProviderSpawnDefinitiveRejection', () => {
  it('keeps a managed target available so its required model can be chosen', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'continuation-purpose-model-' }, async ({ homeDir }) => {
      const service = { pluginId: 'acme.shared-registry', localId: 'accounts' };
      const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
        controller: pluginReloadController, physicalGateway: true, includeBundledDeclarations: true,
        connectedAccounts: [{ purpose: 'inference', service, materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider: { pluginId: 'acme.shared-registry', localId: 'gateway' },
            purpose: 'upstream', modelIdPrefix: 'native/' } }] });
      try {
        const purpose = { consumer: { pluginId: 'acme.managed-run', localId: 'agent' }, purpose: 'inference' };
        const snapshot = { ...fixture.snapshot, connectedPurposeCatalog: { status: 'ready' as const, revision: 1,
          record: { key: 'purposes' as const, value: { v: 1 as const, bindings: [{ purpose,
            target: { kind: 'account' as const, account: { service, accountId: 'upstream-account' } } }] } } } };
        setActiveAccountSettingsSnapshot(snapshot);
        const purposePublication = { scopeKey: snapshot.scopeKey,
          lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), key: 'purposes' as const };
        const deps = { getActiveAccountSettingsSnapshot,
          tryAcquireAuthoritativePluginRuntimeRegistryLease: () => fixture.gateway!.controller.tryAcquireRuntimeRegistry() };
        const target = { agentId: fixture.agentId, agentTargetKey: fixture.agentTargetKey, deps };
        const rawSession = V2SessionRecordSchema.parse({ id: 'source-session', machineId: fixture.machineId, encryptionMode: 'plain',
          metadata: JSON.stringify({ flavor: 'codex', path: homeDir, machineId: fixture.machineId }),
          metadataVersion: 1, metadataLayoutVersion: 0, agentState: null, agentStateVersion: 1,
          active: false, seq: 1, createdAt: 1, updatedAt: 1, activeAt: 1, dataEncryptionKey: null });
        const accountEncryptionCurrentness = AccountEncryptionCurrentnessResponseSchema.parse({
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        await expect(inspectSessionContinuation({ credentials: { token: 'token', encryption: null },
          request: { v: 1, sourceSessionId: 'source-session', selection: { v: 1, agentId: fixture.agentId } },
          // Network transport is the boundary; catalog publication, identity,
          // metadata reader and definitive Provider inspection remain real.
          deps: { resolveSessionTransportContext: async () => ({ ok: true, sessionId: 'source-session',
            rawSession, accountEncryptionCurrentness, ctx: null, mode: 'plain' }) },
        })).resolves.toEqual({ type: 'available', protocolVersion: 1, sameSessionTransition: true });
        await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target, selection: {} }))
          .resolves.toEqual({ ok: true, ref: null });
        await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target, selection: { modelId: 'native/example' } }))
          .resolves.toMatchObject({ ok: true, ref: { modelId: 'native/example' } });
        expect(commitActiveConnectedAccountCatalog({ ...purposePublication,
          catalog: { status: 'unavailable', reason: 'unreachable' } })).toBe(true);
        await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target, selection: {} }))
          .resolves.toEqual({ ok: true, ref: null });
        expect(commitActiveConnectedAccountCatalog({ ...purposePublication,
          catalog: { ...snapshot.connectedPurposeCatalog,
            record: { key: 'purposes', value: { v: 1, bindings: [] } } } })).toBe(true);
        await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target, selection: {} }))
          .resolves.toEqual({ ok: true, ref: null });
        // Pi's native OpenAI purpose has its own startupModel. A managed-only
        // model requirement must not override that Agent-owned native default.
        const native = resolveAgentSpawnPurposeDeclarations({ agentId: 'pi', contributions: fixture.contributes })
          ?.declarations.find(row => row.purpose === 'openai-api-key');
        if (!native) throw new Error('Expected Pi native OpenAI declaration');
        expect(commitActiveConnectedAccountCatalog({ ...purposePublication, catalog: { ...snapshot.connectedPurposeCatalog,
          record: { key: 'purposes', value: { v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.pi', localId: 'pi' }, purpose: native.purpose },
            target: { kind: 'account', account: { service: native.service, accountId: 'native-account' } },
          }] } } } })).toBe(true);
        await expect(resolveCurrentProviderSpawnDefinitiveRejection({ agentId: 'pi', agentTargetKey: 'agent:happier.agent.pi/pi',
          selection: {}, deps })).resolves.toEqual({ ok: true, ref: null });
      } finally { resetActiveAccountSettingsSnapshotForTests(); await fixture.cleanup(); }
    });
  });
  it('uses an offered Provider model instead of a static native model catalog while retaining mode and syntax checks', () => {
    const input = { agentId: 'qwen', selection: { modelId: 'team-only-model', providerConnectionId: null },
      sourceModel: { id: 'team-only-model', name: 'Team model' } };
    const native = { ...input, sourceModel: undefined };
    const differentSourceModel = { ...input, sourceModel: { id: 'a-different-model', name: 'Different model' } };
    expect(resolveAgentNativeSpawnDefinitiveRejection(input)).toEqual({ ok: true });
    // Qwen's connected-key route accepts explicit IDs through its declared freeform policy.
    expect(resolveAgentNativeSpawnDefinitiveRejection(native)).toEqual({ ok: true });
    expect(resolveAgentNativeSpawnDefinitiveRejection(differentSourceModel)).toMatchObject({ ok: false });
    expect(resolveAgentNativeSpawnDefinitiveRejection({ ...input, selection: { ...input.selection,
      sessionConfigOptionOverrides: { v: 0 } } })).toMatchObject({ ok: false });
    expect(resolveAgentNativeSpawnDefinitiveRejection({ ...input, agentId: 'gemini',
      selection: { ...input.selection, acpSessionModeId: 'plan' } })).toMatchObject({ ok: false });
  });

  it('rejects a missing admitted connection without rejecting a valid route or an unavailable catalog', async () => {
    const provider = ProviderContributionV1Schema.parse({ v: 1, id: 'gateway', name: 'Gateway', kind: 'cloud',
      endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } }],
      credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-responses'],
        uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
      catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'model', name: 'Model' }] },
    });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
      manifest: createPluginManifestV2Fixture({ id: 'example.spawn-provider', contributes: { providers: [provider] } }),
      files: { 'daemon.mjs': 'export function activate() {}' },
    }] });
    try {
      resetActiveAccountSettingsSnapshotForTests();
      const providerSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{ v: 1, id: 'pc_gateway',
        source: { kind: 'contribution', contributionKey: 'example.spawn-provider/gateway' }, role: 'default',
        displayName: 'Gateway', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 }] });
      const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'spawn-provider-account',
        providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(providerSettings).catalog } };
      setActiveAccountSettingsSnapshot(snapshot);
      // Select the real controller for this private physical plugin fixture;
      // Account publication, catalog admission and cold decisions stay real.
      const deps = { getActiveAccountSettingsSnapshot,
        tryAcquireAuthoritativePluginRuntimeRegistryLease: () => runtime.controller.tryAcquireRuntimeRegistry() };
      const target = { agentId: 'codex' as const, agentTargetKey: 'backend:codex', deps };
      await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target,
        selection: { providerConnectionId: 'pc_missing', modelId: 'model' } })).resolves.toEqual({ ok: false });
      await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target,
        selection: { providerConnectionId: 'pc_gateway', modelId: 'model' } })).resolves.toMatchObject({ ok: true,
          ref: { providerConnectionId: 'pc_gateway', modelId: 'model' } });
      setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: 2, providerConnectionsCatalog: { status: 'loading' } });
      await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target,
        selection: { providerConnectionId: 'pc_missing', modelId: 'model' } })).resolves.toMatchObject({ ok: true });
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
      await runtime.dispose();
    }
  });
  it.each([
    ['an empty native model selection', 'qwen', { modelId: '' }],
    ['a mode for an Agent with no mode surface', 'gemini', { acpSessionModeId: 'plan' }],
    ['a malformed config-option override shape', 'codex', { sessionConfigOptionOverrides: { v: 0 } }],
  ] as const)('rejects %s without reading the Account or acquiring a plugin lease', async (_label, agentId, selection) => {
    const getActiveAccountSettingsSnapshot = vi.fn(() => null);
    const tryAcquireAuthoritativePluginRuntimeRegistryLease = vi.fn(() => {
      throw new Error('a deterministic native rejection must not acquire a runtime lease');
    });

    await expect(resolveCurrentProviderSpawnDefinitiveRejection({
      agentTargetKey: `backend:${agentId}`,
      agentId,
      selection,
      deps: {
        getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshot as never,
        tryAcquireAuthoritativePluginRuntimeRegistryLease:
          tryAcquireAuthoritativePluginRuntimeRegistryLease as never,
      },
    })).resolves.toEqual({ ok: false });

    expect(getActiveAccountSettingsSnapshot).not.toHaveBeenCalled();
    expect(tryAcquireAuthoritativePluginRuntimeRegistryLease).not.toHaveBeenCalled();
  });

  it.each([
    ['the native default model', 'qwen', { modelId: 'default' }],
    ['a dynamic native model that cannot be known locally', 'codex', { modelId: 'future-model' }],
  ] as const)('keeps %s eligible for the ordinary launch owner', async (_label, agentId, selection) => {
    const result = await resolveCurrentProviderSpawnDefinitiveRejection({
      agentTargetKey: `backend:${agentId}`,
      agentId,
      selection,
      deps: {
        getActiveAccountSettingsSnapshot: (() => null) as never,
        tryAcquireAuthoritativePluginRuntimeRegistryLease: (() => null) as never,
      },
    });

    expect(result).toMatchObject({ ok: true });
  });
});
