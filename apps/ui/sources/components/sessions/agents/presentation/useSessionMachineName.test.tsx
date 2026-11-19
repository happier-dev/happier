import { afterEach, expect, it } from 'vitest';

import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';

import { useSessionMachineName } from './useSessionMachineName';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });

/** The name as read on screen: the word joiners that keep a hyphenated name on one line have no glyph. */
const visible = (name: string | null) => name?.replace(/\u2060/g, '') ?? null;

it('names the machine a Session ran on from the Session itself when its Machine record is not loaded, as the Session view and its Work rows do', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    storage.getState().applySessions([createSessionFixture({
        id: 'lead', metadata: { ...createSessionFixture().metadata!, host: 'ubuntu-02' },
    })]);
    const hook = await renderHook(() => useSessionMachineName('lead', serverId));
    expect(visible(hook.getCurrent())).toBe('ubuntu-02');
});

it('keeps the Session recorded host while its Machine record is still hydrating its names, never a placeholder in a sentence', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    storage.getState().applySessions([createSessionFixture({
        id: 'lead', metadata: { ...createSessionFixture().metadata!, host: 'ubuntu-02', machineId: 'm-hydrating' },
    })]);
    // Encrypted display metadata that has not been read yet: the Machine's own display name is "Loading…".
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'm-hydrating', metadata: null })] } });
    const hook = await renderHook(() => useSessionMachineName('lead', serverId));
    expect(visible(hook.getCurrent())).toBe('ubuntu-02');
});

it('keeps a hyphenated Machine name on one line inside a sentence, so the line wraps before it (LABPARITY-ACCEPT-F fix 7)', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    storage.getState().applySessions([createSessionFixture({
        id: 'lead', metadata: { ...createSessionFixture().metadata!, host: 'NLDW4-5-40-40' },
    })]);
    const hook = await renderHook(() => useSessionMachineName('lead', serverId));
    const name = hook.getCurrent();
    expect(visible(name)).toBe('NLDW4-5-40-40');
    // No line-break opportunity after any hyphen inside the name.
    expect(name).not.toMatch(/-(?!\u2060)/);
});
