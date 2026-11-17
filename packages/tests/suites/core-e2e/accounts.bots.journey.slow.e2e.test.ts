import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { SetSessionPinResponseSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionOrganizationMoveOutputSchema } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { waitFor } from '../../src/testkit/timing';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AccountSelfProfileV1Schema } from '@happier-dev/protocol/account/profile';
import { AgentsAcpBackendsGetOutputV1Schema, AgentsAcpBackendsUpsertOutputV1Schema } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/actionSchemasV1';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { PLUGIN_MANIFEST } from '../../../plugins/claude/src/manifest';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
  files: new Map<number, Uint8Array>(), reads: 0 }));
// The source-driven UI has no Metro package assets. Supply the actual compiler
// output at that package/Expo boundary; registration and persistence stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
  get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
  get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
  BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({
  localUri: `file:///connected-bots/${asset}`, downloadAsync: async () => {},
}) } }));
vi.mock('expo-file-system', async () => {
  const boundary = await import('../../../../apps/ui/sources/dev/testkit/mocks/expoFileSystemModule');
  return { ...boundary, File: class extends boundary.File {
    get exists() { return packaged.files.has(Number(this.uri.split('/').at(-1))) || super.exists; }
    async bytes() {
      const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
      if (!bytes) return super.bytes();
      packaged.reads += 1;
      return new Uint8Array(bytes);
    }
  } };
});

// MATRIX-1110: 89 covers offline Profile writes and a person's Account approval;
// 87 covers portable Claude credentials, but not Vercel selected-Secret setup.
// 61 covers inert Profile/ACP/MCP definitions; 103 covers Bot rail order across
// reconnect. These journeys do not cover 40's carrier/defaults, 68's template release/link, 69's
// copy/update/Skip/Stop, 70's publish/Store, or 71's rendered completion/motion.
// The setup-token path deliberately accepts a local dummy. Real third-party
// credential validity and paid provisioning remain release checks.
describe('Account and Bot uninterrupted journeys through signed-in UI Actions', () => {
  let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;

  beforeAll(async () => {
    const fixtureSource = '../../../../apps/ui/sources/dev/testkit/fixtures/connectedAccountAuthentication';
    const { prepareAuthenticationInventory } = await import(fixtureSource) as {
      prepareAuthenticationInventory(boundary: typeof packaged, input: Readonly<{ manifest: unknown;
        target: Readonly<{ artifactId: string; exportName: string }>; projectPath: string; entryPath: string;
        packageName: string }>): Promise<unknown>;
    };
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(value => value.id === 'claude-subscription');
    const target = descriptor?.authentication.account;
    if (!target) throw new Error('Claude Account authentication artifact is missing');
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target,
      projectPath: 'packages/plugins/claude', entryPath: 'packages/plugins/claude/src/connectedAccounts/account.ts',
      packageName: '@happier-dev/plugins-claude' });
    postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
    fixture = await startProjectDaemonFixture({
      testDir: await mkdtemp(join(tmpdir(), 'accounts-bots-journey-')),
      dbProvider: 'postgres', serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl },
      daemonEnv: { HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath() },
    });
  }, 0);
  afterAll(async () => { try { await fixture?.stop(); } finally { await postgres?.stop(); } });

  it('saves Profile, ACP and MCP definitions and approves and revokes Account changes without a Machine', async () => {
    if (!fixture) throw new Error('Account journey Home did not start');
    const account = await fixture.createAccount(`portable-account-${randomUUID()}`);
    let ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl,
      accountSecret: account.auth.accountSigningSeed });
    const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    const token = 'journey-only-synthetic-setup-token';
    async function invoke(actionId: ActionId, input: unknown) {
      const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: ui.serverId });
      if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
      return result.result;
    }
    const list = async () => CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.list']
      .parse(await invoke('connectedServices.accounts.list', { service }));
    try {
      await waitFor(() => ui.isAccountReady(), { context: 'portable Account sign-in' });
      expect(await invoke('machines.list', { refresh: true })).toMatchObject({ items: [] });
      const profile = LaunchProfileV2Schema.parse({ v: 2, id: `journey-${randomUUID()}`, name: 'Offline Account profile',
        createdAt: Date.now(), updatedAt: Date.now() });
      const created = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.create'].parse(await invoke('launch_profiles.create', {
        profile, expectedRevision: 'absent',
      }));
      expect(created).toMatchObject({ status: 'updated', id: profile.id });
      if (created.status !== 'updated') throw new Error(`Profile creation settled ${created.status}`);
      const editedProfile = { ...profile, name: 'Saved without a Machine' };
      const edited = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.save'].parse(await invoke('launch_profiles.save', {
        id: profile.id, expectedRevision: created.revision, profile: editedProfile,
      }));
      expect(edited).toMatchObject({ status: 'updated', id: profile.id });
      // Inert declarations are saved through their owners; neither command is run.
      const acp = AcpBackendDefinitionV1Schema.parse({ id: `journey-${randomUUID()}`, name: 'journey-acp',
        title: 'Inert ACP', launch: { kind: 'command', command: 'journey-acp-not-an-executable', args: [] },
        createdAt: Date.now(), updatedAt: Date.now() });
      const acpCreated = AgentsAcpBackendsUpsertOutputV1Schema.parse(await invoke('agents.acp.backends.upsert', { backend: acp }));
      if (!('revision' in acpCreated)) throw new Error('ACP definition was only previewed');
      expect(AgentsAcpBackendsUpsertOutputV1Schema.parse(await invoke('agents.acp.backends.upsert', {
        backend: { ...acp, title: 'Saved ACP' }, expectedRevision: acpCreated.revision,
      }))).toMatchObject({ backend: { id: acp.id, title: 'Saved ACP' } });
      const mcpCatalog = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(await invoke('mcp.servers.list', {}));
      expect(mcpCatalog.status).toBe('ready');
      if (mcpCatalog.status !== 'ready') throw new Error(`MCP catalog is ${mcpCatalog.status}`);
      const mcp = McpServerCatalogEntryV1Schema.parse({ id: randomUUID(), name: 'journey-mcp', title: 'Inert MCP',
        transport: 'stdio', stdio: { command: 'journey-mcp-not-an-executable', args: [] }, env: {},
        createdAt: Date.now(), updatedAt: Date.now() });
      const mcpCreated = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].parse(await invoke('mcp.servers.create', {
        entry: mcp, expectedRevision: mcpCatalog.revision, where: { kind: 'replace', rules: [] },
      }));
      expect(mcpCreated.status).toBe('updated');
      expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.update'].parse(await invoke('mcp.servers.update', {
        entry: { ...mcp, title: 'Saved MCP' }, expectedRevision: mcpCreated.revision,
      }))).toMatchObject({ status: 'updated' });
      // The terminal proposes the mutation; only the signed-in person decides it.
      const proposed = await account.execute('account.name.set', { name: 'Approved without a Machine' });
      if (!proposed.ok) throw new Error(`Name proposal refused (${proposed.errorCode})`);
      const approval = ActionApprovalRequestCreatedResultSchema.parse(proposed.result);
      expect(await invoke('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }))
        .toMatchObject({ status: 'executed' });
      expect(AccountSelfProfileV1Schema.parse(await invoke('account.profile.get', {})).name)
        .toBe('Approved without a Machine');
      expect((await list()).accounts).toEqual([]);
      const begun = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.beginConnect', {
        service, modeId: 'setup-token',
      }));
      expect({ status: begun.status, code: 'code' in begun ? begun.code : undefined })
        .toEqual({ status: 'awaitingManual', code: undefined });
      if (begun.status !== 'awaitingManual') throw new Error(`Portable Connect settled ${begun.status}`);
      const connected = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.submitManual', {
        attemptId: begun.attemptId, fields: { token },
      }));
      expect(connected).toMatchObject({ status: 'connected' });
      if (connected.status !== 'connected') throw new Error(`Portable credential settled ${connected.status}`);
      const saved = await list();
      expect(saved.accounts).toEqual([expect.objectContaining({ account: expect.objectContaining({ ref: connected.account }) })]);
      expect(JSON.stringify(saved)).not.toContain(token);
      await ui.close();
      ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
      await waitFor(() => ui.isAccountReady(), { context: 'portable Account reopen' });
      expect(AccountSelfProfileV1Schema.parse(await invoke('account.profile.get', {})).name)
        .toBe('Approved without a Machine');
      expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.read'].parse(await invoke('launch_profiles.read', { id: profile.id })))
        .toMatchObject({ status: 'present', profile: { id: profile.id, name: editedProfile.name } });
      expect(AgentsAcpBackendsGetOutputV1Schema.parse(await invoke('agents.acp.backends.get', { backendId: acp.id })))
        .toMatchObject({ backend: { id: acp.id, title: 'Saved ACP', launch: acp.launch } });
      expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse(await invoke('mcp.servers.read', { serverId: mcp.id })))
        .toMatchObject({ status: 'present', server: { id: mcp.id, title: 'Saved MCP', stdio: mcp.stdio } });
      expect((await list()).accounts.map(row => row.account.ref)).toEqual([connected.account]);
      const revoked = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].parse(
        await invoke('connectedServices.accounts.revoke', { account: connected.account, cleanupGroupReferences: true }));
      expect(revoked).toMatchObject({ status: 'revoked', account: connected.account });
      expect((await list()).accounts).toEqual([]);
      await ui.close();
      ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
      await waitFor(() => ui.isAccountReady(), { context: 'revoked Account reopen' });
      expect((await list()).accounts).toEqual([]);
    } finally { await ui.close(); }
  }, 0);

  // MATRIX-1110 rows 40/103: identity and independent list/rail membership
  // survive reconnect. Carrier restarts and physical motion stay separate.
  it('promotes ordinary Sessions to Bots and persists a rail move and independent list membership', async () => {
    if (!fixture) throw new Error('Bot journey Home did not start');
    const account = await fixture.createAccount(`bot-owner-${randomUUID()}`);
    const machine = await fixture.enrollDaemon(account);
    const sessions = [];
    for (let index = 0; index < 3; index++) {
      sessions.push(await fixture.assertKnownGoodSessionControl(account, machine));
    }
    const [first, second, third] = sessions;
    if (!first || !second || !third) throw new Error('Bot journey needs three ordinary Sessions');
    let ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
    async function invoke(actionId: ActionId, input: unknown) {
      const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: ui.serverId });
      if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
      return result.result;
    }
    async function snapshot() {
      const response = await fetch(`${fixture!.server.baseUrl}/v2/session-organization`, {
        headers: { authorization: `Bearer ${account.auth.token}` },
      });
      expect(response.status).toBe(200);
      return SessionOrganizationSnapshotResponseSchema.parse(await response.json()).snapshot;
    }
    // UI modules are loaded under the canonical cross-app resolver. Keeping the
    // specifiers nonliteral preserves each app's separate TypeScript program.
    const railSource = '../../../../apps/ui/sources/components/sessions/shell/useSessionListRailOrganizationAction';
    const renderSource = '../../../../apps/ui/sources/dev/testkit/hooks/renderHook';
    const rowSource = '../../../../apps/ui/sources/components/sessions/shell/drop-resolution/treeRowId';
    const orderSource = '../../../../apps/ui/sources/sync/domains/session/listing/sessionListOrderingStateV1';
    const { useSessionListRailOrganizationAction } = await import(railSource) as {
      useSessionListRailOrganizationAction(serverIds: readonly string[]): void;
    };
    const { renderHook } = await import(renderSource) as {
      renderHook(useValue: () => void): Promise<{ unmount(): Promise<void> }>;
    };
    const { treeRowId } = await import(rowSource) as { treeRowId: { session(serverId: string, sessionId: string): string } };
    const { PINNED_GROUP_KEY_V1 } = await import(orderSource) as { PINNED_GROUP_KEY_V1: string };
    let mounted: Awaited<ReturnType<typeof renderHook>> | undefined;
    try {
      await waitFor(() => ui.isAccountReady(), { context: 'Bot Account sign-in' });
      for (const session of sessions) {
        await invoke('session.bot.set', { sessionId: session.sessionId, bot: { kind: 'bot' } });
        expect(await account.readSessionMetadata(session.sessionId)).toMatchObject({ bot: { kind: 'bot' } });
        const pinned = SetSessionPinResponseSchema.parse(await invoke('session.organization.pin.set', {
          sessionId: session.sessionId, surface: 'rail', pinned: true,
        }));
        expect(pinned.pin).toMatchObject({ sessionId: session.sessionId, railPinned: true, listPinned: false });
      }
      expect(SetSessionPinResponseSchema.parse(await invoke('session.organization.pin.set', {
        sessionId: first.sessionId, surface: 'list', pinned: true,
      })).pin).toMatchObject({ railPinned: true, listPinned: true });
      mounted = await renderHook(() => useSessionListRailOrganizationAction([ui.serverId]));
      const moved = SessionOrganizationMoveOutputSchema.parse(await invoke('session.organization.move', {
        scope: { serverId: ui.serverId, accountId: readAccountIdFromToken(account.auth.token) }, projection: 'rail',
        sourceRowId: treeRowId.session(ui.serverId, third.sessionId), sourceKind: 'leaf', instructionKind: 'reorder-before',
        targetRowId: treeRowId.session(ui.serverId, first.sessionId), containerId: PINNED_GROUP_KEY_V1, parentRowId: null, depth: 0, edge: 'top',
      }));
      expect(moved).toEqual({ status: 'applied' });
      const expectedOrder = [third.sessionId, first.sessionId, second.sessionId];
      expect((await snapshot()).pins.map(pin => pin.sessionId)).toEqual(expectedOrder);
      await mounted.unmount();
      mounted = undefined;
      await ui.close();
      ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
      await waitFor(() => ui.isAccountReady(), { context: 'Bot Account reopen' });
      expect((await snapshot()).pins.map(pin => pin.sessionId)).toEqual(expectedOrder);
      for (const session of sessions) expect(await account.readSessionMetadata(session.sessionId)).toMatchObject({ bot: { kind: 'bot' } });
      expect(SetSessionPinResponseSchema.parse(await invoke('session.organization.pin.set', {
        sessionId: first.sessionId, surface: 'rail', pinned: false,
      })).pin).toMatchObject({ listPinned: true, railPinned: false });
      expect((await snapshot()).pins).toContainEqual(expect.objectContaining({ sessionId: first.sessionId, listPinned: true, railPinned: false }));
    } finally { try { await mounted?.unmount(); } finally { await ui.close(); } }
  }, 0);
});
