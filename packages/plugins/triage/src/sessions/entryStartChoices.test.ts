import { describe, expect, it, vi } from 'vitest';
import type { TriageActionV1 } from '../settings/actions.js';
import {
    readTriageEntrySessionStartTargetV1,
    readTriageRecentSessionsV1,
    type TriageEntrySessionStartChoicesHostV1,
} from './entryStartChoices.js';

const ACTION = {
    actionId: 'start', label: 'Start', enabled: true, appliesTo: ['other'],
    profileId: null, workspaceMode: 'reference_only',
    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
} satisfies TriageActionV1;

function fixture(options: { preferred?: string; machineAvailable?: boolean } = {}) {
    const executeAction = vi.fn(async (action: string) => {
        if (action === 'sessions.spawn.profiles.list') return { items: [{ id: 'profile', name: 'Work',
            placement: { fixed: { serverId: 'home-b', machineId: 'machine-b' } },
            ...(options.preferred === undefined ? {} : { preferredAgentTargetKey: options.preferred }),
        }] };
        if (action === 'projects.list') return { items: [], truncated: false };
        if (action === 'agents.backends.list') return { defaultTargetKey: 'backend:claude', items: [
            { targetKey: 'backend:claude', label: 'Claude Code', enabled: true,
                identity: { pluginId: 'happier.claude', localId: 'claude' } },
            { targetKey: 'backend:codex', label: 'Codex', enabled: true,
                identity: { pluginId: 'happier.codex', localId: 'codex' } },
        ] };
        if (action === 'session.list') return { sessions: [
            { id: 'same-id', serverId: 'home-b', title: 'Investigate sign in', active: false,
                presence: null, updatedAt: 20, locationLabel: 'Work laptop' },
            { id: 'same-id', serverId: 'home-a', title: 'Review parser', active: true,
                presence: null, updatedAt: 10 },
        ], nextCursor: 'more', hasNext: true };
        throw new Error(`Unexpected host Action ${action}`);
    });
    const readMachineDisplayName = vi.fn(async () => options.machineAvailable === false
        ? { status: 'unavailable' } : { status: 'ready', displayName: 'Work laptop' });
    // Genuine host transport boundary; the deterministic Triage owners run unchanged.
    const host = { executeAction, readMachineDisplayName } as unknown as TriageEntrySessionStartChoicesHostV1;
    return { host, executeAction, readMachineDisplayName };
}

describe('the Start split consumes the existing Agent, placement and Session owners', () => {
    it('shows the actual default Agent and names only the Machine the placement owner resolved', async () => {
        const { host, executeAction, readMachineDisplayName } = fixture();
        const defaults = await readTriageEntrySessionStartTargetV1(host, { action: ACTION });
        expect(defaults).toMatchObject({ status: 'ready', agent: { label: 'Claude Code' }, machine: null });
        expect(readMachineDisplayName).not.toHaveBeenCalled();

        const pinned = await readTriageEntrySessionStartTargetV1(host, { action: { ...ACTION, profileId: 'profile' } });
        expect(pinned).toMatchObject({ status: 'ready', agent: { label: 'Claude Code' },
            machine: { label: 'Work laptop', executionTarget: { serverId: 'home-b', machineId: 'machine-b' } } });
        expect(readMachineDisplayName).toHaveBeenCalledWith({ serverId: 'home-b', machineId: 'machine-b' }, undefined);
        expect(executeAction.mock.calls.filter(([id]) => id === 'session.list')).toHaveLength(0);
    });

    it('keeps profile preference and unavailable Machine labels honest', async () => {
        const { host } = fixture({ preferred: 'backend:codex', machineAvailable: false });
        expect(await readTriageEntrySessionStartTargetV1(host, { action: { ...ACTION, profileId: 'profile' } }))
            .toMatchObject({ status: 'ready', agent: { label: 'Codex' }, machine: null });
    });

    it('does no Session read while closed, and preserves resumable summary addresses and continuation when opened', async () => {
        const { host, executeAction } = fixture();
        expect(await readTriageRecentSessionsV1(host, false)).toEqual({ status: 'idle' });
        expect(executeAction).not.toHaveBeenCalled();
        const result = await readTriageRecentSessionsV1(host, true);
        expect(executeAction).toHaveBeenCalledExactlyOnceWith('session.list', { view: 'summary', resumableOnly: true }, undefined);
        expect(result).toMatchObject({ status: 'ready', hasMore: true, items: [
            { id: 'same-id', serverId: 'home-b', title: 'Investigate sign in' },
            { id: 'same-id', serverId: 'home-a', title: 'Review parser' },
        ] });
    });

    it('settles a failed Session read without retrying or presenting an empty successful list', async () => {
        const { host, executeAction } = fixture();
        executeAction.mockRejectedValueOnce(new Error('Home unavailable'));
        expect(await readTriageRecentSessionsV1(host, true)).toEqual({ status: 'unavailable' });
        expect(executeAction).toHaveBeenCalledTimes(1);
    });
});
