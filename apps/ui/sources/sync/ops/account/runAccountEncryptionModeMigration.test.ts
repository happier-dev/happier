import { describe, expect, it, vi } from 'vitest';
import type {
  AccountEncryptionMigrateRequest,
  AccountEncryptionMigrateSuccessResponse,
} from '@happier-dev/protocol';

import { runAccountEncryptionModeMigration } from './runAccountEncryptionModeMigration';
import { ProjectOpenDraftDocumentV2Schema } from '@happier-dev/protocol/projects/openProjectDraftV1';
import { openWorkspaceExecutionConfigContentV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, buildWorkspaceExecutionConfigRowIdV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { settingsParse } from '@/sync/domains/settings/settings';
import { fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates } from './fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates';
import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';
import { buildAccountEncryptionMigrateToPlainRequest } from './buildAccountEncryptionMigrateToPlainRequest';
import { fetchAccountEncryptionAcpCatalogMigrationCandidate } from './fetchAccountEncryptionAcpCatalogMigrationCandidate';
import { fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates } from './fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

const address = {
  kind: 'newSession' as const,
  draftId: '00000000-0000-4000-8000-000000000301',
};
const document = {
  v: 1 as const,
  composer: {
    text: { mutationId: '00000000-0000-4000-8000-000000000302', value: 'draft' },
    mentions: { mutationId: '00000000-0000-4000-8000-000000000303', value: [] },
    attachments: { mutationId: '00000000-0000-4000-8000-000000000304', value: [] },
  },
  target: { kind: 'newSession' as const, authoring: {} },
  extensions: {},
};
const request = {
  toMode: 'plain' as const,
  expectedAccountVersion: 1,
  expectedSigningKeyFingerprint: 'signing-key',
  expectedContentKeyFingerprint: 'content-key',
  expectedSettingsVersion: 1,
  settingsContent: { t: 'plain' as const, v: {} },
  connectedServices: { action: 'assert_empty' as const },
  automations: { action: 'assert_empty' as const },
  machines: { action: 'assert_empty' as const },
  todos: { action: 'assert_empty' as const },
  artifacts: { action: 'assert_empty' as const },
  sessions: { action: 'assert_empty' as const },
  reviewComments: { action: 'assert_empty' as const },
  sessionOrganization: { action: 'assert_empty' as const },
  pets: { action: 'assert_empty' as const },
  sessionDrafts: {
    items: [{
      address,
      expectedRevision: 5,
      content: { t: 'plain' as const, v: { v: 1 as const, address, document } },
    }],
  },
} satisfies AccountEncryptionMigrateRequest;
const migratedRecord = {
  address,
  revision: 6,
  content: request.sessionDrafts.items[0].content,
  createdAt: 1,
  updatedAt: 2,
};

function success(
  overrides: Partial<AccountEncryptionMigrateSuccessResponse> = {},
): AccountEncryptionMigrateSuccessResponse {
  return {
    success: true,
    mode: 'plain',
    accountVersion: 2,
    settingsVersion: 2,
    ...overrides,
  };
}

describe('runAccountEncryptionModeMigration', () => {
  it('captures original Connected conversion rows without Account keys and retains tombstone authority', async () => {
    const payload = { key: 'configurations', retainedWrapper: { color: 'blue' }, value: { v: 1,
      entries: [{ service: { pluginId: 'happier.connected-account.example', localId: 'cloud' }, modeId: 'native-api',
        revision: 'config-1', values: { region: 'west' }, secretRefs: {} }], retainedCatalog: { color: 'green' } } };
    const content = { t: 'plain', v: payload, retainedEnvelope: { color: 'orange' } };
    const captured = await fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates({ credentials: { token: 'plain-only' },
      mode: 'plain', request: async path => {
        if (path === '/v1/account/entity-rows/connected-accounts/configurations') return Response.json({ status: 'present', revision: 7, content });
        if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Response.json({ status: 'deleted', revision: 9 });
        throw new Error('Unexpected captured Home route');
      },
    });
    expect(captured).toEqual({ connectedConfigurations: { revision: 7, migrationSource: { content, payload } },
      connectedPurposes: { revision: 9, migrationSource: null } });
  });
  it.each(['partial', 'future', 'mode-mismatch', 'forbidden', 'retired'] as const)(
    'refuses %s Connected conversion census instead of treating it as absent', async failure => {
      let current = true;
      const payload = { key: 'configurations', value: { v: failure === 'future' ? 2 : 1, entries: [] } };
      const content = failure === 'mode-mismatch' ? { t: 'encrypted', c: 'wrong-account-mode' }
        : { t: 'plain', v: payload, ...(failure === 'partial' ? { futureSecretId: formatSharedSavedSecretRefV1('future-resource') } : {}) };
      await expect(fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates({ credentials: { token: 'plain-only' }, mode: 'plain',
        assertCurrent: () => { if (!current) throw new Error('scope-retired'); },
        request: async path => {
          if (path.endsWith('/purposes')) return Response.json({ status: 'absent' });
          if (failure === 'forbidden') return Response.json({}, { status: 403 });
          const response = Response.json({ status: 'present', revision: 7, content });
          const consume = response.json.bind(response);
          response.json = async () => { const row: unknown = await consume(); if (failure === 'retired') current = false; return row; };
          return response;
        },
      })).rejects.toThrow();
    },
  );
  it.each([
    ['connectedConfigurations', { key: 'configurations', value: { v: 1, entries: [] } }],
    ['connectedPurposes', { key: 'purposes', value: { v: 1, bindings: [], teamResourceSelections: [] } }],
  ] as const)('requires the exact Connected private-row acknowledgement before adopting Account mode (%s)', async (key, record) => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: record };
    const withCatalog = { ...withoutDrafts, [key]: { expectedRevision: 7, content } };
    const activateTargetMode = vi.fn();
    for (const row of [undefined, null, { revision: 7, content }, { revision: 8, content: null },
      { revision: 8, content: { t: 'encrypted' as const, c: 'wrong-mode' } }]) {
      await expect(runAccountEncryptionModeMigration({ request: withCatalog,
        migrate: async () => ({ ...success(), ...(row === undefined ? {} : { [key]: { row } }) }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow();
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await runAccountEncryptionModeMigration({ request: withCatalog,
      migrate: async () => ({ ...success(), [key]: { row: { revision: 8, content } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    });
    expect(activateTargetMode).toHaveBeenCalledOnce();
    const tombstone = { ...withoutDrafts, [key]: { expectedRevision: 7, content: null } };
    await expect(runAccountEncryptionModeMigration({ request: tombstone,
      migrate: async () => ({ ...success(), [key]: { row: { revision: 8, content: null } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).rejects.toThrow();
    await runAccountEncryptionModeMigration({ request: tombstone,
      migrate: async () => ({ ...success(), [key]: { row: { revision: 7, content: null } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    });
  });
  it('refuses missing, stale or changed Provider catalog acknowledgements before activating the Account mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: { v: 1 as const, connections: [], connectionTombstones: [],
      accountGrants: [], machineGrants: [], secretBindingsByConnectionId: {}, manualModelsByConnectionId: {},
      modelVisibilityByRef: {}, experimentalBindingConfirmations: [] } };
    const providerRequest = { ...withoutDrafts, providerConnections: { expectedRevision: 7, content } };
    const activateTargetMode = vi.fn();
    for (const providerConnections of [undefined, { row: null }, { row: { revision: 7, content } },
      { row: { revision: 8, content: null } },
      { row: { revision: 8, content: { ...content, v: { ...content.v, connectionTombstones: [{ v: 1 as const, id: 'deleted',
        contributionKey: null, lastDisplayName: 'Deleted', deletedAt: 1 }] } } } }]) {
      await expect(runAccountEncryptionModeMigration({ request: providerRequest,
        migrate: async () => ({ ...success(), ...(providerConnections ? { providerConnections } : {}) }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow('Provider catalog migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await runAccountEncryptionModeMigration({ request: providerRequest,
      migrate: async () => ({ ...success(), providerConnections: { row: { revision: 8, content } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    });
    expect(activateTargetMode).toHaveBeenCalledOnce();
  });
  it.each([
    ['mcpServerCatalog', { v: 1, servers: [], bindings: [] }],
    ['remoteHosts', { v: 1, hosts: [] }],
    ['notificationChannels', { v: 1, channels: [] }],
    ['connectedPresentation', { v: 1, entries: [] }],
    ['connectedAcknowledgements', { v: 1, entries: [] }],
  ] as const)('requires exact singleton catalog acknowledgement before adopting the target mode, including retained tombstones (%s)', async (key, value) => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
      const content = { t: 'plain' as const, v: value };
      const withCatalog = { ...withoutDrafts, [key]: { expectedRevision: 7, content } };
      const activateTargetMode = vi.fn();
      const row = { revision: 8, content };
      for (const response of [undefined, { ...row, revision: 7 }, { ...row, content: null },
        { ...row, content: { t: 'encrypted', c: 'wrong-mode' } }]) {
        await expect(runAccountEncryptionModeMigration({ request: withCatalog,
          migrate: async () => ({ ...success(), ...(response ? { [key]: response } : {}) }),
          activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
        })).rejects.toThrow();
      }
      expect(activateTargetMode).not.toHaveBeenCalled();
      await runAccountEncryptionModeMigration({ request: withCatalog,
        migrate: async () => ({ ...success(), [key]: row }), activateTargetMode, acknowledgeSessionDrafts: vi.fn() });
      expect(activateTargetMode).toHaveBeenCalledOnce();
      const withTombstone = { ...withoutDrafts, [key]: { expectedRevision: 7, content: null } };
      await expect(runAccountEncryptionModeMigration({ request: withTombstone,
        migrate: async () => ({ ...success(), [key]: { revision: 8, content: null } }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn() })).rejects.toThrow();
      await runAccountEncryptionModeMigration({ request: withTombstone,
        migrate: async () => ({ ...success(), [key]: { revision: 7, content: null } }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn() });
  });
  it.each(['remoteHosts', 'notificationChannels', 'connectedPresentation', 'connectedAcknowledgements'] as const)(
    'refuses an unsolicited %s catalog acknowledgement before adopting the target mode', async key => {
      const { sessionDrafts: _drafts, ...withoutDrafts } = request;
      const activateTargetMode = vi.fn();
      await expect(runAccountEncryptionModeMigration({ request: withoutDrafts,
        migrate: async () => ({ ...success(), [key]: { revision: 7, content: null } }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow();
      expect(activateTargetMode).not.toHaveBeenCalled();
    },
  );

  it('carries populated finite and service settings through the actual census, both request builders and exact conversion acknowledgements', async () => {
    const rowId = buildWorkspaceExecutionConfigRowIdV1({ serverId: 'home', refId: 'checkout' });
    const value = { enabled: true as const, destination: { kind: 'machine' as const, machineId: 'worker-a' },
      unavailable: 'ask' as const, allowAdHoc: true, scriptOverrides: { build: 'workers' as const }, services: {
        web: { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'worker-b' } }, unavailable: 'fail' as const },
        api: { runsOn: { kind: 'primary' as const }, unavailable: 'primary' as const },
      } };
    const credentials = { token: 'account-token', secret: Buffer.from(new Uint8Array(32).fill(17)).toString('base64url') };
    const census = (rows: unknown[]) => async (path: string) => {
      expect(path).toBe(WORKSPACE_EXECUTION_CONFIG_ROUTE_V1);
      return Response.json({ rows });
    };
    const candidates = await fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates({
      credentials: { token: credentials.token }, mode: 'plain',
      request: census([{ rowId, revision: 7, content: { t: 'plain', v: value } }, { rowId: 'b'.repeat(64), revision: 3, content: null }]),
    });
    expect(candidates).toEqual([{ rowId, revision: 7, value }]);
    const storageDirectives = { machines: request.machines, todos: request.todos, artifacts: request.artifacts,
      sessions: request.sessions, reviewComments: request.reviewComments, sessionOrganization: request.sessionOrganization, pets: request.pets };
    const common = { expectedAccountVersion: 1, expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 1, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [], storageDirectives };
    const encryptedRequest = await buildAccountEncryptionMigrateToE2eeRequest({
      ...common, accountId: 'owner', credentials, workspaceExecutionConfig: candidates,
      keyProof: { v: 1, publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
        contentPublicKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
        contentPublicKeySig: 'content-signature', sign: () => 'request-signature' },
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    });
    const encryptedItem = encryptedRequest.workspaceExecutionConfig!.items[0]!;
    expect(encryptedItem.content.t).toBe('encrypted');
    expect(openWorkspaceExecutionConfigContentV1({ rowId, mode: 'e2ee',
      material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), content: encryptedItem.content })).toEqual(value);
    const encryptedRow = { rowId, revision: 8, content: encryptedItem.content };
    const activateTargetMode = vi.fn();
    await runAccountEncryptionModeMigration({ request: encryptedRequest,
      migrate: async () => success({ mode: 'e2ee', workspaceExecutionConfig: { rows: [encryptedRow] } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn() });
    const opened = await fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates({ credentials, mode: 'e2ee', request: census([encryptedRow]) });
    const plainRequest = await buildAccountEncryptionMigrateToPlainRequest({ ...common,
      expectedSigningKeyFingerprint: 'signing-key', expectedContentKeyFingerprint: 'content-key',
      credentials: { token: credentials.token }, workspaceExecutionConfig: opened,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    expect(plainRequest.workspaceExecutionConfig).toEqual({ items: [{ rowId, expectedRevision: 8, content: { t: 'plain', v: value } }] });
    await runAccountEncryptionModeMigration({ request: plainRequest,
      migrate: async () => success({ workspaceExecutionConfig: { rows: [{ rowId, revision: 9, content: { t: 'plain', v: value } }] } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn() });
    expect(activateTargetMode).toHaveBeenCalledTimes(2);
  });

  it('refuses unavailable, partial or unopenable workspace census before it can become an empty conversion participant', async () => {
    const params = { credentials: { token: 'account-token' }, mode: 'plain' as const };
    for (const body of [{ complete: false, rows: [] }, { rows: [{ rowId: 'a'.repeat(64), revision: 1, content: { t: 'encrypted', c: 'opaque' } }] }]) {
      await expect(fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates({ ...params,
        request: async () => Response.json(body) })).rejects.toThrow();
    }
    await expect(fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates({ ...params,
      request: async () => new Response(null, { status: 503 }) })).rejects.toThrow();
    await expect(fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates({ ...params, mode: 'e2ee',
      request: async () => Response.json({ rows: [] }) })).rejects.toThrow();
  });
  it('adopts a retained Open draft only with exact Account conversion coverage', async () => {
    const address = { kind: 'projectOpen' as const, draftId: '00000000-0000-4000-8000-000000000301' };
    const field = (value: unknown) => ({ mutationId: '00000000-0000-4000-8000-000000000302', value });
    const document = ProjectOpenDraftDocumentV2Schema.parse({ v: 2, target: { kind: 'projectOpen' }, selection: field({ serverId: 'home' }),
      uncertainInputs: field([]), result: field(null), retiredAttempt: field(null) });
    const content = { t: 'plain' as const, v: { v: 2 as const, address, document } };
    const withOpen: AccountEncryptionMigrateRequest = { ...request, sessionDrafts: { v: 2, items: [{ address, expectedRevision: 5, content }] } };
    const record = { address, revision: 6, content, createdAt: 1, updatedAt: 2 };
    const acknowledged: unknown[] = [];
    await expect(runAccountEncryptionModeMigration({ request: withOpen,
      migrate: async () => success({ sessionDrafts: { v: 2, records: [record] } }), activateTargetMode: () => {},
      acknowledgeSessionDrafts: records => { acknowledged.push(...records); } })).resolves.toMatchObject({ mode: 'plain' });
    expect(acknowledged).toEqual([record]);
  });
  it('requires exact prompt catalog coverage before adopting the target mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: { key: 'role-overrides' as const,
      value: { v: 1 as const, overrides: { reviewer: { roleId: 'reviewer', workspaceWrites: 'deny' as const } } } } };
    const withCatalog = { ...withoutDrafts, promptLibrary: { items: [{ key: 'role-overrides' as const, expectedRevision: 7, content }] } };
    const activateTargetMode = vi.fn();
    const row = { key: 'role-overrides' as const, revision: 8, content };
    for (const rows of [undefined, [], [{ ...row, revision: 7 }], [{ ...row, content: null }], [row, row],
      [{ ...row, content: { ...content, v: { ...content.v, value: { ...content.v.value, overrides: {} } } } }]]) {
      await expect(runAccountEncryptionModeMigration({ request: withCatalog,
        migrate: async () => success(rows ? { promptLibrary: { rows } } : {}), activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow('Prompt catalog migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({ request: withCatalog,
      migrate: async () => success({ promptLibrary: { rows: [row] } }), activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
  });
  it('requires exact ACP catalog coverage before adopting the target mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: { v: 1 as const, definitions: [] } };
    const withCatalog = { ...withoutDrafts, acpCatalog: { expectedRevision: 7, content } };
    const activateTargetMode = vi.fn();
    const row = { revision: 8, content };
    for (const resultRow of [undefined, null, { ...row, revision: 7 }, { ...row, content: null },
      { ...row, content: { t: 'encrypted' as const, c: 'wrong-content' } }]) {
      await expect(runAccountEncryptionModeMigration({ request: withCatalog,
        migrate: async () => success(resultRow === undefined ? {} : { acpCatalog: { row: resultRow } }), activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow('ACP catalog migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({ request: withCatalog,
      migrate: async () => success({ acpCatalog: { row } }), activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
    const withTombstone = { ...withoutDrafts, acpCatalog: { expectedRevision: 7, content: null } };
    await expect(runAccountEncryptionModeMigration({ request: withTombstone,
      migrate: async () => success({ acpCatalog: { row: { revision: 8, content: null } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).rejects.toThrow('ACP catalog migration response');
    await expect(runAccountEncryptionModeMigration({ request: withTombstone,
      migrate: async () => success({ acpCatalog: { row: { revision: 7, content: null } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
  });
  it('captures exact ACP inventory without keys for Plain and refuses partial or unavailable census', async () => {
    const params = { credentials: { token: 'account-token' }, mode: 'plain' as const, assertCurrent: () => {} };
    const record = { v: 1, definitions: [] };
    const payload = { ...record, catalogMetadata: { label: 'Retained catalog' } };
    const content = { t: 'plain', v: payload, envelopeMetadata: { note: 'Retained envelope' } };
    expect(await fetchAccountEncryptionAcpCatalogMigrationCandidate({ ...params,
      request: async () => Response.json({ status: 'present', revision: 4, content }) }))
      .toEqual({ revision: 4, record, migrationSource: { content, payload } });
    expect(await fetchAccountEncryptionAcpCatalogMigrationCandidate({ ...params,
      request: async () => Response.json({ status: 'deleted', revision: 7 }) })).toEqual({ revision: 7, record: null });
    expect(await fetchAccountEncryptionAcpCatalogMigrationCandidate({ ...params,
      request: async () => Response.json({ status: 'absent' }) })).toBeUndefined();
    for (const body of [{ status: 'account-mode-mismatch' }, { status: 'present', revision: 4,
      content: { t: 'plain', v: { ...record, extension: { futureCredential: { t: 'savedSecret', secretId: 'unclassified' } } } } }]) {
      await expect(fetchAccountEncryptionAcpCatalogMigrationCandidate({ ...params,
        request: async () => Response.json(body) })).rejects.toThrow('ACP catalog migration census');
    }
    await expect(fetchAccountEncryptionAcpCatalogMigrationCandidate({ ...params,
      request: async () => new Response(null, { status: 503 }) })).rejects.toThrow();
  });
  it('requires exact Profile coverage and the unchanged reference tombstone before adopting the target mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: {
      v: 1 as const, id: 'profile-a', definition: { kind: 'artifact' as const, artifactId: 'artifact-a' },
      enabled: true, promptStack: [], secretBindings: {},
    } };
    const withProfiles = { ...withoutDrafts, profileRows: {
      items: [{ id: 'profile-a', expectedRevision: 7, content }], expectedReferenceGuardRevision: 11,
      transferControl: { expectedRevision: 'absent' as const, content: null },
    } };
    const activateTargetMode = vi.fn();
    const validRow = { id: 'profile-a', revision: 8, content };
    const invalid = [
      undefined,
      { rows: [], referenceGuardRevision: 11 },
      { rows: [{ ...validRow, revision: 7 }], referenceGuardRevision: 11 },
      { rows: [{ ...validRow, content: null }], referenceGuardRevision: 11 },
      { rows: [{ ...validRow, id: 'other-profile' }], referenceGuardRevision: 11 },
      { rows: [validRow, validRow], referenceGuardRevision: 11 },
      { rows: [validRow], referenceGuardRevision: 12 },
    ];
    for (const profileRows of invalid) {
      await expect(runAccountEncryptionModeMigration({
        request: withProfiles,
        migrate: async () => ({ ...success(), ...(profileRows ? { profileRows: { ...profileRows, transferControl: { status: 'absent' as const } } } : {}) }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow('Profile row migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({
      request: withProfiles,
      migrate: async () => ({ ...success(), profileRows: { rows: [validRow], referenceGuardRevision: 11, transferControl: { status: 'absent' } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
    expect(activateTargetMode).toHaveBeenCalledOnce();
  });

  it('verifies a Profile reference guard even when all Profile entities are tombstones', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const withProfiles = { ...withoutDrafts, profileRows: { items: [], expectedReferenceGuardRevision: 11,
      transferControl: { expectedRevision: 'absent' as const, content: null } } };
    const activateTargetMode = vi.fn();
    await expect(runAccountEncryptionModeMigration({
      request: withProfiles, migrate: async () => success(), activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).rejects.toThrow('Profile row migration response');
    expect(activateTargetMode).not.toHaveBeenCalled();
  });

  it('validates the genuine Profile transfer control revision and envelope before adoption', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: { v: 1 as const, phase: 'prepared' as const,
      sourceSettingsVersion: 3, migratedLogicalRevision: 7, inventory: [],
    } };
    const withProfiles = { ...withoutDrafts, profileRows: { items: [], expectedReferenceGuardRevision: 11,
      transferControl: { expectedRevision: 3, content } } };
    const activateTargetMode = vi.fn();
    const valid = { status: 'present' as const, revision: 4, content };
    for (const transferControl of [
      { status: 'absent' as const }, { status: 'deleted' as const, revision: 3 }, { ...valid, revision: 3 },
      { ...valid, content: { t: 'plain' as const, v: { ...content.v, migratedLogicalRevision: 8 } } },
    ]) {
      await expect(runAccountEncryptionModeMigration({ request: withProfiles,
        migrate: async () => success({ profileRows: { rows: [], referenceGuardRevision: 11, transferControl } }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow('Profile transfer migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({ request: withProfiles,
      migrate: async () => success({ profileRows: { rows: [], referenceGuardRevision: 11, transferControl: valid } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
  });

  it('preserves a deleted Profile transfer control revision without fabricating absence', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const withProfiles = { ...withoutDrafts, profileRows: { items: [], expectedReferenceGuardRevision: 11,
      transferControl: { expectedRevision: 3, content: null } } };
    const activateTargetMode = vi.fn();
    await expect(runAccountEncryptionModeMigration({ request: withProfiles,
      migrate: async () => success({ profileRows: { rows: [], referenceGuardRevision: 11, transferControl: { status: 'absent' } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).rejects.toThrow('Profile transfer migration response');
    await expect(runAccountEncryptionModeMigration({ request: withProfiles,
      migrate: async () => success({ profileRows: { rows: [], referenceGuardRevision: 11, transferControl: { status: 'deleted', revision: 3 } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
  });

  it('refuses a committed response in a different Account mode before local adoption', async () => {
    const activateTargetMode = vi.fn();
    await expect(runAccountEncryptionModeMigration({
      request, migrate: async () => success({ mode: 'e2ee', sessionDrafts: { records: [migratedRecord] } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).rejects.toThrow('Account mode migration response');
    expect(activateTargetMode).not.toHaveBeenCalled();
  });

  it('requires exact Project row coverage before adopting the target mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'project' };
    const content = { t: 'plain' as const, v: { key, value: { hidden: true } } };
    const withRows = { ...withoutDrafts, projectRows: { items: [{ key, expectedRevision: 7, content }] } };
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    for (const rows of [undefined, [], [{ key, revision: 7, content }], [{ key, revision: 8, content: null }],
      [{ key: { ...key, serverId: 'other-home' }, revision: 8, content }]]) {
      await expect(runAccountEncryptionModeMigration({ request: withRows,
        migrate: async () => success(rows ? { projectRows: { rows } } : {}), activateTargetMode, acknowledgeSessionDrafts,
      })).rejects.toThrow('Project row migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({ request: withRows,
      migrate: async () => success({ projectRows: { rows: [{ key, revision: 8, content }] } }), activateTargetMode, acknowledgeSessionDrafts,
    })).resolves.toMatchObject({ mode: 'plain' });
  });

  it('requires exact workspace execution row coverage before adopting the target mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: {
      enabled: false as const, unavailable: 'ask' as const, allowAdHoc: false,
      scriptOverrides: { build: 'workers' as const }, services: {
        web: { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'worker-a' } }, unavailable: 'fail' as const },
        api: { runsOn: { kind: 'primary' as const }, unavailable: 'primary' as const },
      },
    } };
    const rowId = 'a'.repeat(64);
    const withWorkspace = { ...withoutDrafts, workspaceExecutionConfig: {
      items: [{ rowId, expectedRevision: 7, content }],
    } };
    const activateTargetMode = vi.fn();
    for (const rows of [undefined, [], [{ rowId, revision: 7, content }],
      [{ rowId, revision: 8, content: null }],
      [{ rowId, revision: 8, content: { ...content, v: { ...content.v, services: {} } } }],
      [{ rowId: 'b'.repeat(64), revision: 8, content }]]) {
      await expect(runAccountEncryptionModeMigration({
        request: withWorkspace,
        migrate: async () => ({ ...success(), ...(rows ? { workspaceExecutionConfig: { rows } } : {}) }),
        activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
      })).rejects.toThrow('workspace execution config migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({
      request: withWorkspace,
      migrate: async () => ({ ...success(), workspaceExecutionConfig: { rows: [{ rowId, revision: 8, content }] } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
    expect(activateTargetMode).toHaveBeenCalledOnce();
  });

  it('requires exact qualified Project Trust acknowledgement before adopting the target mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const project = { serverId: 'home', projectId: 'project' };
    const content = { t: 'plain' as const, v: { project, reviewedEffectDigest: 'effect', approvedAtMs: 1 } };
    const withTrust = { ...withoutDrafts, projectTrust: { items: [{ project, expectedRevision: 7, content }] } };
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    for (const rows of [undefined, [], [{ project, revision: 7, content }], [{ project: { ...project, serverId: 'other' }, revision: 8, content }],
      [{ project, revision: 8, content: { ...content, v: { ...content.v, reviewedEffectDigest: 'wrong' } } }]]) {
      await expect(runAccountEncryptionModeMigration({ request: withTrust,
        migrate: async () => success(rows ? { projectTrust: { rows } } : {}), activateTargetMode, acknowledgeSessionDrafts,
      })).rejects.toThrow('Project Trust migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({ request: withTrust,
      migrate: async () => success({ projectTrust: { rows: [{ project, revision: 8, content }] } }), activateTargetMode, acknowledgeSessionDrafts,
    })).resolves.toMatchObject({ mode: 'plain' });
    expect(activateTargetMode).toHaveBeenCalledOnce();
  });

  it('requires exact authoring-memory coverage before adopting the target mode', async () => {
    const { sessionDrafts: _drafts, ...withoutDrafts } = request;
    const content = { t: 'plain' as const, v: 'profile-a' };
    const withMemory = { ...withoutDrafts, authoringMemory: {
      items: [{ key: 'lastUsedProfile' as const, expectedRevision: 7, content }],
    } };
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    for (const rows of [undefined, [], [{ key: 'lastUsedProfile' as const, revision: 7, content }],
      [{ key: 'lastUsedProfile' as const, revision: 8, content: { t: 'plain' as const, v: 'wrong-profile' } }]]) {
      await expect(runAccountEncryptionModeMigration({
        request: withMemory,
        migrate: async () => success(rows ? { authoringMemory: { rows } } : {}),
        activateTargetMode, acknowledgeSessionDrafts,
      })).rejects.toThrow('authoring memory migration response');
    }
    expect(activateTargetMode).not.toHaveBeenCalled();
    await expect(runAccountEncryptionModeMigration({
      request: withMemory,
      migrate: async () => success({ authoringMemory: { rows: [{ key: 'lastUsedProfile', revision: 8, content }] } }),
      activateTargetMode, acknowledgeSessionDrafts,
    })).resolves.toMatchObject({ mode: 'plain' });
    expect(activateTargetMode).toHaveBeenCalledOnce();
  });

  it('requires the selected draft response epoch before changing local encryption state', async () => {
    const capableRequest = { ...request, sessionDrafts: { ...request.sessionDrafts, v: 2 as const } };
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    await expect(runAccountEncryptionModeMigration({
      request: capableRequest,
      migrate: async () => success({ sessionDrafts: { records: [migratedRecord] } }),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).rejects.toThrow('draft migration response');
    expect(activateTargetMode).not.toHaveBeenCalled();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();

    await expect(runAccountEncryptionModeMigration({
      request: capableRequest,
      migrate: async () => success({ sessionDrafts: { v: 2, records: [migratedRecord] } }),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).resolves.toMatchObject({ sessionDrafts: { v: 2 } });
    expect(acknowledgeSessionDrafts).toHaveBeenCalledWith([migratedRecord]);
  });

  it('does not mutate the local cipher or repository before atomic server success', async () => {
    let resolve!: (value: AccountEncryptionMigrateSuccessResponse) => void;
    const serverResult = new Promise<AccountEncryptionMigrateSuccessResponse>((done) => { resolve = done; });
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();

    const pending = runAccountEncryptionModeMigration({
      request,
      migrate: async () => await serverResult,
      activateTargetMode,
      acknowledgeSessionDrafts,
    });
    await Promise.resolve();

    expect(activateTargetMode).not.toHaveBeenCalled();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();

    resolve(success({ sessionDrafts: { records: [migratedRecord] } }));
    await pending;

    expect(activateTargetMode).toHaveBeenCalledOnce();
    expect(acknowledgeSessionDrafts).toHaveBeenCalledWith([migratedRecord]);
    expect(activateTargetMode.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledgeSessionDrafts.mock.invocationCallOrder[0],
    );
  });

  it('retains the committed receipt without publishing it into a retired Home', async () => {
    let resolve!: (value: AccountEncryptionMigrateSuccessResponse) => void;
    const receipt = new Promise<AccountEncryptionMigrateSuccessResponse>(done => { resolve = done; });
    let current = true;
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    const pending = runAccountEncryptionModeMigration({ request, migrate: async () => receipt,
      isCurrent: () => current, activateTargetMode, acknowledgeSessionDrafts });
    current = false;
    const committed = success({ sessionDrafts: { records: [migratedRecord] } });
    resolve(committed);
    await expect(pending).resolves.toBe(committed);
    expect(activateTargetMode).not.toHaveBeenCalled();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();
  });

  it('rejects missing or stale success coverage before changing local state', async () => {
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();

    await expect(runAccountEncryptionModeMigration({
      request,
      migrate: async () => success(),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).rejects.toThrow('draft migration response');

    expect(activateTargetMode).not.toHaveBeenCalled();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();
  });

  it('accepts semantically equal envelopes independent of object key insertion order', async () => {
    const reordered = {
      ...migratedRecord,
      content: {
        t: 'plain' as const,
        v: { document, address, v: 1 as const },
      },
    };
    await expect(runAccountEncryptionModeMigration({
      request,
      migrate: async () => success({ sessionDrafts: { records: [reordered] } }),
      activateTargetMode: vi.fn(),
      acknowledgeSessionDrafts: vi.fn(),
    })).resolves.toMatchObject({ mode: 'plain' });
  });

  it('keeps the released zero-draft success path optional', async () => {
    const activateTargetMode = vi.fn();
    const acknowledgeSessionDrafts = vi.fn();
    const { sessionDrafts: _sessionDrafts, ...zeroDraftRequest } = request;

    await expect(runAccountEncryptionModeMigration({
      request: zeroDraftRequest,
      migrate: async () => success(),
      activateTargetMode,
      acknowledgeSessionDrafts,
    })).resolves.toMatchObject({ mode: 'plain' });

    expect(activateTargetMode).toHaveBeenCalledOnce();
    expect(acknowledgeSessionDrafts).not.toHaveBeenCalled();
  });
});
