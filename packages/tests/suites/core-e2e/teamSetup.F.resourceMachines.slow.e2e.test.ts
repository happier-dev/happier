import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { teamGroupLabelBinding } from '@happier-dev/protocol/teams/groupLabel';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { prepareCliPrivateLabels } from '../../../../apps/cli/src/api/privateLabels';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { runStressTasksWithConcurrencyLimit } from '../../src/testkit/stress/scenarios/runStressTasksWithConcurrencyLimit';

describe('Team setup F: Machine resource owner filters', () => {
  let fixture: TeamSetupFFixture;
  let owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  let teamId: string;
  let otherTeamId: string;
  let poolId: string;
  let presetId: string;
  let groupId: string;

  beforeAll(async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'team-setup-f-resource-machines-')),
      dbProvider: process.env.HAPPIER_E2E_DB_PROVIDER === 'sqlite' ? 'sqlite' : 'postgres', observeActionRequests: true });
    owner = await fixture.createAccount('resource-machines-owner');
    machine = await fixture.enrollDaemon(owner);
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const createTeam = async (name: string) => {
      const result = await owner.execute('teams.create', { v: 1, name, requestKey: randomUUID() });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`Team fixture refused (${result.errorCode})`);
      return TeamSummaryV1Schema.parse(result.result).id;
    };
    teamId = await createTeam('Selected Machine resources');
    otherTeamId = await createTeam('Other Machine resources');
    groupId = randomUUID();
    const [groupName] = await prepareCliPrivateLabels({ endpoint: fixture.server.baseUrl,
      token: owner.credentials.token, accountMode: 'e2ee', owner: { kind: 'team', teamId },
      recipientCensusPath: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH,
      labels: [{ binding: teamGroupLabelBinding(groupId, 'name'), value: 'Machine readers' }] });
    expect(await owner.execute('teams.groups.create', { v: 1, teamId, groupId, name: groupName, requestKey: randomUUID() }))
      .toMatchObject({ ok: true });
    expect(await owner.execute('teams.groups.members.add', { v: 1, teamId, groupId,
      accountId: readAccountIdFromToken(owner.credentials.token), historyAccess: 'all_existing' }))
      .toMatchObject({ ok: true });
    const grant = await owner.executeAsPerson('machines.access.grant.set', { ...machine.target,
      principal: { kind: 'group', teamId, groupId }, level: 'view' });
    expect(grant).toMatchObject({ ok: true });
    for (const selectedTeamId of [teamId, otherTeamId]) {
      const id = randomUUID();
      const [name] = await prepareCliPrivateLabels({ endpoint: fixture.server.baseUrl,
        token: owner.credentials.token, accountMode: 'e2ee', owner: { kind: 'team', teamId: selectedTeamId },
        recipientCensusPath: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH,
        labels: [{ binding: { entity: 'machine_pool', field: 'name', id }, value: 'Team pool' }] });
      expect(await owner.execute('machines.pools.create', { poolId: id, name,
        audience: { kind: 'team', teamId: selectedTeamId }, members: [] })).toMatchObject({ ok: true });
      if (selectedTeamId === teamId) poolId = id;
      const presetOwner = { kind: 'team' as const, teamId: selectedTeamId };
      const censusResponse = await fetch(`${fixture.server.baseUrl}/v1/machines/presets/recipient-census`, {
        method: 'POST', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeId: fixture.serverId, owner: presetOwner }),
      });
      expect(censusResponse.status).toBe(200);
      const census = ManagedMachinePresetRecipientCensusResultV1Schema.parse(await censusResponse.json());
      if (census.kind !== 'ready') throw new Error(`Preset census refused (${census.code})`);
      const preset = randomUUID();
      expect(await owner.execute('machines.presets.create', { id: preset, homeId: fixture.serverId,
        owner: presetOwner, contentEncryptionMode: 'e2ee', ...sealManagedMachinePresetContentV1({
          presetId: preset, mode: 'e2ee', content: { v: 1, name: 'Team preset', setup: { scripts: [{ body: 'true', affects: 'none' }] } },
          recipientCensus: census.recipients, randomBytes: length => new Uint8Array(randomBytes(length)),
        }) })).toMatchObject({ ok: true, result: { kind: 'saved' } });
      if (selectedTeamId === teamId) presetId = preset;
    }
    // The public API creates real opaque records. These belong to the viewer,
    // so Team scoping must exclude them before content opening or pagination.
    const wrap = (dataKey: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey,
      recipientPublicKey: owner.credentials.encryption.publicKey,
      randomBytes: length => new Uint8Array(randomBytes(length)) })).toString('base64');
    const unrelatedMachines = await runStressTasksWithConcurrencyLimit(Array.from({ length: 100 }, (_, index) => index),
      16, async index => {
        const dataKey = new Uint8Array(randomBytes(32));
        const created = await registerMachineIdentity({ baseUrl: fixture.server.baseUrl, token: owner.credentials.token,
          metadata: encryptDataKeyBase64({ host: `unrelated-${index}`, platform: 'linux', homeDir: '/home/test',
            happyHomeDir: '/home/test/.happier', happyCliVersion: 'test' }, dataKey), dataEncryptionKey: wrap(dataKey) });
        expect(created.status).toBe(200);
        return created.machineId;
      });
    await runStressTasksWithConcurrencyLimit(Array.from({ length: 1_000 }, (_, index) => index), 16, async index => {
      const dataKey = new Uint8Array(randomBytes(32));
      return createSessionWithCiphertexts({ baseUrl: fixture.server.baseUrl, token: owner.credentials.token,
        metadataCiphertextBase64: encryptDataKeyBase64({ path: `/home/test/unrelated-${index}`,
          machineId: unrelatedMachines[index % unrelatedMachines.length], host: 'unrelated', flavor: 'claude' }, dataKey),
        dataEncryptionKeyBase64: wrap(dataKey),
        agentStateCiphertextBase64: encryptDataKeyBase64({ requests: {}, completedRequests: {} }, dataKey) });
    });
  });
  afterAll(async () => { await fixture?.stop(); });

  async function spawnSession(extra: Readonly<Record<string, unknown>> = {}) {
    const result = await owner.execute('session.spawn_new', { executionTarget: machine.target,
      directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      terminal: { mode: 'plain' }, ...extra });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Machine use refused (${result.errorCode})`);
    const launched = SessionSpawnNewResultV1Schema.parse(result.result);
    expect(launched.type).toBe('success');
    if (launched.type !== 'success') throw new Error(`Machine launch failed (${launched.type === 'error' ? launched.code : launched.outcome})`);
    expect(await owner.readSessionMetadata(launched.sessionId)).toBeTruthy();
    return launched.sessionId;
  }

  async function useSelectedMachine() { await spawnSession(); }

  it('TS.F.kindPaging machines uses the selected Team grant and keeps its existing use path', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    expect(await owner.execute('machines.list', { serverId: fixture.serverId, sharedWithTeamId: otherTeamId }))
      .toMatchObject({ ok: true, result: { items: [] } });
    expect(await owner.execute('machines.list', { serverId: fixture.serverId, sharedWithTeamId: teamId }))
      .toMatchObject({ ok: true, result: { items: [{ machineId: machine.target.machineId, sharedWithTeamScope: 'group' }] } });
    const ordinary = await owner.execute('machines.list', { serverId: fixture.serverId });
    expect(ordinary.ok).toBe(true);
    if (ordinary.ok) for (const row of (ordinary.result as { items: Record<string, unknown>[] }).items)
      expect(row).not.toHaveProperty('sharedWithTeamScope');
    await useSelectedMachine();
  });

  it('TS.F.kindPaging pools excludes another Team pool before projecting members', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const listed = await owner.execute('machines.pools.list', { sharedWithTeamId: teamId });
    expect(listed).toMatchObject({ ok: true, result: { pools: [{ pool: { id: poolId }, sharedWithTeamScope: 'team' }] } });
    if (listed.ok) expect((listed.result as { pools: unknown[] }).pools).toHaveLength(1);
    await useSelectedMachine();
  });

  it('TS.F.kindPaging presets excludes another Team preset and preserves archived selection', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const listed = await owner.execute('machines.presets.list', { homeId: fixture.serverId,
      sharedWithTeamId: teamId, includeArchived: true });
    expect(listed).toMatchObject({ ok: true, result: { kind: 'listed', presets: [{ id: presetId, sharedWithTeamScope: 'team' }] } });
    if (listed.ok) expect((listed.result as { presets: unknown[] }).presets).toHaveLength(1);
    const archived = await owner.execute('machines.presets.archive', { homeId: fixture.serverId,
      id: presetId, expectedRevision: 0 });
    expect(archived).toMatchObject({ ok: true, result: { kind: 'saved', preset: { archivedAt: expect.any(Number) } } });
    expect(await owner.execute('machines.presets.list', { homeId: fixture.serverId, sharedWithTeamId: teamId }))
      .toMatchObject({ ok: true, result: { kind: 'listed', presets: [] } });
    expect(await owner.execute('machines.presets.list', { homeId: fixture.serverId,
      sharedWithTeamId: teamId, includeArchived: true }))
      .toMatchObject({ ok: true, result: { kind: 'listed', presets: [{ id: presetId, archivedAt: expect.any(Number) }] } });
    if (!archived.ok) throw new Error(`Preset archive refused (${archived.errorCode})`);
    const archivedRevision = (archived.result as { preset: { revision: number } }).preset.revision;
    expect(await owner.execute('machines.presets.restore', { homeId: fixture.serverId,
      id: presetId, expectedRevision: archivedRevision })).toMatchObject({ ok: true, result: { kind: 'saved' } });
    await useSelectedMachine();
  });

  it('TS.F.summaryDemand counts the same selected Team Machine resources', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    fixture.takeRequestObservations();
    const summary = await owner.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId });
    expect(summary).toMatchObject({ ok: true, result: { teamId, kinds: expect.arrayContaining([
      { kind: 'machines', status: 'available', count: 1 },
      { kind: 'machinePools', status: 'available', count: 1 },
      { kind: 'machinePresets', status: 'available', count: 1 },
      { kind: 'sessions', status: 'available', count: 0 },
    ]) } });
    const requests = fixture.takeRequestObservations();
    expect(requests.filter(row => row.path === getActionSpec('teams.sharedResources.summary' as ActionId).serverTransport?.path)).toHaveLength(1);
    expect(requests.filter(row => /\/(?:machines|sessions)(?:\/|$)/.test(row.path))).toEqual([]);
    await useSelectedMachine();
  });

  it('TS.F.kindPaging excludes a Group outsider admin and applies withdrawal on the next read', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const viewer = await fixture.createAccount('resources-machine-admin');
    const accountId = readAccountIdFromToken(viewer.credentials.token);
    expect(await owner.execute('teams.members.add', { v: 1, teamId, accountId,
      role: 'admin', historyAccess: 'all_existing' })).toMatchObject({ ok: true });
    for (const state of ['outside', 'joined', 'revoked'] as const) {
      if (state === 'joined') expect(await owner.execute('teams.groups.members.add', {
        v: 1, teamId, groupId, accountId, historyAccess: 'all_existing' })).toMatchObject({ ok: true });
      if (state === 'revoked') expect(await owner.execute('teams.groups.members.remove', {
        v: 1, teamId, groupId, accountId })).toMatchObject({ ok: true });
      const listed = await viewer.execute('machines.list', { serverId: fixture.serverId, sharedWithTeamId: teamId });
      expect(listed).toMatchObject({ ok: true, result: { items: state === 'joined'
        ? [{ machineId: machine.target.machineId, sharedWithTeamScope: 'group' }] : [] } });
      expect(await viewer.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId }))
        .toMatchObject({ ok: true, result: { kinds: expect.arrayContaining([
          { kind: 'machines', status: 'available', count: state === 'joined' ? 1 : 0 },
        ]) } });
    }
    // A Team grant admits this admin without disclosing a private Group arm.
    // Joining that Group adds exactly its provenance; another Team never does.
    for (const selectedTeamId of [teamId, otherTeamId]) expect(await owner.executeAsPerson('machines.access.grant.set', {
      ...machine.target, principal: { kind: 'team', teamId: selectedTeamId }, level: 'view',
    })).toMatchObject({ ok: true });
    for (const state of ['outside', 'joined', 'revoked'] as const) {
      if (state === 'joined') expect(await owner.execute('teams.groups.members.add', {
        v: 1, teamId, groupId, accountId, historyAccess: 'all_existing' })).toMatchObject({ ok: true });
      if (state === 'revoked') expect(await owner.execute('teams.groups.members.remove', {
        v: 1, teamId, groupId, accountId })).toMatchObject({ ok: true });
      expect(await viewer.execute('machines.list', { serverId: fixture.serverId, sharedWithTeamId: teamId }))
        .toMatchObject({ ok: true, result: { items: [{ machineId: machine.target.machineId,
          sharedWithTeamScope: state === 'joined' ? 'team_and_group' : 'team' }] } });
    }
    expect(await owner.execute('machines.list', { serverId: fixture.serverId, sharedWithTeamId: otherTeamId }))
      .toMatchObject({ ok: true, result: { items: [{ machineId: machine.target.machineId, sharedWithTeamScope: 'team' }] } });
    for (const selectedTeamId of [teamId, otherTeamId]) expect(await owner.executeAsPerson('machines.access.grant.remove', {
      ...machine.target, principal: { kind: 'team', teamId: selectedTeamId },
    })).toMatchObject({ ok: true });
    await useSelectedMachine();
  });

  it('TS.F.summaryDemand preserves Session audience, recording privacy and membership history', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const grant = { subject: { kind: 'team', teamId }, accessLevel: 'view', canApprovePermissions: false };
    const historical = await spawnSession({ primaryTeamId: teamId, initialAccess: { grants: [grant] } });
    const viewer = await fixture.createAccount('resources-session-viewer');
    expect(await owner.execute('teams.members.add', { v: 1, teamId,
      accountId: readAccountIdFromToken(viewer.credentials.token), role: 'member', historyAccess: 'from_membership' }))
      .toMatchObject({ ok: true });
    const groupGrant = { subject: { kind: 'group', teamId, groupId }, accessLevel: 'view', canApprovePermissions: false };
    const current = await spawnSession({ primaryTeamId: teamId, initialAccess: { grants: [grant, groupGrant] } });
    const privateRecording = await spawnSession({ primaryTeamId: teamId, transcriptStorage: 'direct' });
    const unrelated = await spawnSession({ primaryTeamId: otherTeamId });
    const listed = await viewer.execute('session.list', { query: { v: 1, storage: 'active', includeInactive: true,
      scope: 'all_accessible', attention: 'any', audiences: [{ kind: 'team', teamId }], tagIds: [] } });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(`Session list refused (${listed.errorCode})`);
    const rows = (listed.result as { sessions: { id: string; sharedWithTeamScope?: string }[] }).sessions;
    const sessionIds = rows.map(session => session.id);
    expect(sessionIds).toContain(current);
    expect(rows.find(session => session.id === current)).toMatchObject({ sharedWithTeamScope: 'team' });
    for (const hidden of [historical, privateRecording, unrelated]) expect(sessionIds).not.toContain(hidden);
    expect(await viewer.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId }))
      .toMatchObject({ ok: true, result: { kinds: expect.arrayContaining([
        { kind: 'sessions', status: 'available', count: 1 },
      ]) } });
    const accountId = readAccountIdFromToken(viewer.credentials.token);
    expect(await owner.execute('teams.groups.members.add', { v: 1, teamId, groupId, accountId,
      historyAccess: 'all_existing' })).toMatchObject({ ok: true });
    const groupOnly = await spawnSession({ primaryTeamId: teamId, initialAccess: { grants: [groupGrant] } });
    for (const joined of [true, false]) {
      if (!joined) expect(await owner.execute('teams.groups.members.remove', { v: 1, teamId, groupId, accountId }))
        .toMatchObject({ ok: true });
      const scoped = await viewer.execute('session.list', { query: { v: 1, storage: 'active', includeInactive: true,
        scope: 'all_accessible', attention: 'any', audiences: [{ kind: 'team', teamId }], tagIds: [] } });
      expect(scoped.ok).toBe(true);
      if (!scoped.ok) throw new Error(`Session list refused (${scoped.errorCode})`);
      const scopedRows = (scoped.result as { sessions: { id: string; sharedWithTeamScope?: string }[] }).sessions;
      expect(scopedRows.find(row => row.id === current)).toMatchObject({
        sharedWithTeamScope: joined ? 'team_and_group' : 'team',
      });
      if (joined) expect(scopedRows.find(row => row.id === groupOnly)).toMatchObject({ sharedWithTeamScope: 'group' });
      else expect(scopedRows.map(row => row.id)).not.toContain(groupOnly);
    }
    await useSelectedMachine();
  });
});
