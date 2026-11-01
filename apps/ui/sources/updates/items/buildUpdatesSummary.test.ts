import { describe, expect, it } from 'vitest';

import { buildUpdatesSummary, isSameUpdatesSummary, planUpdateAll } from './buildUpdatesSummary';
import type { UpdateItem } from './updateItem';

function item(overrides: Partial<UpdateItem> & Pick<UpdateItem, 'id'>): UpdateItem {
    return {
        subject: { kind: 'happier-cli' },
        machineId: 'm1',
        title: overrides.id,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        state: 'upToDate',
        progressPercent: null,
        step: null,
        managedBy: 'happier',
        action: { kind: 'none' },
        failure: null,
        skipped: false,
            ...overrides,
    };
}

const available = (id: string, extra: Partial<UpdateItem> = {}) => item({ id, state: 'available', latestVersion: '1.1.0', action: { kind: 'run', verb: 'update' }, ...extra });

describe('buildUpdatesSummary', () => {
    it('counts only supported, authorized updates — not skipped, offline, or installed-by-you rows', () => {
        const summary = buildUpdatesSummary([
            available('a'),
            available('b'),
            available('skipped', { skipped: true }),
            item({ id: 'own', state: 'available', managedBy: 'user', action: { kind: 'manual', command: 'npm i -g x' } }),
            item({ id: 'away', state: 'offline', latestVersion: '1.1.0' }),
        ]);
        expect(summary).toMatchObject({ actionableCount: 2, phase: 'available', visible: true });
    });

    it('does not call zero actionable "up to date" when something could not be checked or is offline', () => {
        expect(buildUpdatesSummary([item({ id: 'a' }), item({ id: 'b' })])).toMatchObject({ phase: 'none', status: 'upToDate', visible: false });
        expect(buildUpdatesSummary([item({ id: 'a' }), item({ id: 'b', state: 'unknown' })]).status).toBe('unknown');
        expect(buildUpdatesSummary([item({ id: 'a' }), item({ id: 'b', state: 'offline' })]).status).toBe('offline');
        expect(buildUpdatesSummary([item({ id: 'a', state: 'checking' })]).status).toBe('checking');
    });

    it('ranks one phase for the pill and the header: required, a failure, updates to take, then running, then restart', () => {
        const required = item({ id: 'r', state: 'required', action: { kind: 'run', verb: 'update' } });
        const running = item({ id: 'run', state: 'running' });
        const failed = item({ id: 'f', state: 'failed', action: { kind: 'run', verb: 'retry' } });
        const ready = item({ id: 'app', state: 'ready', action: { kind: 'run', verb: 'restart' } });
        expect(buildUpdatesSummary([available('a'), required, running]).phase).toBe('required');
        expect(buildUpdatesSummary([available('a'), running, failed]).phase).toBe('failed');
        // A remote machine reconnecting does not turn "3 updates available" into "Updating…".
        expect(buildUpdatesSummary([available('a'), running]).phase).toBe('available');
        expect(buildUpdatesSummary([running, ready]).phase).toBe('running');
        expect(buildUpdatesSummary([ready]).phase).toBe('ready');
        expect(buildUpdatesSummary([available('a'), failed, failed, running])).toMatchObject({ failedCount: 2, runningCount: 1 });
    });
});

describe('buildUpdatesSummary — completion not yet seen', () => {
    it('shows "Updated" once an update finished while Updates was closed, and only when nothing else needs attention', () => {
        const done = new Map([['m1:agent', 'done' as const]]);
        expect(buildUpdatesSummary([item({ id: 'm1:agent' })], done)).toMatchObject({ phase: 'completed', visible: true, actionableCount: 0 });
        expect(buildUpdatesSummary([item({ id: 'm1:agent' }), item({ id: 'x', state: 'running' })], done).phase).toBe('running');
        expect(buildUpdatesSummary([item({ id: 'm1:agent' })], new Map()).phase).toBe('none');
    });

    it('a remote update counts as finished only once the machine reports the new version', () => {
        const pending = new Map([['m2:cli', 'pendingRemote' as const]]);
        expect(buildUpdatesSummary([item({ id: 'm2:cli', state: 'running', step: 'reconnecting' })], pending).phase).toBe('running');
        expect(buildUpdatesSummary([item({ id: 'm2:cli', state: 'unknown', updateCompleted: true })], pending).phase).toBe('completed');
        expect(buildUpdatesSummary([item({ id: 'm2:cli', state: 'upToDate' })], pending).phase).toBe('none');
    });
});

describe('isSameUpdatesSummary', () => {
    it('compares every field, so a change in the failed or running count reaches the entries', () => {
        const a = buildUpdatesSummary([item({ id: 'f', state: 'failed', action: { kind: 'run', verb: 'retry' } })]);
        const b = buildUpdatesSummary([
            item({ id: 'f', state: 'failed', action: { kind: 'run', verb: 'retry' } }),
            item({ id: 'g', state: 'failed', action: { kind: 'run', verb: 'retry' } }),
        ]);
        expect(a.phase).toBe(b.phase);
        expect(isSameUpdatesSummary(a, b)).toBe(false);
        expect(isSameUpdatesSummary(a, buildUpdatesSummary([item({ id: 'f', state: 'failed', action: { kind: 'run', verb: 'retry' } })]))).toBe(true);
    });
});

describe('planUpdateAll', () => {
    it('per machine: helpers, then agents, then the Happier CLI last; the app downloads and never restarts', () => {
        const plan = planUpdateAll([
            available('app', { subject: { kind: 'app' }, machineId: null }),
            available('m1:cli', { subject: { kind: 'happier-cli' }, machineId: 'm1' }),
            available('m1:agent', { subject: { kind: 'agent-cli', agentId: 'claude' }, machineId: 'm1' }),
            available('m1:gh', { subject: { kind: 'installable', key: 'gh' }, machineId: 'm1' }),
            available('m2:cli', { subject: { kind: 'happier-cli' }, machineId: 'm2' }),
            available('m2:own', { subject: { kind: 'agent-cli', agentId: 'codex' }, machineId: 'm2', managedBy: 'user', action: { kind: 'manual', command: null } }),
            item({ id: 'm3:cli', machineId: 'm3', state: 'offline', latestVersion: '1.1.0' }),
        ]);
        expect(plan.machines).toEqual([
            { machineId: 'm1', itemIds: ['m1:gh', 'm1:agent', 'm1:cli'] },
            { machineId: 'm2', itemIds: ['m2:cli'] },
        ]);
        expect(plan.appItemId).toBe('app');
        expect(plan.total).toBe(5);
    });
});
