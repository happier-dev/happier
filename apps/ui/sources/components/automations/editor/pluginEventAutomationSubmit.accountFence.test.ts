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

const fetchAccountEncryptionMode = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({ fetchAccountEncryptionMode }));

const loadDaemonMergedProjectionInputs = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/agents/backendCatalog/loadDaemonMergedProjectionInputs', () => ({
    loadDaemonMergedProjectionInputs,
}));

import { storage } from '@/sync/domains/state/storageStore';
import { submitPluginEventAutomation } from './pluginEventAutomationSubmit';

function setActiveAccount(accountId: string): void {
    storage.setState({ profileScope: { serverId: 'server-a', accountId } });
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('submitPluginEventAutomation Account fence', () => {
    /**
     * Every remaining step writes through the CURRENT Account, while the
     * credential and Account encryption mode this submit admitted belong to the
     * one captured at entry. A caller fence keyed on machine/server/path cannot
     * see an Account switch on the same server.
     */
    it('refuses to continue when the Account switches while its encryption mode is being read', async () => {
        setActiveAccount('account-1');
        fetchAccountEncryptionMode.mockImplementation(async () => {
            setActiveAccount('account-2');
            return { mode: 'plain' };
        });

        await expect(submitPluginEventAutomation({
            draft: {
                draft: {} as never,
                resolveFreshWatcherOrigin: () => null,
            } as never,
            editTarget: {
                automationId: 'automation-1',
                expectedTemplateVersion: 1,
            } as never,
            automationEditId: 'automation-1',
            metadata: { name: 'Name', description: null, enabled: true },
            prompt: 'run it',
            targetKind: 'newSession',
            executionTargetServerId: 'server-a',
            buildNewSessionSpawn: () => null,
            buildExecutionRun: () => null,
            resolveTarget: () => null,
            confirmSubmission: async () => true,
            isCurrent: () => true,
        })).resolves.toEqual({ kind: 'unavailable', reason: 'account' });

        expect(syncMocks.refreshAutomationDefinitionDetail).not.toHaveBeenCalled();
        expect(syncMocks.updatePluginEventAutomationDefinition).not.toHaveBeenCalled();
        expect(syncMocks.createPluginEventAutomationDefinition).not.toHaveBeenCalled();
    });

    it('keeps admitting a submit whose Account never changes', async () => {
        setActiveAccount('account-1');
        fetchAccountEncryptionMode.mockImplementation(async () => ({ mode: 'plain' }));

        // The edit target is deliberately unresolvable, so this stops at the
        // definition-currentness gate rather than the Account gate.
        await expect(submitPluginEventAutomation({
            draft: {
                draft: {} as never,
                resolveFreshWatcherOrigin: () => null,
            } as never,
            editTarget: {
                automationId: 'automation-1',
                expectedTemplateVersion: 1,
            } as never,
            automationEditId: 'automation-1',
            metadata: { name: 'Name', description: null, enabled: true },
            prompt: 'run it',
            targetKind: 'newSession',
            executionTargetServerId: 'server-a',
            buildNewSessionSpawn: () => null,
            buildExecutionRun: () => null,
            resolveTarget: () => null,
            confirmSubmission: async () => true,
            isCurrent: () => true,
        })).resolves.toEqual({ kind: 'unavailable', reason: 'edit' });

        expect(syncMocks.refreshAutomationDefinitionDetail).toHaveBeenCalledOnce();
    });

    /**
     * r0.28/r0.39: a V3 patch replaces the whole strict recipe, so an edit may
     * move an Automation between the three approved target arms. Submitting a
     * different arm must reach ordinary target resolution instead of being
     * rejected as an invalid edit.
     */
    it('admits an edit that moves the Automation to a different approved target arm', async () => {
        setActiveAccount('account-1');
        fetchAccountEncryptionMode.mockImplementation(async () => ({ mode: 'plain' }));
        const detailValue = {
            id: 'automation-1',
            templateVersion: 1,
            trigger: { kind: 'pluginEvent' as const },
            name: 'Name',
            description: null,
            enabled: true,
            assignments: [],
            executionRecipe: {
                target: {
                    kind: 'newSession',
                    spawn: {
                        executionTarget: { serverId: 'server-a', machineId: 'executor-machine' },
                        directory: '/workspace/acme',
                        agentTarget: {
                            kind: 'agent',
                            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                        },
                    },
                },
            },
        };
        syncMocks.refreshAutomationDefinitionDetail.mockImplementation(async () => ({
            id: 'automation-1',
            templateVersion: 1,
            trigger: { kind: 'pluginEvent' as const },
            detail: { kind: 'available' as const, templateVersion: 1, value: detailValue },
        }) as never);

        const result = await submitPluginEventAutomation({
            draft: {
                draft: {} as never,
                resolveFreshWatcherOrigin: () => null,
            } as never,
            editTarget: {
                automationId: 'automation-1',
                expectedTemplateVersion: 1,
            } as never,
            automationEditId: 'automation-1',
            metadata: { name: 'Name', description: null, enabled: true },
            prompt: 'run it',
            // The persisted arm is `newSession`; the author is switching arms.
            targetKind: 'executionRun',
            executionTargetServerId: 'server-a',
            buildNewSessionSpawn: () => null,
            buildExecutionRun: () => null,
            resolveTarget: () => null,
            confirmSubmission: async () => true,
            isCurrent: () => true,
        });

        // Reaching the target gate proves the arm change was admitted; the
        // deliberately unresolvable target stops it one step later.
        expect(result).toEqual({ kind: 'unavailable', reason: 'target' });
        expect(syncMocks.updatePluginEventAutomationDefinition).not.toHaveBeenCalled();
    });
});
