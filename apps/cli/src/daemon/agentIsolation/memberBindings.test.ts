import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveAgentIsolationMemberIdentity } from './provisioning';
import { writeFileAtomically } from '@/utils/fs/writeJsonAtomic';
import { readAgentIsolationMemberBinding, readProvisionedRequesterAccounts, writeAgentIsolationMemberBinding } from './memberBindings';

describe.skipIf(process.platform !== 'linux')('private native member reverse bindings', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'happier-member-binding-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const identity = () => ({ ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home-binding',
    requester: { serverId: 'retained-profile', accountId: 'member-binding', machineId: 'machine-binding', installationId: 'install-binding' } }),
    agentUid: 2401, agentGid: 2401 });

  it('retains the exact minimal projection, skips an equal retry, and refuses UID reassociation without overwriting', async () => {
    // Constructed native observation; this tests the real private-file boundary,
    // not native-user readiness (covered by native identity owner tests).
    const observed = identity();
    expect(await readAgentIsolationMemberBinding(directory, observed)).toBeNull();
    await writeAgentIsolationMemberBinding(directory, observed);
    const path = join(directory, 'agent-isolation', 'members', `${observed.digest}.json`);
    const before = await lstat(path);
    await writeAgentIsolationMemberBinding(directory, observed);
    expect((await lstat(path)).ino).toBe(before.ino);
    const value = await readAgentIsolationMemberBinding(directory, observed);
    expect(value).toEqual({ homeServerIdentityId: observed.homeServerIdentityId, accountId: observed.requester.accountId,
      machineId: observed.requester.machineId, installationId: observed.requester.installationId,
      username: observed.username, uid: 2401, home: observed.home });
    const bytes = await readFile(path, 'utf8');
    await expect(writeAgentIsolationMemberBinding(directory, { ...observed, agentUid: 2402 })).rejects.toMatchObject({
      code: 'agent_isolation_unavailable', details: { phase: 'native_identity_binding' } });
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('refuses another qualified Account using a UID reserved by a retained private binding', async () => {
    const first = identity();
    await writeAgentIsolationMemberBinding(directory, first);
    const firstPath = join(directory, 'agent-isolation', 'members', `${first.digest}.json`);
    const firstBytes = await readFile(firstPath, 'utf8');
    const second = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: first.homeServerIdentityId,
      requester: { ...first.requester, accountId: 'another-member' } }), agentUid: 2401, agentGid: 2401 };
    await expect(writeAgentIsolationMemberBinding(directory, second)).rejects.toMatchObject({
      code: 'agent_isolation_unavailable', details: { phase: 'native_identity_binding' } });
    expect(await readFile(firstPath, 'utf8')).toBe(firstBytes);
    expect(await readAgentIsolationMemberBinding(directory, second)).toBeNull();
    const distinct = { ...second, agentUid: 2402, agentGid: 2402 };
    await writeAgentIsolationMemberBinding(directory, distinct);
    expect(await readAgentIsolationMemberBinding(directory, distinct)).toMatchObject({ accountId: 'another-member', uid: 2402 });
    expect(await readFile(firstPath, 'utf8')).toBe(firstBytes);
  });

  it('refuses a new binding while another retained file cannot prove private UID custody', async () => {
    const first = identity();
    await writeAgentIsolationMemberBinding(directory, first);
    const firstPath = join(directory, 'agent-isolation', 'members', `${first.digest}.json`);
    const firstBytes = await readFile(firstPath, 'utf8');
    await chmod(firstPath, 0o644);
    const second = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: first.homeServerIdentityId,
      requester: { ...first.requester, accountId: 'another-member' } }), agentUid: 2402, agentGid: 2402 };
    await expect(writeAgentIsolationMemberBinding(directory, second)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(await readFile(firstPath, 'utf8')).toBe(firstBytes);
    expect(await readAgentIsolationMemberBinding(directory, second)).toBeNull();
  });

  it('refuses nonprivate files and linked paths instead of adopting their association', async () => {
    const observed = identity();
    await writeAgentIsolationMemberBinding(directory, observed);
    const path = join(directory, 'agent-isolation', 'members', `${observed.digest}.json`);
    await chmod(path, 0o644);
    await expect(readAgentIsolationMemberBinding(directory, observed)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    const other = await mkdtemp(join(directory, 'foreign-'));
    await mkdir(join(other, 'agent-isolation'), { mode: 0o700 });
    await symlink(join(directory, 'agent-isolation', 'members'), join(other, 'agent-isolation', 'members'));
    await expect(readAgentIsolationMemberBinding(other, observed)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });

  it('preserves canonical uncommitted staging bytes while allowing an exact interrupted-setup retry', async () => {
    const first = identity();
    await writeAgentIsolationMemberBinding(directory, first);
    const root = join(directory, 'agent-isolation', 'members');
    let stagedPath = '', entered!: () => void, release!: () => void;
    const staged = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    // The real atomic producer names/stages the file. A held pre-commit edge
    // represents the uncommitted bytes retained if its process is interrupted.
    const pending = writeFileAtomically({ path: join(root, 'uncommitted-destination.json'),
      writeTemporaryFile: async path => { stagedPath = path; await writeFile(path, 'partial-binding', { mode: 0o600 }); entered(); },
      prepareCommit: async () => { await hold; throw new Error('Test stops before committed publication'); } });
    const settled = pending.catch(() => undefined);
    try {
      await staged;
      await writeAgentIsolationMemberBinding(directory, first);
      expect(await readFile(stagedPath, 'utf8')).toBe('partial-binding');
      expect(await readAgentIsolationMemberBinding(directory, first)).toMatchObject({ uid: 2401 });
    } finally { release(); await settled; }
  });

  it('refuses malformed committed digest bindings rather than mistaking them for staging', async () => {
    const first = identity();
    await writeAgentIsolationMemberBinding(directory, first);
    const root = join(directory, 'agent-isolation', 'members');
    const committed = join(root, `${'f'.repeat(64)}.json`);
    await writeFile(committed, 'partial-binding', { mode: 0o600 });
    await expect(writeAgentIsolationMemberBinding(directory, first)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(await readFile(committed, 'utf8')).toBe('partial-binding');
    expect(await readAgentIsolationMemberBinding(directory, first)).toMatchObject({ uid: 2401 });
  });

  it('reports incomplete local census for malformed retained state instead of certifying an empty audience', async () => {
    const root = join(directory, 'agent-isolation', 'members');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, `${'a'.repeat(64)}.json`), '{}', { mode: 0o600 });
    expect(await readProvisionedRequesterAccounts({ activeServerDir: directory,
      homeServerIdentityId: 'home-binding', machineId: 'machine-binding', installationId: 'install-binding' }))
      .toEqual({ accountIds: [], coverage: 'unknown' });
  });

  it('retains a verified binding subject for exact cleanup even when its native account is missing', async () => {
    const observed = identity();
    await writeAgentIsolationMemberBinding(directory, observed);
    const census = await readProvisionedRequesterAccounts({ activeServerDir: directory,
      homeServerIdentityId: observed.homeServerIdentityId, machineId: observed.requester.machineId,
      installationId: observed.requester.installationId }, {
      observe: async step => ({ stepId: step.id, status: 'drifted', facts: { present: false } }),
    });
    expect(census).toEqual({ accountIds: [observed.requester.accountId], coverage: 'unknown' });
  });
});
