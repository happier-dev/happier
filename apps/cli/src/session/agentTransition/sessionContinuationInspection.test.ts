import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, AccountEncryptionCurrentnessResponseSchema, V2SessionRecordSchema } from '@happier-dev/protocol';
import { setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, commitActiveAcpCatalog, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type { StoredCredentials } from '@/persistence';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCustomAcpAdmittedRuntimeFixture } from '@/plugins/testkit/customAcp';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
  readStoredCredentials: vi.fn(),
}));

// Stored credentials are the persistence boundary; configured engine resolution stays real.
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: mocks.readStoredCredentials,
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

const {
  inspectSessionContinuation,
  inspectSessionContinuations,
  resolveSessionContinuationCurrentAgentId,
  resolveSessionContinuationTargetAgent,
} = await import('./sessionContinuationInspection');
const { buildAgentCatalogContribution } = await import('./sessionAgentTransitionTestkit');
// Load real runtime modules during collection, outside per-test execution budgets.
const { readAgentCatalogSnapshot } = await import('@/agent/catalog/snapshot');

/**
 * The inspection answers for THIS exact machine. A Session hosted elsewhere is
 * not transitionable here at all, and the daemon must say so as `unavailable`
 * rather than returning an `available` composite whose support flags would
 * describe a machine the Session does not live on.
 */
const credentials = {
  token: 'token',
  encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
} as unknown as StoredCredentials;

function inspectionDeps(params: Readonly<{ sessionMachineId: string }>) {
  return {
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: true as const,
      rawSession: { id: 'source-session', machineId: params.sessionMachineId },
      accountEncryptionCurrentness: { mode: 'plain' as const, version: 1 },
    })) as never,
    decryptOwnerMetadataView: vi.fn(() => ({
      machineId: params.sessionMachineId,
      flavor: 'codex',
      path: '/work/repo',
    })) as never,
    readAgentCatalogSnapshot: vi.fn(() => ({
      agentDefinitionsById: new Map([
        ['claude', buildAgentCatalogContribution({ id: 'claude' })],
        ['deepsec', buildAgentCatalogContribution({ id: 'deepsec', primary: 'executionRuns' })],
      ]),
    })) as never,
    resolveCurrentProviderSpawnDefinitiveRejection: vi.fn(async () => ({
      ok: true as const,
      ref: null,
    })) as never,
  };
}

describe('sessionContinuationInspection', () => {
  beforeEach(() => {
    mocks.fetchAccountMachineReplacements.mockReset();
    mocks.fetchAccountMachineReplacements.mockResolvedValue([{ id: 'machine-1' }, { id: 'machine-2' }]);
  });

  /**
   * The recorded machine is NOT a gate. Every failure such a gate claimed to
   * prevent is detected by the component that actually knows — the stop owner
   * finds no local process, an absent DEVICE-LOCAL resume record already
   * degrades to a full replay, the cutover is server-side — so refusing here
   * only removed the capability of a user who legitimately moved the Session.
   */
  it('answers for a Session recorded against another machine, without reading the account chain', async () => {
    const inspection = await inspectSessionContinuation({
      credentials,
      request: {
        v: 1,
        sourceSessionId: 'source-session',
        selection: { v: 1, agentId: 'claude' },
      },
      deps: inspectionDeps({ sessionMachineId: 'machine-2' }),
    });

    expect(inspection).toMatchObject({ type: 'available' });
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  /**
   * The mutation's target gate, asked from the inspection. A bundled Agent with
   * an execution-run surface and no `sessions` surface is a real catalog
   * contribution with a real identity, so catalog membership alone reports it
   * switchable — and the client then arms a submission the mutation can only
   * fail after stopping the source. Both entry points read one answer.
   */
  it('loads and decrypts the source Session once for every target in a batch', async () => {
    const deps = inspectionDeps({ sessionMachineId: 'machine-1' });

    await expect(inspectSessionContinuations({
      credentials,
      request: {
        v: 1,
        sourceSessionId: 'source-session',
        selections: [
          { v: 1, agentId: 'claude' },
          { v: 1, agentId: 'deepsec' },
          { v: 1, agentId: 'not-an-agent' },
        ],
      },
      deps,
    })).resolves.toEqual({
      v: 1,
      inspections: [
        { type: 'available', protocolVersion: 1, sameSessionTransition: true },
        { type: 'unavailable', reason: 'target_unavailable' },
        { type: 'unavailable', reason: 'target_unavailable' },
      ],
    });
    expect(deps.resolveSessionTransportContext).toHaveBeenCalledTimes(1);
    expect(deps.decryptOwnerMetadataView).toHaveBeenCalledTimes(1);
  });

  it('rejects an execution-run-only target while retaining a Sessions target', async () => {
    const executionRunOnlyInspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection: { v: 1, agentId: 'deepsec' } },
      deps: inspectionDeps({ sessionMachineId: 'machine-1' }),
    });

    expect(executionRunOnlyInspection).toEqual({ type: 'unavailable', reason: 'target_unavailable' });

    const sessionsInspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection: { v: 1, agentId: 'claude' } },
      deps: inspectionDeps({ sessionMachineId: 'machine-1' }),
    });

    expect(sessionsInspection).toEqual({
      type: 'available',
      protocolVersion: 1,
      sameSessionTransition: true,
    });
  });

  it('rejects a definitely missing Provider selection before advertising the target', async () => {
    const deps = inspectionDeps({ sessionMachineId: 'machine-1' });
    const definitiveRejection = vi.fn(async () => ({ ok: false as const }));
    deps.resolveCurrentProviderSpawnDefinitiveRejection = definitiveRejection as never;
    const selection = {
      v: 1 as const,
      agentId: 'claude',
      modelId: 'model-a',
      providerConnectionId: 'pc_missing',
    };

    const inspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection },
      deps,
    });

    expect(inspection).toEqual({ type: 'unavailable', reason: 'target_unavailable' });
    expect(definitiveRejection).toHaveBeenCalledWith({
      agentTargetKey: 'agent:happier.agent.claude/claude',
      agentId: 'claude',
      selection,
    });
  });
  /**
   * A link that EXISTS but cannot be resolved — a malformed canonical row, or
   * two persisted rows that disagree — is neither `direct` nor `persisted`. The
   * nullable metadata read collapsed it into `null`, which this inspection
   * scored as "hosted here" and reported `available`; the client then armed a
   * transition whose first act is stopping the source runtime. Both unresolved
   * shapes must be refused, and refused BEFORE any target work.
   */
  it.each([
    [
      'malformed canonical link',
      {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
          followStatusV1: { v: 1, status: 'not-a-status', updatedAtMs: 10 },
        },
      },
    ],
    [
      'dual rows requiring reconciliation',
      {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
        },
        directSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-legacy',
          remoteSessionId: 'remote-legacy',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        },
      },
    ],
  ])('never reports a Session hosted when its link is unresolved (%s)', async (_label, link) => {
    const deps = inspectionDeps({ sessionMachineId: 'machine-1' });
    deps.decryptOwnerMetadataView = vi.fn(() => ({
      machineId: 'machine-1',
      flavor: 'codex',
      path: '/work/repo',
      ...link,
    })) as never;

    const inspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection: { v: 1, agentId: 'claude' } },
      deps,
    });

    expect(inspection).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
    expect(deps.resolveCurrentProviderSpawnDefinitiveRejection).not.toHaveBeenCalled();
  });
});


describe('configured continuation target resolution', () => {
  let runtimeFixture: Awaited<ReturnType<typeof createCustomAcpAdmittedRuntimeFixture>> | undefined;

  beforeAll(async () => {
    runtimeFixture = await createCustomAcpAdmittedRuntimeFixture({
      controller: pluginReloadController,
    });
  });

  beforeEach(() => {
    mocks.readStoredCredentials.mockResolvedValue({
      token: 'test-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });
  });

  afterEach(() => {
    clearActiveAccountSettingsSnapshot();
  });

  afterAll(async () => {
    await runtimeFixture?.dispose();
    runtimeFixture = undefined;
  });

  it('projects the canonical Custom ACP instance onto the existing continuation wire selector', () => {
    for (const definitionId of ['target-a', 'target-b']) {
      const metadata = {
        flavor: 'custom-acp',
        runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId } },
        acpConfiguredBackendV1: { v: 1, backendId: definitionId, title: definitionId, updatedAt: 1 },
      };
      expect(resolveSessionContinuationCurrentAgentId(metadata)).toBe(`acp:${definitionId}`);
      expect(resolveSessionContinuationCurrentAgentId({ ...metadata,
        runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId: 'different-definition' } },
      })).toBeNull();
    }
  });

  it('refuses the captured target when its catalog changes during runtime composition', async () => {
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
      id: 'target-a', name: 'target-a', title: 'Before refresh', command: process.execPath,
      args: [], env: {}, capabilities: { supportsLoadSession: true }, createdAt: 1, updatedAt: 1,
    }] });
    const scopeKey = resolveAccountSettingsScopeKey({ token: 'test-token', encryption: null });
    setActiveAccountSettingsSnapshot({
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      acpCatalog: { status: 'ready', revision: 1, record },
    });
    // Credential persistence is the real async boundary. Domain publication and
    // runtime composition remain real, including the replacement ready facet.
    mocks.readStoredCredentials.mockImplementationOnce(async () => {
      commitActiveAcpCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        catalog: { status: 'ready', revision: 2, record: {
          ...record, definitions: record.definitions.map(definition => ({ ...definition, title: 'After refresh' })),
        } },
      });
      return { token: 'test-token', encryption: null };
    });
    try {
      await expect(resolveSessionContinuationTargetAgent({
        readAgentCatalogSnapshot,
        agentId: 'acp:target-a',
      })).resolves.toBeNull();
    } finally {
      clearActiveAccountSettingsSnapshot();
    }
  });

  it('resolves two configurations sharing an executable as distinct exact Session targets', async () => {
    const configuredCatalog = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['target-a', 'target-b'].map(id => ({
      id, name: id, title: id, command: process.execPath, args: [id], env: {},
      capabilities: { supportsLoadSession: true }, createdAt: 1, updatedAt: 1,
    })) });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({
        schemaVersion: 6,
      }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey({ token: 'test-token', encryption: null }),
      acpCatalog: { status: 'ready', revision: 1, record: configuredCatalog },
    });
    try {
      const a = await resolveSessionContinuationTargetAgent({
        readAgentCatalogSnapshot,
        agentId: 'acp:target-a',
      });
      const b = await resolveSessionContinuationTargetAgent({
        readAgentCatalogSnapshot,
        agentId: 'acp:target-b',
      });
      expect(a).toMatchObject({ agentId: 'acp:target-a', backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:target-a' });
      expect(b).toMatchObject({ agentId: 'acp:target-b', backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:target-b' });
      expect(await resolveSessionContinuationTargetAgent({
        readAgentCatalogSnapshot,
        agentId: 'acp:missing',
      })).toBeNull();
      const sourceMetadata = {
        flavor: 'acp:target-a', path: '/work/repo', machineId: 'machine-1',
        acpConfiguredBackendV1: { v: 1, backendId: 'target-a', title: 'target-a', updatedAt: 1 },
      };
      // Parse boundary fixtures before entering transport: a malformed fixture must
      // fail here rather than masquerading as an unavailable source Session.
      const rawSession = V2SessionRecordSchema.parse({ id: 'source-session', machineId: 'machine-1', encryptionMode: 'plain',
        metadata: JSON.stringify(sourceMetadata), metadataVersion: 1, metadataLayoutVersion: 0,
        agentState: null, agentStateVersion: 1, active: false, seq: 1,
        createdAt: 1, updatedAt: 1, activeAt: 1, dataEncryptionKey: null });
      const accountEncryptionCurrentness = AccountEncryptionCurrentnessResponseSchema.parse({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      });
      const inspections = await inspectSessionContinuations({
        credentials,
        request: { v: 1, sourceSessionId: 'source-session', selections: [
          { v: 1, agentId: 'acp:target-a' }, { v: 1, agentId: 'acp:target-b' },
        ] },
        deps: {
          // The network transport is replaced; metadata decryption, exact persisted
          // identity, configured engine, and Provider preflight all stay real.
          resolveSessionTransportContext: async () => ({
            ok: true, sessionId: 'source-session',
            rawSession, accountEncryptionCurrentness, ctx: null, mode: 'plain',
          }),
        },
      });
      expect(inspections.inspections).toEqual([
        { type: 'available', protocolVersion: 1, sameSessionTransition: false },
        { type: 'available', protocolVersion: 1, sameSessionTransition: true },
      ]);
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!snapshot) throw new Error('Expected the configured Account fixture');
      setActiveAccountSettingsSnapshot({
        ...snapshot, settingsVersion: 2,
        settings: accountSettingsParse({ ...snapshot.settings,
          backendEnabledByTargetKey: { 'backend:target-b:configured:target-b': false },
        }),
      });
      expect(await resolveSessionContinuationTargetAgent({
        readAgentCatalogSnapshot,
        agentId: 'acp:target-b',
      })).toBeNull();
    } finally {
      clearActiveAccountSettingsSnapshot();
    }
  });

  it.each<AcpCatalogSnapshotV1>([
    { status: 'loading' }, { status: 'unavailable', reason: 'account-mode-mismatch' },
    { status: 'partial', reason: 'incomplete-inventory', record: { v: 1, definitions: [] }, diagnostics: [] },
  ])('refuses a configured continuation before runtime composition when the catalog is $status', async catalog => {
    setActiveAccountSettingsSnapshot({
      source: 'network', settings: accountSettingsParse({ acpCatalogSettingsV1: { v: 2, backends: [{
        id: 'target-a', name: 'target-a', title: 'target-a', command: process.execPath,
        args: [], env: {}, capabilities: {}, createdAt: 1, updatedAt: 1,
      }] } }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey({ token: 'test-token', encryption: null }), acpCatalog: catalog,
    });
    try {
      expect(await resolveSessionContinuationTargetAgent({
        readAgentCatalogSnapshot,
        agentId: 'acp:target-a',
      })).toBeNull();
    } finally {
      clearActiveAccountSettingsSnapshot();
    }
  });
});
