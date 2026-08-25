import { afterEach, describe, expect, it, vi } from 'vitest';

const activeServerRuntimeState = vi.hoisted(() => ({
    snapshot: { serverId: 'server-a', serverUrl: 'https://example.com', generation: 1 },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerRuntimeState.snapshot,
    subscribeActiveServer: () => () => {},
}));

const syncMocks = vi.hoisted(() => ({
    getCredentials: vi.fn(() => ({ token: 'token', secret: new Uint8Array(32) })),
    refreshAutomationDefinitionDetail: vi.fn(async () => null),
    createPluginEventAutomationDefinition: vi.fn(async () => undefined),
    updatePluginEventAutomationDefinition: vi.fn(async () => undefined),
    refreshAutomations: vi.fn(async () => undefined),
}));
vi.mock('@/sync/sync', () => ({ sync: syncMocks }));

const fetchAccountEncryptionMode = vi.hoisted(() => vi.fn(async () => ({ mode: 'plain' })));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({ fetchAccountEncryptionMode }));

const loadDaemonMergedProjectionInputs = vi.hoisted(() => vi.fn(async () => ({
    automationEligibleEvents: [],
})));
vi.mock('@/agents/backendCatalog/loadDaemonMergedProjectionInputs', () => ({
    loadDaemonMergedProjectionInputs,
}));

import { storage } from '@/sync/domains/state/storageStore';
import { submitPluginEventAutomation } from './pluginEventAutomationSubmit';
import {
    formatPluginEventAutomationSubmissionConfirmation,
    type PluginEventAutomationSubmissionSummary,
} from './pluginEventAutomationSubmissionConfirmation';

const WATCHER_ORIGIN = Object.freeze({
    origin: {
        pluginId: 'happier.scm-github',
        serverIdentityId: 'server-identity-1',
        materializationRef: {
            pluginId: 'happier.scm-github',
            machineId: 'machine-watcher',
            materializationId: 'materialization-1',
        },
    },
    materialization: {},
    machineTarget: {
        serverId: 'server-a',
        target: { serverIdentityId: 'server-identity-1', machineId: 'machine-watcher' },
    },
});

function submitParams(confirmSubmission: (
    summary: PluginEventAutomationSubmissionSummary,
) => Promise<boolean>) {
    return {
        draft: {
            draft: {
                eventRef: { pluginId: 'happier.scm-github', localId: 'issue-comment' },
                observation: { kind: 'durablePush', webhookEndpointId: 'endpoint-1' },
            },
            resolveFreshWatcherOrigin: () => WATCHER_ORIGIN,
        } as never,
        editTarget: null,
        automationEditId: null,
        metadata: { name: 'Nightly triage', description: null, enabled: true },
        prompt: 'run it',
        targetKind: 'existingSession' as const,
        executionTargetServerId: 'server-a',
        buildNewSessionSpawn: () => null,
        buildExecutionRun: () => null,
        resolveTarget: () => ({
            target: { kind: 'existingSession' as const, sessionId: 'session-1' },
            assignmentMachineId: 'machine-executor',
        }),
        confirmSubmission,
        isCurrent: () => true,
    };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('submitPluginEventAutomation final confirmation', () => {
    it('writes nothing when the author declines the final confirmation', async () => {
        storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-1' } });
        const confirmSubmission = vi.fn(async () => false);

        await expect(submitPluginEventAutomation(submitParams(confirmSubmission)))
            .resolves.toEqual({ kind: 'cancelled' });

        expect(confirmSubmission).toHaveBeenCalledTimes(1);
        expect(syncMocks.createPluginEventAutomationDefinition).not.toHaveBeenCalled();
        expect(syncMocks.updatePluginEventAutomationDefinition).not.toHaveBeenCalled();
    });

    it('confirms with the exact resolved trigger, watcher, executor and target facts', async () => {
        storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-1' } });
        const confirmSubmission = vi.fn(async () => false);

        await submitPluginEventAutomation(submitParams(confirmSubmission));

        expect(confirmSubmission).toHaveBeenCalledWith({
            mode: 'create',
            automationName: 'Nightly triage',
            enabled: true,
            trigger: { pluginId: 'happier.scm-github', eventLocalId: 'issue-comment' },
            observation: 'durablePush',
            watcherMachineId: 'machine-watcher',
            executorMachineIds: ['machine-executor'],
            target: { kind: 'existingSession' },
        });
    });

    it('does not stop an accepted confirmation from reaching the definition writer', async () => {
        // The positive twin: accepting must let the flow continue past the
        // confirmation. This fixture's draft cannot build a real create
        // request, so the flow settles at the definition gate rather than
        // silently behaving like a decline.
        storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-1' } });
        const confirmSubmission = vi.fn(async () => true);

        await expect(submitPluginEventAutomation(submitParams(confirmSubmission)))
            .resolves.not.toEqual({ kind: 'cancelled' });
        expect(confirmSubmission).toHaveBeenCalledTimes(1);
    });
});

describe('formatPluginEventAutomationSubmissionConfirmation', () => {
    it('names the trigger, webhook custody, watcher, executor, target and permission effects', () => {
        const content = formatPluginEventAutomationSubmissionConfirmation({
            mode: 'create',
            automationName: 'Nightly triage',
            enabled: true,
            trigger: { pluginId: 'happier.scm-github', eventLocalId: 'issue-comment' },
            observation: 'durablePush',
            watcherMachineId: 'machine-watcher',
            executorMachineIds: ['machine-executor'],
            target: { kind: 'executionRun', permissionMode: 'read_only' },
        });

        expect(content.title).toContain('Nightly triage');
        expect(content.message).toContain('issue-comment');
        expect(content.message).toContain('happier.scm-github');
        expect(content.message).toContain('webhook');
        expect(content.message).toContain('machine-watcher');
        expect(content.message).toContain('machine-executor');
        expect(content.message).toContain('read_only');
        expect(content.message).toContain('unattended');
    });

    it('states that a disabled Automation will not run yet', () => {
        const content = formatPluginEventAutomationSubmissionConfirmation({
            mode: 'edit',
            automationName: 'Nightly triage',
            enabled: false,
            trigger: { pluginId: 'happier.scm-github', eventLocalId: 'issue-comment' },
            observation: 'checkpointedPull',
            watcherMachineId: 'machine-watcher',
            executorMachineIds: ['machine-executor'],
            target: { kind: 'newSession' },
        });

        expect(content.message).toContain('will not run');
        expect(content.message).toContain('polling');
    });
});
