import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { SpawnOptions } from 'node:child_process';
import { accountSettingsParse, FeaturesResponseSchema, formatSharedSavedSecretRefV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { resolveSessionForkBackendTarget } from '@/session/fork/backendTarget';
import { resolveSessionContinuationTargetAgent } from '@/session/agentTransition/sessionContinuationInspection';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { createConfiguredAcpProbeBackend } from './configuredAcpProbeBackend';
import { resolveConfiguredAcpProbeCacheVariant } from './configuredAcpProbeCacheVariant';
import { probeAgentModelsBestEffort } from './agentModelsProbe';
import { probeAgentModesBestEffort } from './agentModesProbe';
import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';

const { spawnProcess } = vi.hoisted(() => ({
  spawnProcess: vi.fn<(command: string, args: readonly string[], options: SpawnOptions) => never>(() => {
    throw new Error('probe-process-boundary');
  }),
}));
// Capture the native process boundary while exercising real catalog/env/ACP logic.
vi.mock('cross-spawn', async importOriginal => ({
  ...await importOriginal<typeof import('cross-spawn')>(), default: spawnProcess,
}));

const credentials = { token: 'configured-catalog-consumers', encryption: null } as const;
const backendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;
const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
  id: 'review-bot', name: 'review-bot', title: 'Current review bot', command: process.execPath,
  args: ['--version'], env: { REGION: { t: 'literal', v: 'row-region' } }, capabilities: {}, createdAt: 1, updatedAt: 1,
}] });

function publish(catalog: AcpCatalogSnapshotV1, includeRetainedBackend = false) {
  const settings = accountSettingsParse(includeRetainedBackend
    ? { acpCatalogSettingsV1: { v: 2, backends: record.definitions } } : {});
  setActiveAccountSettingsSnapshot({
    source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials), acpCatalog: catalog,
  });
  return settings;
}

// The network is unavailable here; catalog readers and admission logic stay real.
beforeEach(() => {
  spawnProcess.mockClear();
  vi.spyOn(axios, 'get').mockRejectedValue(new Error('Home unreachable'));
});
afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('configured ACP consumers use complete current catalog authority', () => {
  it('probes and hashes a row-backed backend after the Settings root is removed', async () => {
    const settings = publish({ status: 'ready', revision: 4, record });
    const backend = await createConfiguredAcpProbeBackend({ agentId: 'customAcp', backendTarget,
      cwd: process.cwd(), credentials, accountSettings: settings });
    try {
      expect(backend).not.toBeNull();
      await expect(resolveConfiguredAcpProbeCacheVariant({ agentId: 'customAcp', backendTarget,
        accountSettings: settings })).resolves.toMatch(/^configuredAcp:review-bot:[A-Za-z0-9_-]+$/);
    } finally {
      await backend?.dispose();
    }
  });

  it.each<AcpCatalogSnapshotV1>([
    { status: 'loading' }, { status: 'unavailable', reason: 'account-mode-mismatch' },
    { status: 'partial', reason: 'incomplete-inventory', record, diagnostics: [{ path: 'definitions[1]', reason: 'invalid_definition' }] },
  ])('refuses retained Settings fallback while the catalog is $status', async catalog => {
    const settings = publish(catalog, true);
    await expect(createConfiguredAcpProbeBackend({ agentId: 'customAcp', backendTarget,
      cwd: process.cwd(), accountSettings: settings })).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
    await expect(resolveConfiguredAcpProbeCacheVariant({ agentId: 'customAcp', backendTarget,
      accountSettings: settings })).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
    await expect(resolveSessionForkBackendTarget({ credentials, parentMetadata:
      buildConfiguredAcpBackendSessionMetadata({ backendId: 'review-bot', title: 'Old metadata title' })
    })).resolves.toMatchObject({ ok: false });
    await expect(resolveSessionContinuationTargetAgent({ readAgentCatalogSnapshot, agentId: 'acp:review-bot' }))
      .resolves.toBeNull();
  });

  it('requires current membership rather than embedded fork metadata', async () => {
    publish({ status: 'ready', revision: 5, record: { v: 1, definitions: [] } });
    await expect(resolveSessionForkBackendTarget({ credentials, parentMetadata:
      buildConfiguredAcpBackendSessionMetadata({ backendId: 'review-bot', title: 'Old metadata title' })
    })).resolves.toMatchObject({ ok: false });
  });

  it.each([
    { flavor: 'acp:review-bot' },
    buildConfiguredAcpBackendSessionMetadata({ backendId: 'review-bot', title: 'Old metadata title' }),
  ])('resolves a fork from current row membership after root removal (%j)', async parentMetadata => {
    publish({ status: 'ready', revision: 4, record });
    await expect(resolveSessionForkBackendTarget({ credentials, parentMetadata }))
      .resolves.toMatchObject({ ok: true, backendTarget, metadataOverlay: {
        acpConfiguredBackendV1: { backendId: 'review-bot', title: 'Current review bot' },
      } });
  });

  it('refuses a probe using another Account credential against the current facet', async () => {
    const settings = publish({ status: 'ready', revision: 4, record });
    await expect(createConfiguredAcpProbeBackend({ agentId: 'customAcp', backendTarget,
      cwd: process.cwd(), accountSettings: settings, credentials: { token: 'other-account', encryption: null },
    })).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
  });

  it('materializes invocation-owned row-backed SavedSecret resources without an ambient Account', async () => {
    // Shared resources revalidate with the initiating Home before disclosure;
    // model that genuine transport boundary instead of serving stale local data.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      if (!String(input).endsWith('/v1/features/authenticated')) throw new Error('Unexpected Home feature request');
      return new Response(JSON.stringify(FeaturesResponseSchema.parse({
        features: { teams: { enabled: true } }, capabilities: {},
      })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    vi.mocked(axios.get).mockImplementation(async url => {
      if (!String(url).endsWith('/v1/account/saved-secrets/resources/materials')) throw new Error('Unexpected Home materials request');
      return { status: 200, data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
        resourceId: 'probe-resource', encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref: formatSharedSavedSecretRefV1('probe-resource'), source: 'shared_resource', relationship: 'owner',
          name: 'Probe token', kind: 'token', ownerAccountId: 'owner', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'probe-resource', mode: 'plain',
          content: { v: 1, name: 'Probe token', kind: 'token', value: 'private-probe-value' } }),
      }] }) };
    });
    const secretRecord = AcpCatalogRecordV1Schema.parse({ ...record, definitions: record.definitions.map(definition => ({
      ...definition, env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('probe-resource') } },
    })) });
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({
      source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      acpCatalog: { status: 'ready', revision: 4, record: secretRecord },
      savedSecretResources: [{ resourceId: 'probe-resource', ownerAccountId: 'owner', displayName: 'Probe token',
        kind: 'token', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'probe-resource', mode: 'plain',
          content: { v: 1, name: 'Probe token', kind: 'token', value: 'private-probe-value' } }),
      }],
    });
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected the invocation snapshot');
    const context = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: 'http://127.0.0.1:0', isCurrent: async () => true });
    resetActiveAccountSettingsSnapshotForTests();
    const backend = await createConfiguredAcpProbeBackend({ agentId: 'customAcp', backendTarget,
      cwd: process.cwd(), credentials, accountSettings: settings,
      acpCatalogSnapshot: snapshot.acpCatalog, savedSecretOperationContext: context });
    try {
      expect(backend).not.toBeNull();
      if (!backend) throw new Error('Expected the configured probe');
      await expect(backend.startSession()).rejects.toThrow('probe-process-boundary');
      expect(spawnProcess.mock.calls[0]?.[2].env).toMatchObject({ TOKEN: 'private-probe-value' });
    }
    finally { await backend?.dispose(); }
  });

  it('carries invocation catalog custody through public probe cache and backend paths', async () => {
    const settings = publish({ status: 'ready', revision: 4, record });
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected the invocation snapshot');
    // The currentness callback replaces authenticated network admission only.
    const context = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: 'http://127.0.0.1:0', isCurrent: async () => true });
    resetActiveAccountSettingsSnapshotForTests();
    const params = { agentId: 'customAcp' as const, backendTarget, cwd: process.cwd(), credentials,
      accountSettings: settings, acpCatalogSnapshot: snapshot.acpCatalog, savedSecretOperationContext: context };
    await expect(probeAgentModelsBestEffort(params)).resolves.toMatchObject({ source: 'unavailable', availableModels: [] });
    expect(spawnProcess.mock.calls.at(-1)).toMatchObject([process.execPath, ['--version'], { env: { REGION: 'row-region' } }]);
    spawnProcess.mockClear();
    await expect(probeAgentModesBestEffort(params)).resolves.toMatchObject({ source: 'static', availableModes: [] });
    expect(spawnProcess.mock.calls.at(-1)).toMatchObject([process.execPath, ['--version'], { env: { REGION: 'row-region' } }]);
    await expect(probeAgentConfigOptionsBestEffort(params)).resolves.toMatchObject({ source: 'static', configOptions: [] });
  });

});
