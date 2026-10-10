import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1, accountSettingsParse, buildBackendTargetKeyV2, renderSessionRoleBlockV1, type SessionMetadata, type V2SessionByIdResponse } from '@happier-dev/protocol';
import { createSessionRoleContext } from './sessionRoleContext';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, commitActivePromptLibraryCatalog, beginActivePromptLibraryCatalogRefresh,
  readActiveAccountRoleOverrides } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { TokenOnlyCredentials } from '@/persistence';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createRoleSourceReaderV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';

const defaultEngine = { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }) };

describe('session role prompt-plan context', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
  it('resolves conversational Role facts without fabricating a coding engine', async () => {
    // The conversational caller has no coding engine; the Role owner must not require one.
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId: 'builder', overrides: { builder: { roleId: 'builder', instructionsOverride: 'VOICE_ROLE' } }, sessionRoles: {}, notes: 'VOICE_NOTES',
    } } }), readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }),
    });
    const context = await owner.resolvePromptContext();
    const rendered = renderSessionRoleBlockV1({ ...context!, modality: 'voice' });
    expect(rendered).toContain('VOICE_ROLE');
    expect(rendered).toContain('VOICE_NOTES');
    expect(context?.role?.engine).toBeUndefined();
  });
  it('demands the actual catalog for first use and explicit recovery without retargeting a retired Account', async () => {
    const credentials: TokenOnlyCredentials = { token: 'first-role-account', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const rawSettings = { rolesV1: { overrides: { builder: { roleId: 'builder', instructionsOverride: 'OLD_RETAINED', workspaceWrites: 'allow' } } } };
    const initial = { source: 'network' as const, settings: accountSettingsParse(rawSettings), rawSettings,
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey };
    setActiveAccountSettingsSnapshot(initial);
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    let retireDuringRead = false;
    let rowsUnavailable = false;
    // HTTP is the system boundary; storage admission, hydration, publication and Role resolution stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (rowsUnavailable && path === '/v1/account/entity-rows/prompt-library') throw new Error('Home unavailable');
      const data = path === '/v1/account/encryption/currentness'
        ? { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }
        : path === '/v1/account/entity-rows/prompt-library'
          ? { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 7,
              content: { t: 'plain', v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
                builder: { roleId: 'builder', instructionsOverride: 'CURRENT_ROW', workspaceWrites: 'deny' },
              } } } : emptyPromptLibraryRecordV1(key) } })) }
          : (() => { throw new Error(`Unexpected HTTP path: ${path}`); })();
      if (retireDuringRead && path === '/v1/account/entity-rows/prompt-library') {
        setActiveAccountSettingsSnapshot({ ...initial, scopeKey: 'other-account', rawSettings: {} });
      }
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data };
    });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } }),
      readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => readActiveAccountRoleOverrides(bound),
      prepareAccountRoleOverrides: async signal => {
        await prepareActiveAccountRoleOverrides({ credentials, ...bound, signal });
      },
    });
    await runWithServerHttpBaseUrl('http://catalog-home.test', async () => {
      expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CURRENT_ROW');
      expect(owner.readWorkspaceWrites()).toBe('deny');
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(4);
      beginActivePromptLibraryCatalogRefresh(bound);
      rowsUnavailable = true;
      await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
      rowsUnavailable = false;
      expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CURRENT_ROW');
      beginActivePromptLibraryCatalogRefresh(bound);
      retireDuringRead = true;
      await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
    });
  });
  it('prepares a catalog-only Role refresh through the current snapshot without a Settings version advance', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'scope-a' });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const catalog = (instructionsOverride: string) => ({ status: 'ready' as const, tombstones: [], diagnostics: [], rows: [{ revision: instructionsOverride === 'FIRST' ? 0 : 1,
      record: { key: 'role-overrides' as const, value: { v: 1 as const, overrides: {
        builder: { roleId: 'builder', workspaceWrites: 'deny' as const, instructionsOverride },
      } } },
    }] });
    commitActivePromptLibraryCatalog({ ...bound, catalog: catalog('FIRST') });
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } }),
      readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => readActiveAccountRoleOverrides(bound) });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('FIRST');
    commitActivePromptLibraryCatalog({ ...bound, catalog: catalog('SECOND') });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('SECOND');
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(4);
    beginActivePromptLibraryCatalogRefresh(bound);
    expect(owner.readWorkspaceWrites()).toBe('deny');
    await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
    resetActiveAccountSettingsSnapshotForTests();
  });
  it('uses current typed override admission and refuses unavailable catalogs instead of widening deny', async () => {
    let current: Readonly<{ status: 'ready'; overrides: { builder: { roleId: string; workspaceWrites: 'deny'; instructionsOverride: string } } }>
      | Readonly<{ status: 'unavailable'; reason: string }> = { status: 'ready', overrides: {
        builder: { roleId: 'builder', workspaceWrites: 'deny', instructionsOverride: 'CURRENT_CATALOG' },
      } };
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } }),
      readOrganization: async () => ({}), readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }),
      readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => current,
    });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CURRENT_CATALOG');
    expect(owner.readWorkspaceWrites()).toBe('deny');
    current = { status: 'unavailable', reason: 'scope-retired' };
    expect(owner.readWorkspaceWrites()).toBe('deny');
    await expect(owner.resolvePromptContext()).rejects.toMatchObject({ code: 'role_overrides_unavailable' });
  });
  it('retains a complete inherited Role snapshot when Account catalog authority is unavailable', async () => {
    const inherited = { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder', engine: defaultEngine,
      instructions: 'FROZEN_ROLE', workspaceWrites: 'allow' as const };
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      roleId: 'builder', inheritedFrom: 'lead', overrides: {}, sessionRoles: { builder: inherited }, notes: '',
    } } }), readOrganization: async () => ({ reportsTo: { sessionId: 'lead' } }),
      readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => ({ status: 'unavailable', reason: 'catalog-unobserved' }),
    });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('FROZEN_ROLE');
    expect(owner.readWorkspaceWrites()).toBe('allow');
  });
  it('does not create a Role ceiling after acknowledged Role removal when Account overrides are unavailable', () => {
    const scopeKey = 'native-role-account';
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const bound = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'ready', tombstones: [], diagnostics: [], rows: [{ revision: 1,
      record: { key: 'role-overrides', value: { v: 1, overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } } },
    }] } });
    let metadata: unknown = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } };
    const owner = createSessionRoleContext({ readMetadata: () => metadata, readOrganization: async () => ({}),
      readRoleSources: createRoleSourceReaderV1({}), readDefaultEngine: () => defaultEngine,
      readAccountRoleOverrides: () => readActiveAccountRoleOverrides(bound) });
    expect(owner.readWorkspaceWrites()).toBe('deny');
    commitActivePromptLibraryCatalog({ ...bound, catalog: { status: 'unavailable', reason: 'unreachable' } });
    expect(owner.readWorkspaceWrites()).toBe('deny');
    // The Session metadata owner has acknowledged removal; unavailable Account
    // overrides cannot invent a selection or keep the removed Role's ceiling.
    metadata = { work: { sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: '' } } };
    expect(owner.readWorkspaceWrites()).toBeUndefined();
    metadata = { work: { sessionRolesV1: { roleId: 'private-role', overrides: {}, sessionRoles: {}, notes: '' } } };
    expect(owner.readWorkspaceWrites()).toBe('deny');
    metadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {
      builder: { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder', engine: defaultEngine, workspaceWrites: 'allow' },
    }, notes: '' } } };
    expect(owner.readWorkspaceWrites()).toBe('allow');
    metadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: 17 } } };
    expect(owner.readWorkspaceWrites()).toBe('deny');
  });
  it('resolves live source and session fields for the canonical Session prompt plan', async () => {
    let metadata: SessionMetadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' } } };
    const owner = createSessionRoleContext({ readMetadata: () => metadata,
      readOrganization: async () => ({}),
      readRoleSources: async () => ({ status: 'ready', entries: [{ roleId: 'builder', role: BUILT_IN_ROLES_V1.builder, shared: false, viewOnly: false, migratedFromV0_2: false }], diagnostics: [] }),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine,
    });
    const first = await owner.resolvePromptContext();
    expect(renderSessionRoleBlockV1(first!)).toContain(BUILT_IN_ROLES_V1.builder.instructions);
    metadata = { work: { sessionRolesV1: { roleId: 'builder', overrides: { builder: { roleId: 'builder', instructionsOverride: 'CHANGED_ROLE' } }, sessionRoles: {}, notes: 'CURRENT_NOTES' } } };
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('CHANGED_ROLE');
  });

  it('renders a live worker boundary without a selected role and leaves frozen step roles to step input', async () => {
    let metadata: SessionMetadata = {};
    let organization: Pick<V2SessionByIdResponse['session'], 'reportsTo' | 'origin'> = { reportsTo: { sessionId: 'lead' } };
    const owner = createSessionRoleContext({ readMetadata: () => metadata, readOrganization: async () => organization,
      readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine });
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('lead_session_id="lead"');
    metadata = { work: { sessionRolesV1: { inheritedFrom: 'lead', overrides: {}, sessionRoles: {}, notes: 'TASK_BOUNDARY' } } };
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toContain('TASK_BOUNDARY');
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).not.toContain('prompt_doc.update');
    organization = { ...organization, origin: { kind: 'run_step' } };
    expect(renderSessionRoleBlockV1((await owner.resolvePromptContext())!)).toBe('');
    organization = {};
    const detached = renderSessionRoleBlockV1((await owner.resolvePromptContext())!);
    expect(detached).not.toContain('lead_session_id');
    expect(detached).not.toContain('memory');
    expect(detached).toContain('TASK_BOUNDARY');
  });

  it('does not use an inherited snapshot as a live relation when its Home projection is unavailable', async () => {
    const owner = createSessionRoleContext({ readMetadata: () => ({ work: { sessionRolesV1: {
      inheritedFrom: 'old-lead', overrides: {}, sessionRoles: {}, notes: 'old boundary',
    } } }), readOrganization: async () => { throw new Error('home unavailable'); },
      readRoleSources: async () => ({ status: 'ready', entries: [], diagnostics: [] }), readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readDefaultEngine: () => defaultEngine });
    await expect(owner.resolvePromptContext()).rejects.toThrow('home unavailable');
  });
});
