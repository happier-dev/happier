import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { configuration } from '@/configuration';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
  composeProviderSettingsV1, ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ACCOUNT_SECURITY_PATH_V1 } from '@happier-dev/protocol/auth/accountSecurity';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { decodeStoredCredentials } from '@/persistence';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createCliProviderActionExecuteV1 } from './createCliProviderActionDeps';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createCurrentSessionProjectionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';

describe('Provider default preference Action at its Account Settings boundary', () => {
  const originalRequirement = configuration.clientEncryptionRequirement;
  const originalActiveServerDir = configuration.activeServerDir;
  let directory: string | undefined;
  it.each(['owner', 'missing'] as const)('reads the %s Session binding through authenticated MCP Action dispatch', async scenario => {
    const credentials = { token: 'binding-reader-token', encryption: null };
    const launchBinding = { v: 1, connectionId: 'pc_work', contributionKey: null, connectionRevision: 3,
      protocol: 'openai-responses', materialization: 'engineConfig', compatibilityFingerprint: 'compatible',
      bindingSecurityFingerprint: 'old-cli-binding', displaySnapshot: { providerName: 'Provider', connectionName: 'Work',
        connectionRole: 'named', connectionDisplayNameMode: 'custom' } } as const;
    const selection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 5,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_work', modelId: 'model-a' } }).ref;
    const metadata = { ...createTestMetadata({ machineId: 'machine-a' }), providerBindingV1: launchBinding,
      modelSelectionIntentV1: { v: 1, updatedAt: 5, selection } };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Expected valid owner metadata fixture');
    const session = createCurrentSessionProjectionRecordFixture({ id: 'binding-session', encryptionMode: 'plain',
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })), metadataLayoutVersion: 1, share: null,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions/binding-session') return scenario === 'missing'
        ? { status: 404, data: { error: 'Session not found' } } : { status: 200, data: V2SessionByIdResponseSchema.parse({ session }) };
      throw new Error(`Unexpected binding Action HTTP read: ${path}`);
    });
    const paired: unknown[] = [];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      providerActionExecute: createCliProviderActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        callMachineAction: async input => { paired.push(input.request);
          return { status: 'changed', nextBindingSecurityFingerprint: 'new-cli-binding' }; } }),
    });
    const result = await executor.execute('providers.binding.status', { machineId: 'machine-a', sessionId: session.id },
      { surface: 'mcp', authority: 'account_automation', serverId: 'home' });
    if (scenario === 'owner') {
      expect(result).toEqual({ ok: true, result: { status: 'changed', nextBindingSecurityFingerprint: 'new-cli-binding',
        providerBindingSecurityChangeConfirmationV1: { v: 1, sessionId: session.id, connectionId: 'pc_work',
          previousBindingSecurityFingerprint: 'old-cli-binding', nextBindingSecurityFingerprint: 'new-cli-binding' } } });
      expect(paired).toEqual([{ machineId: 'machine-a', agentTargetKey: selection.agentTargetKey,
        selection: { v: 1, updatedAt: 5, ref: selection }, launchBinding }]);
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
      expect(paired).toEqual([]);
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetInMemoryAccountSettingsContextForTests();
    Object.assign(configuration, { clientEncryptionRequirement: originalRequirement, activeServerDir: originalActiveServerDir });
    if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined; }
  });

  it('lets the projection owner settle a slow source as a typed partial result rather than a transport timeout', async () => {
    const failure = createProviderErrorV1('provider_endpoint_unavailable', { machineId: 'machine-a', connectionId: 'slow' });
    // Machine RPC is the system boundary. Its default acknowledgement cutoff
    // competes with the Provider's containing operation budget unless withdrawn.
    const execute = createCliProviderActionExecuteV1({
      credentials: { token: 'projection-account', encryption: null }, serverId: 'provider-home',
      serverHttpBaseUrl: 'https://provider-projection.test',
      callMachineAction: async input => {
        if (!('timeoutMs' in input) || input.timeoutMs !== null) {
          throw Object.assign(new Error('Machine RPC acknowledgement timed out'), { code: 'MACHINE_RPC_TIMEOUT' });
        }
        return { status: 'success', agentTargetKey: 'agent:happier.agent.claude/claude', groups: [],
          refreshFailures: [{ connectionId: 'slow', error: failure }] };
      },
    });
    await expect(execute({ actionId: 'providers.models.projection', input: {
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.claude/claude',
    } }, { surface: 'cli', serverId: 'provider-home' })).resolves.toMatchObject({ ok: true, result: {
      status: 'success', refreshFailures: [{ connectionId: 'slow', error: failure }],
    } });
  });

  it.each([
    ...(['present', 'absent', 'retired', 'conflict', 'unknown', 'invalid-ack', 'ack-after-retirement'] as const)
      .map(scenario => ({ scenario, surface: 'cli' as const })),
    { scenario: 'present' as const, surface: 'mcp' as const },
  ])('executes standalone source visibility through the public frontend: $scenario / $surface', async ({ scenario, surface }) => {
    directory = await mkdtemp(join(tmpdir(), 'happier-provider-action-'));
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    Object.assign(configuration, { clientEncryptionRequirement: 'follow_account', activeServerDir: directory });
    resetInMemoryAccountSettingsContextForTests();
    expect(getActiveAccountSettingsSnapshot()).toBeNull();
    const serverUrl = 'https://provider-visibility.test';
    // The HTTP boundary owns signature verification. Feed the real client
    // readers canonical Account claims and the incumbent stored-credential codec.
    const provenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' });
    const accountToken = (sub: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, provenance })).toString('base64url')}.http-fixture`;
    const token = accountToken('provider-account');
    const credentials = decodeStoredCredentials({ token });
    const replacementCredentials = decodeStoredCredentials({ token: accountToken('replacement-account') });
    if (!credentials || !replacementCredentials) throw new Error('Canonical stored Account credential fixture was rejected');
    let currentCredentials = credentials;
    const replacementSnapshot = { source: 'network' as const, settings: accountSettingsParse({ untouchedB: true }),
      rawSettings: { untouchedB: true }, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(replacementCredentials) };
    const catalog = ProviderConnectionsCatalogV1Schema.parse({
      ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: ['pc_a', 'pc_b'].map(id => ({ v: 1, id,
        source: { kind: 'contribution', contributionKey: id === 'pc_a' ? 'plugin/p' : 'plugin/q' }, role: 'default',
        displayName: id, displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 })),
      manualModelsByConnectionId: { pc_a: [{ id: 'owned-model', addedAt: 1 }] },
      modelPickerVisibilityByConnectionId: { pc_b: true },
    });
    // A genuine retained source makes an accidental transfer loader observable:
    // absence must not initialize even this valid source into a destination row.
    const source = scenario === 'absent'
      ? { untouched: true, providerSettingsV1: composeProviderSettingsV1(catalog, {}) }
      : { untouched: true };
    const originalSource = structuredClone(source);
    // Only HTTP is replaced. The public frontend, policy/bootstrap, Provider
    // executor, domain mutation, row opener and captured CAS remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(new URL(String(url)).origin).toBe(serverUrl);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      const path = new URL(String(url)).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: {} };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: source } } };
      if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
        if (scenario === 'retired') currentCredentials = replacementCredentials;
        return { status: 200, data: scenario === 'absent'
          ? { status: 'absent' } : { status: 'present', revision: 7, content: { t: 'plain', v: catalog } } };
      }
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const history = emptyAccountSettingsHistoryCaptureResponse(path);
      if (history) return history;
      throw new Error(`Unexpected Provider frontend HTTP read: ${path}`);
    });
    const submitted: unknown[] = [];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      expect(new URL(String(url)).origin).toBe(serverUrl);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      expect(new URL(String(url)).pathname).toBe(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1);
      submitted.push(ProviderConnectionsRowMutationV1Schema.parse(body));
      if (scenario === 'conflict') return { status: 409, data: { status: 'conflict', revision: 8 } };
      if (scenario === 'unknown') throw Object.assign(new Error('Issued Provider CAS lost its acknowledgement'), { code: 'ECONNRESET' });
      if (scenario === 'invalid-ack') return { status: 200, data: { status: 'applied' } };
      if (scenario === 'ack-after-retirement') {
        currentCredentials = replacementCredentials;
        setActiveAccountSettingsSnapshot(replacementSnapshot);
      }
      return { status: 200, data: { status: 'updated', revision: 8, cursor: 8 } };
    });
    const executor = createCliActionExecutorFromCredentials({ credentials,
      serverId: 'provider-home', serverApiUrl: serverUrl, serverIdentityId: 'provider-home-identity',
      readCredentials: async () => currentCredentials,
    });
    const result = await executor.execute('providers.models.source_visibility.set',
      { action: 'setConnectionVisibility', connectionId: 'pc_a', shown: false },
      { surface, serverId: 'provider-home', actionCaller: { kind: 'host' } });
    expect(source).toEqual(originalSource);
    if (scenario === 'ack-after-retirement') expect(getActiveAccountSettingsSnapshot()).toEqual(replacementSnapshot);
    if (scenario === 'absent') {
      expect(result).toEqual({ ok: false, errorCode: 'provider_catalog_unavailable', error: 'provider_catalog_unavailable',
        details: { status: 'unavailable', reason: 'authority-not-confirmed' } });
      expect(post).not.toHaveBeenCalled();
      return;
    }
    if (scenario === 'retired') {
      expect(result).toEqual({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
      expect(post).not.toHaveBeenCalled();
      return;
    }
    expect(result).toEqual(scenario === 'conflict'
      ? { ok: false, errorCode: 'provider_catalog_conflict', error: 'provider_catalog_conflict',
        details: { status: 'conflict', revision: 8 } }
      : scenario === 'unknown' || scenario === 'invalid-ack'
      ? { ok: false, errorCode: 'provider_catalog_outcome_unknown', error: 'provider_catalog_outcome_unknown',
        details: { status: 'outcome_unknown' } }
      : { ok: true, result: { status: 'updated' } });
    expect(submitted).toEqual([{ expectedRevision: 7,
      content: { t: 'plain', v: { ...catalog, modelPickerVisibilityByConnectionId: { pc_b: true, pc_a: false } } },
      referencedSavedSecretIds: [], savedSecretRevisions: [],
    }]);
  });

  it('preserves a dispatched one-shot preference write with unknown outcome, without resubmitting it', async () => {
    const serverUrl = 'https://provider-default.test';
    Object.assign(configuration, { clientEncryptionRequirement: 'follow_account' });
    // Only HTTP is replaced. The Provider setter, pure preference transform,
    // Account opener, one-shot CAS and Action execution all remain real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      expect(new URL(String(input)).origin).toBe(serverUrl);
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: { untouched: true } }, version: 7 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected preference read: ${path}`);
    });
    const submitted: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).origin).toBe(serverUrl);
      expect(new URL(String(input)).pathname).toBe('/v2/account/settings');
      const request = AccountSettingsV2UpdateRequestSchema.parse(body);
      submitted.push(request);
      throw Object.assign(new Error('Dispatched request lost its acknowledgement'), { code: 'ECONNRESET' });
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      providerActionExecute: createCliProviderActionExecuteV1({ credentials: { token: 'provider-default-token', encryption: null },
        serverId: 'provider-home', serverHttpBaseUrl: serverUrl,
        callMachineAction: async () => { throw new Error('Default preference must not consult a daemon'); },
      }),
    });
    const selection = SessionModelSelectionV1Schema.parse({ v: 1,
      ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'unavailable', modelId: 'model' }, updatedAt: 1 });
    const result = await executor.execute('providers.defaults.set', { agentTargetKey: 'agent:codex', selection },
      { surface: 'cli', authority: 'present_user', serverId: 'provider-home', actionCaller: { kind: 'host' } });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ expectedVersion: 7,
      content: { t: 'plain', v: { untouched: true, providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:codex': selection } } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'account_settings_mutation_outcome_unknown',
      details: { status: 'outcomeUnknown', lastKnownVersion: 7 } });
  });
});
