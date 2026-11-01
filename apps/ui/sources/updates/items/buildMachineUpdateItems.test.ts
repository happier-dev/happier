import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import {
    buildAgentCliUpdateItem,
    buildInstallableUpdateItem,
    buildRemoteCliUpdateItem,
    buildThisComputerCliUpdateItem,
} from './buildMachineUpdateItems';
import { isUpdateItemActionable } from './updateItem';
import { buildUpdatesSummary } from './buildUpdatesSummary';

const IDLE_TASK = { running: false, step: null, errorMessage: null } as const;

describe('this computer — Happier CLI row', () => {
    it('offers the app-managed update and follows the shared run', () => {
        const facts = { currentVersion: '0.2.10', latestVersion: '0.2.11', managed: true, updateCommand: null };
        const available = buildThisComputerCliUpdateItem({ machineId: 'm1', title: 'Happier CLI', facts, task: IDLE_TASK });
        expect(available).toMatchObject({ state: 'available', action: { kind: 'run', verb: 'update' }, managedBy: 'happier' });
        expect(available && isUpdateItemActionable(available)).toBe(true);

        const running = buildThisComputerCliUpdateItem({
            machineId: 'm1', title: 'Happier CLI', facts, task: { running: true, step: 'restartingService', errorMessage: null },
        });
        expect(running).toMatchObject({ state: 'running', step: 'restartingService', action: { kind: 'none' } });

        const failed = buildThisComputerCliUpdateItem({
            machineId: 'm1', title: 'Happier CLI', facts, task: { running: false, step: null, errorMessage: 'The update didn’t finish.' },
        });
        expect(failed).toMatchObject({ state: 'failed', action: { kind: 'run', verb: 'retry' }, failure: { kind: 'message', message: 'The update didn’t finish.' } });
    });

    it('never offers to replace a CLI the person installed, and says up to date only when proven', () => {
        const own = buildThisComputerCliUpdateItem({
            machineId: 'm1', title: 'Happier CLI', task: IDLE_TASK,
            facts: { currentVersion: '0.2.10', latestVersion: '0.2.11', managed: false, updateCommand: 'npm install -g @happier-dev/cli' },
        });
        expect(own).toMatchObject({ managedBy: 'user', state: 'available', action: { kind: 'manual', command: 'npm install -g @happier-dev/cli' } });
        expect(own && isUpdateItemActionable(own)).toBe(false);

        const current = buildThisComputerCliUpdateItem({
            machineId: 'm1', title: 'Happier CLI', task: IDLE_TASK,
            facts: { currentVersion: '0.2.11', latestVersion: '0.2.11', managed: true, updateCommand: null },
        });
        expect(current?.state).toBe('unknown');

        const noAnswer = buildThisComputerCliUpdateItem({
            machineId: 'm1', title: 'Happier CLI', task: IDLE_TASK,
            facts: { currentVersion: '0.2.11', latestVersion: null, managed: true, updateCommand: null },
        });
        expect(noAnswer?.state).toBe('unknown');
    });
});

describe('another machine — Happier CLI row (K5)', () => {
    const k5 = {
        currentVersion: '0.2.9',
        latestVersion: '0.2.11',
        channel: 'stable' as const,
        installSource: 'managed' as const,
        updateCommand: 'happier self update',
        canUpdateRemotely: true,
        lastUpdate: null,
    };

    it('does not certify a cached current version as freshly up to date, and keeps the manual path', () => {
        const item = buildRemoteCliUpdateItem({
            machineId: 'windows', title: 'Happier CLI', online: true, platform: 'win32',
            happyCliVersion: '0.2.16-dev.9', remoteUpdateAdvertised: false, task: IDLE_TASK,
            facts: { ...k5, currentVersion: '0.2.16-dev.9', latestVersion: '0.2.16-dev.9',
                channel: 'dev', canUpdateRemotely: false, updateCommand: 'hdev self update' },
        });
        expect(item).toMatchObject({
            state: 'unknown', cachedRelease: { channel: 'dev' },
            action: { kind: 'manual', command: 'hdev self update' },
        });
        expect(isUpdateItemActionable(item)).toBe(false);
        expect(buildUpdatesSummary([item]).status).toBe('unknown');
    });

    it.each(['failed', 'rolledBack'] as const)('never offers a remote retry after %s when the CLI cannot update remotely', (outcome) => {
        const item = buildRemoteCliUpdateItem({
            machineId: 'windows', title: 'Happier CLI', online: true, platform: 'win32',
            happyCliVersion: k5.currentVersion, remoteUpdateAdvertised: null, task: IDLE_TASK,
            facts: { ...k5, canUpdateRemotely: false,
                lastUpdate: { targetVersion: '0.2.11', outcome, at: 1, message: null } },
        });
        expect(item).toMatchObject({ state: 'failed', action: { kind: 'manual', command: k5.updateCommand } });
    });

    it('offers Update only when the daemon advertises the remote kind; otherwise the command', () => {
        const advertised = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.9',
            facts: k5, remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(advertised).toMatchObject({ state: 'available', action: { kind: 'run', verb: 'update' } });

        const notAdvertised = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.9',
            facts: k5, remoteUpdateAdvertised: false, task: IDLE_TASK,
        });
        expect(notAdvertised).toMatchObject({ state: 'available', action: { kind: 'manual', command: 'happier self update' } });
        expect(isUpdateItemActionable(notAdvertised)).toBe(false);
    });

    it('degrades an older daemon to its version and the command, never to "up to date"', () => {
        const old = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'linux', happyCliVersion: '0.2.12',
            facts: null, remoteUpdateAdvertised: false, task: IDLE_TASK,
        });
        expect(old).toMatchObject({ state: 'unknown', currentVersion: '0.2.12', action: { kind: 'manual', command: 'happier self update' } });

        const windows = buildRemoteCliUpdateItem({
            machineId: 'm3', title: 'Happier CLI', online: true, platform: 'win32', happyCliVersion: '0.2.12',
            facts: null, remoteUpdateAdvertised: false, task: IDLE_TASK,
        });
        expect(windows.action).toEqual({ kind: 'manual', command: null });
    });

    it('keeps last-known versions offline, and reads the persisted outcome instead of guessing', () => {
        const offline = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: false, platform: 'darwin', happyCliVersion: '0.2.9',
            facts: k5, remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(offline).toMatchObject({ state: 'offline', currentVersion: '0.2.9', latestVersion: '0.2.11', action: { kind: 'none' } });
        expect(isUpdateItemActionable(offline)).toBe(false);

        const rolledBack = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.9',
            facts: { ...k5, lastUpdate: { targetVersion: '0.2.11', outcome: 'rolledBack', at: 1, message: null } },
            remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(rolledBack).toMatchObject({ state: 'failed', failure: { kind: 'rolledBack', kept: '0.2.9', target: '0.2.11' }, action: { kind: 'run', verb: 'retry' } });

        const failedSilently = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.9',
            facts: { ...k5, lastUpdate: { targetVersion: '0.2.11', outcome: 'failed', at: 1, message: null } },
            remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(failedSilently).toMatchObject({ state: 'failed', failure: { kind: 'message', message: 'updates.row.failedGeneric' }, action: { kind: 'run', verb: 'retry' } });

        const couldNotStart = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.9',
            facts: { ...k5, lastUpdate: { targetVersion: null, outcome: 'failed', at: 1, message: 'no release for this channel' } },
            remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(couldNotStart).toMatchObject({ state: 'failed', action: { kind: 'run', verb: 'retry' } });
        expect(couldNotStart.failure).toEqual({ kind: 'message', message: 'updates.row.couldNotStart:{"message":"no release for this channel"}' });

        const reconnecting = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.9',
            facts: { ...k5, lastUpdate: { targetVersion: '0.2.11', outcome: 'pendingReconnect', at: 1, message: null } },
            remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(reconnecting).toMatchObject({ state: 'running', step: 'reconnecting' });

        const landed = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.11',
            facts: { ...k5, currentVersion: '0.2.11', lastUpdate: { targetVersion: '0.2.11', outcome: 'pendingReconnect', at: 1, message: null } },
            remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(landed.state).toBe('unknown');
        expect(buildUpdatesSummary([landed], new Map([[landed.id, 'pendingRemote']])).phase).toBe('completed');
    });

    it('keeps an explicit failed outcome authoritative when the target binary is answering', () => {
        const item = buildRemoteCliUpdateItem({
            machineId: 'm2', title: 'Happier CLI', online: true, platform: 'darwin', happyCliVersion: '0.2.11',
            facts: { ...k5, currentVersion: '0.2.11', lastUpdate: { targetVersion: '0.2.11', outcome: 'failed', at: 2, message: 'Restoring the old daemon failed.' } },
            remoteUpdateAdvertised: true, task: IDLE_TASK,
        });
        expect(item).toMatchObject({ state: 'failed', failure: { kind: 'message', message: 'Restoring the old daemon failed.' }, action: { kind: 'run', verb: 'retry' } });
    });
});

describe('agent CLI rows (K6)', () => {
    it('keeps an unorderable vendor prerelease visible without crashing or offering an update', () => {
        const item = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true, task: IDLE_TASK,
            data: { available: true, version: '2.1.3-beta.1', latestVersion: '2.1.4', installSource: 'managed', updateSupported: true },
        });
        expect(item).toMatchObject({ currentVersion: '2.1.3-beta.1', state: 'unknown', action: { kind: 'none' } });
    });

    it('lists an installed agent with its version but claims nothing without a latest version', () => {
        const item = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true, task: IDLE_TASK,
            data: { available: true, version: '2.1.3' },
        });
        expect(item).toMatchObject({ state: 'unknown', currentVersion: '2.1.3', action: { kind: 'none' } });
        expect(buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true, task: IDLE_TASK, data: { available: false },
        })).toBeNull();
    });

    it('offers Update for a supported install and the command for one the person manages', () => {
        const managed = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true, task: IDLE_TASK,
            data: { available: true, version: '2.1.3', latestVersion: '2.1.4', installSource: 'managed', updateSupported: true, updateCommand: null },
        });
        expect(managed).toMatchObject({ state: 'available', action: { kind: 'run', verb: 'update' }, managedBy: 'happier' });

        const npm = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'codex', title: 'Codex', online: true, task: IDLE_TASK,
            data: { available: true, version: '0.60.0', latestVersion: '0.61.0', installSource: 'npm', updateSupported: false, updateCommand: 'npm i -g @openai/codex' },
        });
        expect(npm).toMatchObject({ managedBy: 'user', action: { kind: 'manual', command: 'npm i -g @openai/codex' } });
        expect(npm && isUpdateItemActionable(npm)).toBe(false);

        const vendor = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true, task: IDLE_TASK,
            data: { available: true, version: '2.1.3', latestVersion: '2.1.4', installSource: 'native', updateSupported: true, updateCommand: '/usr/local/bin/claude update' },
        });
        expect(vendor).toMatchObject({ state: 'available', action: { kind: 'run', verb: 'update' } });
    });

    it('never offers Update to a daemon that does not say updateSupported (it would install beside the person’s CLI)', () => {
        const oldDaemon = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true, task: IDLE_TASK,
            data: { available: true, version: '2.1.3', latestVersion: '2.1.4' },
        });
        expect(oldDaemon?.action).toEqual({ kind: 'none' });
        expect(oldDaemon && isUpdateItemActionable(oldDaemon)).toBe(false);
    });
});

describe('failed rows keep the executor\'s log', () => {
    it('carries the install log path of a failed run so the screen can offer View log', () => {
        const failed = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true,
            task: { running: false, step: null, errorMessage: 'The update didn’t finish. Try again.', logPath: '/h/.happier/logs/provider-installs/claude.log' },
            data: { available: true, version: '2.1.3', latestVersion: '2.1.4', installSource: 'managed', updateSupported: true, updateCommand: null },
        });
        expect(failed).toMatchObject({ state: 'failed', logPath: '/h/.happier/logs/provider-installs/claude.log' });
    });
});

describe('helper installable rows', () => {
    it('does not crash or claim up-to-date when an installed helper uses an opaque vendor prerelease', () => {
        const item = buildInstallableUpdateItem({
            machineId: 'm1', installableKey: 'gh', title: 'GitHub CLI', online: true, task: IDLE_TASK,
            data: {
                installed: true, installedVersion: '2.61.0-beta.1', sourceKind: 'managed', lastInstallLogPath: null, lastBackgroundUpdateCheckAtMs: null,
                latestVersionCheck: { ok: true, latestVersion: '2.62.0', label: null },
            },
        });
        expect(item).toMatchObject({ currentVersion: '2.61.0-beta.1', state: 'unknown', action: { kind: 'none' } });
    });

    it('offers the upgrade when the installables check found a newer version, and says when it could not check', () => {
        const available = buildInstallableUpdateItem({
            machineId: 'm1', installableKey: 'gh', title: 'GitHub CLI', online: true, task: IDLE_TASK,
            data: {
                installed: true, installedVersion: '2.61.0', sourceKind: 'managed', lastInstallLogPath: null, lastBackgroundUpdateCheckAtMs: null,
                latestVersionCheck: { ok: true, latestVersion: '2.62.0', label: null },
            },
        });
        expect(available).toMatchObject({ state: 'available', action: { kind: 'run', verb: 'update' } });

        const unknown = buildInstallableUpdateItem({
            machineId: 'm1', installableKey: 'gh', title: 'GitHub CLI', online: true, task: IDLE_TASK,
            data: {
                installed: true, installedVersion: '2.61.0', sourceKind: 'managed', lastInstallLogPath: null, lastBackgroundUpdateCheckAtMs: null,
                latestVersionCheck: { ok: false, errorMessage: 'rate limited' },
            },
        });
        expect(unknown).toMatchObject({ state: 'unknown', failure: { kind: 'latestUnknown' } });
        expect(JSON.stringify(unknown)).not.toContain('rate limited');
    });
});

describe('an update the runtime found already current', () => {
    it('reads up to date even while the cached latest version still says otherwise', () => {
        const row = buildAgentCliUpdateItem({
            machineId: 'm1', agentId: 'claude', title: 'Claude Code', online: true,
            task: { running: false, step: null, errorMessage: null, alreadyCurrent: true },
            data: { available: true, version: '2.1.281', latestVersion: '2.1.283', installSource: 'managed', updateSupported: true, updateCommand: null },
        });
        expect(row).toMatchObject({ state: 'upToDate', alreadyCurrent: true, action: { kind: 'none' } });
    });
});
