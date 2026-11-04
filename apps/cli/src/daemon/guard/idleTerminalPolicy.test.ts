import { afterEach, describe, expect, it } from 'vitest';
import { createIdleTerminalPolicyFixture } from './idleTerminalPolicy.testkit';
const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
const custody = { ...target, requesterAccountId: 'alice', kind: 'machine' as const, rootPath: '/project' };
const requester = { ...target, accountId: 'alice', isCustodian: false };
const epoch = Date.UTC(2026, 9, 11);

const fixture = () => createIdleTerminalPolicyFixture(releases);

describe('Idle terminal policy at the actual PTY owner', () => {
  it('reads the actual shell foreground fact behind a native PTY relay, not its carrier', async () => {
    const f = await createIdleTerminalPolicyFixture(releases, { relay: true }); f.enable();
    await f.terminals.ensure({ terminalKey: 'relay-shell', cwd: '/project', custody }); f.now(120_000);
    await (await f.readPlan()).run?.();
    expect(f.terminals.list()).toEqual([]);
    expect(f.processes[0]?.kills).toBe(1);
  });
  it('publishes a running-command warning before closing even when its configured lead is zero', async () => {
    const f = await fixture(); f.enable(0); f.foreground(102);
    await f.terminals.ensure({ terminalKey: 'zero-lead', cwd: '/project', custody }); f.now(120_000);
    const reader = new AbortController();
    const warning = await f.readPlan(new AbortController().signal, reader.signal);
    reader.abort();
    // Completing the temporary read does not retire the returned actuator.
    await warning.run?.();
    expect(f.terminals.list()).toHaveLength(1);
    expect(f.terminals.list()[0]).toMatchObject({ terminalGuardStateV1: { kind: 'stopping', stopAt: epoch + 120_000 } });
    await (await f.readPlan()).run?.();
    expect(f.terminals.list()).toEqual([]);
  });
  it('releases a cancelled native reader without cancelling its producer or closing its captured terminal', async () => {
    const f = await fixture(); f.enable();
    await f.terminals.ensure({ terminalKey: 'cancelled', cwd: '/project', custody });
    await f.ownership.readOwners({ freshness: 'fresh' });
    const native = f.holdNativeRead(); const controller = new AbortController(); const actuator = new AbortController();
    let returned = false;
    const reading = f.readPlan(actuator.signal, controller.signal).then(plan => { returned = true; return plan; });
    await native.entered; controller.abort();
    // The next event-loop turn follows the abort's promise continuations, not
    // completion of the deliberately held genuine native boundary.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(true);
    expect(actuator.signal.aborted).toBe(false);
    expect(await reading).toEqual({});
    expect(f.terminals.list()).toHaveLength(1);
    native.release(); await native.completed;
    expect(f.processes[0]?.kills).toBe(0);
  });

  it('clears an unavailable notification warning and suppresses its due retry until an existing external edge', async () => {
    const f = await fixture(); f.enable(); f.foreground(102); f.notificationCatalogReady(false);
    await f.terminals.ensure({ terminalKey: 'notification-unavailable', cwd: '/project', custody }); f.now(90_000);
    await expect((await f.readPlan()).run?.()).rejects.toMatchObject({ name: 'NotificationChannelCatalogUnavailableError' });
    expect(f.terminals.list()[0]).not.toHaveProperty('terminalGuardStateV1');
    expect(await f.readPlan()).toEqual({});
    f.notificationCatalogReady(true); f.owner.refreshOnTick();
    await (await f.readPlan()).run?.();
    expect(f.terminals.list()[0]).toMatchObject({ terminalGuardStateV1: { stopAt: epoch + 120_000 } });
  });

  it('warns for a silent foreground command, honors exact Keep running and reanchors on real I/O', async () => {
    const f = await fixture(); f.foreground(102); f.enable();
    const terminal = await f.terminals.ensure({ terminalKey: 'command', cwd: '/project', custody });
    if (!terminal.ok) throw new Error('Expected captured PTY');
    expect((await f.readPlan()).nextAt).toBe(epoch + 90_000);
    f.now(90_000); await (await f.readPlan()).run?.();
    expect(f.terminals.list()[0]).toMatchObject({ terminalGuardStateV1: { kind: 'stopping', stopAt: epoch + 120_000 } });
    expect(f.deliveries[0]?.[2]).toMatchObject({ actions: { keepRunning: { input: { terminalKey: 'command' } } } });
    expect(await f.owner.keepRunning({ terminalKey: 'command' }, { ...requester, installationId: 'old' })).toEqual({ status: 'not_pending' });
    expect(await f.owner.keepRunning({ terminalKey: 'command' }, requester)).toEqual({ status: 'kept' });
    expect(f.terminals.list()[0]).not.toHaveProperty('terminalGuardStateV1');
    expect((await f.readPlan()).nextAt).toBe(epoch + 180_000);
    f.now(180_000); await (await f.readPlan()).run?.();
    expect(f.terminals.list()[0]).toMatchObject({ terminalGuardStateV1: { stopAt: epoch + 210_000 } });
    f.now(190_000); f.processes[0]!.output('actual output');
    expect(f.terminals.list()[0]).not.toHaveProperty('terminalGuardStateV1');
    expect((await f.readPlan()).nextAt).toBe(epoch + 280_000);
    f.now(280_000); await (await f.readPlan()).run?.();
    f.now(310_000); await (await f.readPlan()).run?.();
    expect(f.terminals.list()).toEqual([]);
    expect((await f.activityLog.list({ range: 'today' })).entries.map(row => row.kind)).toEqual(['closed_terminal', 'kept_running']);
  });

  it('freshly rejects a stale close after command evidence becomes unknown, and excludes finite work', async () => {
    const f = await fixture(); f.enable();
    const terminal = await f.terminals.ensure({ terminalKey: 'prompt', cwd: '/project', custody });
    await f.terminals.ensure({ terminalKey: 'finite', cwd: '/project', custody, holdUntilExit: true, launchProcess: { file: '/tool', args: [] } });
    f.now(120_000);
    const stale = await f.readPlan();
    f.foreground(undefined);
    await stale.run?.();
    expect(f.terminals.list()).toHaveLength(2);
    expect((await f.activityLog.list({ range: 'today' })).entries).toEqual([]);
    expect(await f.readPlan()).toEqual({});
    f.foreground(101); await (await f.readPlan()).run?.();
    expect(f.terminals.list().map(row => row.terminalKey)).toEqual(['finite']);
    expect(terminal.ok).toBe(true);
  });

  it.each([
    { name: 'Machine', capturedCustody: custody },
    { name: 'Project', capturedCustody: { ...target, requesterAccountId: 'alice', rootPath: '/project', workspaceRefId: 'accepted-workspace', projectKey: 'project' } },
  ])('closes a due $name prompt through the PTY owner and Activity without an automatic-action dot', async ({ capturedCustody }) => {
    const f = await fixture();
    const terminal = await f.terminals.ensure({ terminalKey: 'original-key', cwd: '/project', custody: capturedCustody });
    expect(terminal.ok).toBe(true);
    f.now(120_000);
    expect(await f.readPlan()).toEqual({});
    f.enable();
    await (await f.readPlan()).run?.();
    expect(f.terminals.list()).toEqual([]);
    expect(f.processes[0]?.kills).toBe(1);
    expect(f.endedRoots).toMatchObject([{ owner: { kind: 'terminal' }, live: false }]);
    const owners = await f.ownership.readOwners({ freshness: 'fresh' });
    expect(owners.status === 'ok' && owners.rows.some(row => row.pid === 104 && row.ownerEnded)).toBe(true);
    const activity = await f.activityLog.list({ range: 'today', requester: { ...target, accountId: 'alice' } });
    expect(activity.entries).toMatchObject([{ kind: 'closed_terminal', rule: 'idle_terminals', outcome: 'done',
      subject: { kind: 'terminal', terminalKey: 'original-key', idleMs: 120_000 },
      wayBack: [{ label: 'reopen', actionId: 'machines.terminal.open', input: { machineId: 'machine', terminalKey: 'original-key', cwd: '/project' } }],
    }]);
    expect(activity.entries[0]?.wayBack?.[0]?.input).not.toHaveProperty('serverId');
    if ('workspaceRefId' in capturedCustody) expect(activity.entries[0]?.wayBack?.[0]?.input).toMatchObject({
      workspace: { serverId: target.serverId, machineId: target.machineId, workspaceId: 'accepted-workspace', rootPath: '/project' },
    });
    expect(f.summary.getSummary()?.lastAutomaticAction).toBeUndefined();
  });
});
