import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import { listMachinesForVoiceTool } from './machinesList';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
beforeEach(async () => {
    account = await createVoiceSettingsAccountTestHarness(settingsDefaults);
    onTestFinished(account.dispose);
});

afterEach(clearMachineRequestReachabilityForTest);

it('retains a shared Use target installation in the Action inventory without stored content', async () => {
    const machine = createMachineFixture({ id: 'shared', installationId: 'other-installation',
        access: { custodian: { accountId: 'other-owner', displayName: 'Owner' }, role: 'use',
            resourceMode: 'e2ee', accessState: 'key_pending' } });
    const { serverId } = account.scope;
    storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const result = await listMachinesForVoiceTool({ purpose: 'input', serverId });
    expect(result).toMatchObject({ items: [{ machineId: 'shared', installationId: 'other-installation' }] });
    expect(result).not.toHaveProperty('items.0.metadata');
    expect(result).not.toHaveProperty('items.0.dataEncryptionKey');
});

it('keeps retained input presence unknown until the exact Account observes the Machine, including a fresh offline row', async () => {
    const machine = createMachineFixture({ id: 'voice-machine', activeAt: Date.now() });
    const { serverId } = account.scope;
    storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    withdrawMachinePresenceForScope(account.scope);
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({ items: [{ machineId: machine.id, presence: 'unknown' }] });
    captureMachinePresenceObservation({ ...account.scope, accountId: 'another-account' })([machine.id]);
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({ items: [{ presence: 'unknown' }] });
    machine.active = false;
    machine.activeAt = Date.now() - 60_001;
    captureMachinePresenceObservation(account.scope)([machine.id]);
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({ items: [{ presence: 'offline' }] });
});

it('provides decoded platform facts to Action input consumers without guessing an absent architecture', async () => {
    const metadata = createMachineFixture().metadata;
    if (!metadata) throw new Error('Expected canonical Machine metadata fixture');
    const known = createMachineFixture({ id: 'known', metadata: { ...metadata, host: 'known.local', platform: 'linux', arch: 'x64' } });
    const unknown = createMachineFixture({ id: 'unknown', metadata: { ...metadata, host: 'unknown.local', platform: 'win32', arch: undefined } });
    const { serverId } = account.scope;
    storage.setState({ machineListByServerId: { [serverId]: [known, unknown] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({ items: [
        { machineId: known.id, platform: 'linux', arch: 'x64' },
        { machineId: unknown.id, platform: 'win32', arch: null },
    ] });
});

it('presents input machines as unavailable after request failure while retaining the inventory', async () => {
    const machine = createMachineFixture({ id: 'voice-machine', activeAt: Date.now() });
    const { serverId } = account.scope;
    storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({ items: [{ machineId: machine.id, presence: 'online' }] });
    recordMachineRequestFailed({ ...account.scope, machineId: machine.id });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({
        items: [{ machineId: machine.id, presence: 'offline' }],
    });
});

it('says which input machines carry a real name, so a checkout on any other machine reads as unlisted like the Projects list', async () => {
    const named = createMachineFixture({ id: 'named', metadata: { ...createMachineFixture().metadata!, displayName: 'Build box' } });
    const sameName = createMachineFixture({ id: 'same-name', metadata: { ...createMachineFixture().metadata!, displayName: 'Build box', host: 'other.local' } });
    const runner = createMachineFixture({ id: 'runner', kind: 'ephemeral_session_runner', metadata: { ...createMachineFixture().metadata!, displayName: 'Temp runner' } });
    const removed = createMachineFixture({ id: 'removed', revokedAt: 5, metadata: { ...createMachineFixture().metadata!, displayName: 'Old laptop' } });
    const hydrating = createMachineFixture({ id: 'hydrating', metadata: null, availability: undefined });
    const { serverId } = account.scope;
    storage.setState({ machineListByServerId: { [serverId]: [named, sameName, runner, removed, hydrating] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const result = await listMachinesForVoiceTool({ purpose: 'input', serverId }) as { items: readonly Record<string, unknown>[]; unlistedLabel?: string };
    const byId = new Map(result.items.map(item => [item.machineId, item]));
    // Named and told apart among the machines the Projects list shows; hidden or still-loading rows never pass for a name.
    expect(byId.get('named')).toMatchObject({ named: true, label: 'Build box · tester.local' });
    expect(byId.get('same-name')).toMatchObject({ named: true, label: 'Build box · other.local' });
    for (const id of ['runner', 'removed', 'hydrating']) expect(byId.get(id), id).toMatchObject({ named: false });
    expect(result.unlistedLabel).toBe('Unlisted machine');
});
