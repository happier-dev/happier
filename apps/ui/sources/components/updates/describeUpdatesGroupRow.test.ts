import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => params
            ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
            : key,
    });
});

import type { UpdateItem } from '@/updates/items/updateItem';
import type { UpdatesGroup } from '@/updates/useUpdatesContentModel';

import { describeUpdatesGroupRow } from './describeUpdatesGroupRow';

const cli: UpdateItem = {
    id: 'studio:happier-cli',
    subject: { kind: 'happier-cli' },
    machineId: 'studio',
    title: 'Happier CLI',
    currentVersion: '0.2.12',
    latestVersion: '0.2.14',
    state: 'available',
    progressPercent: null,
    step: null,
    managedBy: 'happier',
    action: { kind: 'run', verb: 'update' },
    failure: null,
    skipped: false,
};
const codex: UpdateItem = { ...cli, id: 'studio:agent:codex', subject: { kind: 'agent-cli', agentId: 'codex' }, title: 'Codex' };
const current = (item: UpdateItem): UpdateItem => ({ ...item, state: 'upToDate', action: { kind: 'none' }, latestVersion: item.currentVersion });

function machine(items: UpdateItem[], overrides: Partial<UpdatesGroup> = {}): UpdatesGroup {
    return { id: 'machine:studio', kind: 'machine', machineName: 'Studio', machineId: 'studio', online: true, lastSeenAt: null, items, ...overrides };
}

describe('describeUpdatesGroupRow — one row per machine, one state, at most one action', () => {
    it('is quiet when everything on the machine is current', () => {
        expect(describeUpdatesGroupRow(machine([current(cli), current(codex)]))).toEqual({
            title: 'Studio',
            status: 'updates.settingsSubtitle.upToDate',
            tone: 'ok',
            action: null,
        });
    });


    it('keeps a cached manual CLI check explicit in the machine summary and visible on the page', async () => {
        const { partitionUpdatesPageGroups } = await import('./describeUpdatesGroupRow');
        const cached: UpdateItem = {
            ...cli, state: 'unknown', cachedRelease: { channel: 'dev' },
            action: { kind: 'manual', command: 'hdev self update' },
        };
        const group = machine([cached]);
        expect(describeUpdatesGroupRow(group).status).toContain('updates.row.cachedReleaseChannel');
        expect(describeUpdatesGroupRow(group).action).toBeNull();
        expect(partitionUpdatesPageGroups([group]).sections).toEqual([group]);
    });

    it('names the one waiting update and runs exactly that item', () => {
        const row = describeUpdatesGroupRow(machine([cli, current(codex)]));
        expect(row.status).toBe('Happier CLI · updates.row.versionChange(from=0.2.12,to=0.2.14)');
        expect(row.tone).toBe('info');
        expect(row.action).toEqual({ kind: 'item', item: cli, label: 'updates.action.update' });
    });

    it('counts several waiting updates and updates the whole machine in one action', () => {
        const row = describeUpdatesGroupRow(machine([cli, codex]));
        expect(row.status).toBe('updates.summary.available(count=2)');
        expect(row.action).toEqual({ kind: 'group', label: 'updates.action.update' });
    });

    it('includes the canonical CLI session note for the items its action runs, including this computer', () => {
        const group = machine([cli, codex], { kind: 'thisComputer', machineId: 'different-group-id' });
        expect(describeUpdatesGroupRow(group, { sessionsRunningOn: new Set(['studio']) }).status)
            .toContain('updates.row.restartsService');
        expect(describeUpdatesGroupRow(group, { sessionsRunningOn: new Set(['different-group-id']) }).status)
            .not.toContain('updates.row.restartsService');
        expect(describeUpdatesGroupRow(machine([current(cli), codex]), { sessionsRunningOn: new Set(['studio']) }).status)
            .not.toContain('updates.row.restartsService');
        expect(describeUpdatesGroupRow(machine([{ ...cli, skipped: true }, codex]), { sessionsRunningOn: new Set(['studio']) }).status)
            .not.toContain('updates.row.restartsService');
    });

    it('says an offline machine is offline and when it was last seen, with nothing to press', () => {
        const row = describeUpdatesGroupRow(machine([{ ...cli, state: 'offline', action: { kind: 'none' } }], { online: false, lastSeenAt: 1_000 }), {
            formatLastSeen: (at) => `t${at}`,
        });
        expect(row).toEqual({
            title: 'Studio',
            status: 'updates.offline · status.lastSeen(time=t1000)',
            tone: 'off',
            action: null,
        });
    });

    it('shows an update in flight without an action, and a failure with its retry', () => {
        expect(describeUpdatesGroupRow(machine([{ ...cli, state: 'running', action: { kind: 'none' } }, codex])))
            .toMatchObject({ tone: 'pending', action: null });
        const failed: UpdateItem = { ...cli, state: 'failed', action: { kind: 'run', verb: 'retry' }, failure: { kind: 'message', message: 'npm exited 1' } };
        expect(describeUpdatesGroupRow(machine([failed, current(codex)]))).toEqual({
            title: 'Studio',
            status: 'Happier CLI · npm exited 1',
            tone: 'attention',
            action: { kind: 'item', item: failed, label: 'common.retry' },
        });
    });

    it('titles this app and this computer by what they are when they have no machine name', () => {
        const app: UpdateItem = { ...current(cli), id: 'app', subject: { kind: 'app' }, machineId: null, title: 'Happier' };
        expect(describeUpdatesGroupRow({ id: 'app', kind: 'app', machineName: null, machineId: null, online: true, lastSeenAt: null, items: [app] }).title)
            .toBe('updates.sections.thisApp');
        expect(describeUpdatesGroupRow(machine([current(cli)], { id: 'thisComputer', kind: 'thisComputer', machineName: null })).title)
            .toBe('updates.sections.thisComputer');
    });
});

describe('partitionUpdatesPageGroups — one quiet place for machines that cannot be updated now', () => {
    it('folds offline machines together and keeps this app, this computer and reachable machines as sections', async () => {
        const { partitionUpdatesPageGroups } = await import('./describeUpdatesGroupRow');
        const app: UpdatesGroup = { id: 'app', kind: 'app', machineName: null, machineId: null, online: true, lastSeenAt: null, items: [current(cli)] };
        const own: UpdatesGroup = machine([current(cli)], { id: 'thisComputer', kind: 'thisComputer', machineName: 'MacBook Pro', machineId: 'mbp' });
        const studio = machine([cli]);
        const devbox = machine([cli], { id: 'machine:devbox', machineName: 'devbox', machineId: 'devbox', online: false, lastSeenAt: 1 });
        const ci = machine([current(cli)], { id: 'machine:ci', machineName: 'ci-runner-2', machineId: 'ci', online: false });

        const parts = partitionUpdatesPageGroups([app, own, studio, devbox, ci]);

        expect(parts.sections.map((group) => group.id)).toEqual(['app', 'thisComputer', 'machine:studio']);
        expect(parts.offline.map((group) => group.id)).toEqual(['machine:devbox', 'machine:ci']);
    });
});

describe('partitionUncheckedItems — one cause is said once', () => {
    it('folds several tools that could not be checked into one group and keeps anything actionable as its own row', async () => {
        const { partitionUncheckedItems } = await import('./describeUpdatesGroupRow');
        const unchecked = (item: UpdateItem): UpdateItem => ({ ...item, state: 'unknown', latestVersion: null, action: { kind: 'none' } });
        const retryable: UpdateItem = { ...cli, id: 'studio:app', state: 'unknown', action: { kind: 'run', verb: 'retry' } };
        const gemini: UpdateItem = { ...codex, id: 'studio:agent:gemini', title: 'Gemini' };

        expect(partitionUncheckedItems([cli, unchecked(codex), retryable, unchecked(gemini)])).toEqual({
            rows: [cli, retryable],
            unchecked: [unchecked(codex), unchecked(gemini)],
        });
        // A single unchecked tool is just its row.
        expect(partitionUncheckedItems([cli, unchecked(codex)])).toEqual({ rows: [cli, unchecked(codex)], unchecked: [] });
    });
});

describe('partitionUpdatesPageGroups — quiet machines', () => {
    it('folds reachable machines with nothing to do into one place and keeps machines with an update, a failure or a newer version to install yourself', async () => {
        const { partitionUpdatesPageGroups } = await import('./describeUpdatesGroupRow');
        const own = (version: string): UpdateItem => ({ ...cli, managedBy: 'user', latestVersion: version, state: 'available', action: { kind: 'manual', command: 'npm i -g happier' } });
        const quiet = machine([current(cli)], { id: 'machine:quiet', machineName: 'quiet' });
        const ownCurrent = machine([own('0.2.12')], { id: 'machine:own-current', machineName: 'own-current' });
        const ownNewer = machine([own('0.2.16')], { id: 'machine:own-newer', machineName: 'own-newer' });
        const studio = machine([cli]);

        const parts = partitionUpdatesPageGroups([studio, quiet, ownCurrent, ownNewer]);

        expect(parts.sections.map((group) => group.id)).toEqual(['machine:studio', 'machine:own-newer']);
        expect(parts.quiet.map((group) => group.id)).toEqual(['machine:quiet', 'machine:own-current']);
    });
});
