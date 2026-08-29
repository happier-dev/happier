import { describe, expect, it, vi } from 'vitest';

import {
    createActionExecutor,
    type ActionExecutorDeps,
    type ApprovalQueueListItemV1,
    type ApprovalRequestV1,
} from '@happier-dev/protocol';
import { createBlockingApprovalCoordinator } from '../../../../session/actions/approvals/blockingApprovalCoordinator';

import { createStablePluginApprovalQueueOwner } from './approvalQueue';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import type { PluginInvocationServicesSeed } from './types';

const pluginMaterialization = createPluginActionCallerMaterializationFixture('acme.plugin');

function seed(overrides: Partial<PluginInvocationServicesSeed> = {}): PluginInvocationServicesSeed {
    return {
        plugin: { id: 'acme.plugin', version: '1.0.0' },
        contribution: { id: 'action', qualifiedId: 'acme.plugin/actions/action' },
        resolveCurrentPluginMaterializationRef:
            pluginMaterialization.resolveCurrentPluginMaterializationRef,
        generation: 'generation-1',
        correlationId: 'correlation-1',
        surface: 'agent',
        session: { id: 'session-1' },
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
        ...overrides,
    };
}

function request(status: ApprovalRequestV1['status'] = 'open'): ApprovalRequestV1 {
    return {
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system', sessionId: 'session-1' },
        actionId: 'session.list',
        actionArgs: {},
        summary: 'List sessions',
    } as ApprovalRequestV1;
}

function createRealExecutor(approvalsCreate: NonNullable<ActionExecutorDeps['approvalsCreate']>) {
    return createActionExecutor({
        executionRunStart: async () => ({}),
        executionRunList: async () => ({}),
        executionRunGet: async () => ({}),
        executionRunSend: async () => ({}),
        executionRunStop: async () => ({}),
        executionRunAction: async () => ({}),
        executionRunWait: async () => ({}),
        sessionOpen: async () => ({}),
        sessionFork: async () => ({}),
        sessionRollback: async () => ({}),
        sessionSpawnNew: async () => ({}),
        pathsListRecent: async () => ({ items: [] }),
        machinesList: async () => ({ items: [] }),
        serversList: async () => ({ items: [] }),
        reviewEnginesList: async () => ({ items: [] }),
        agentsBackendsList: async () => ({ items: [] }),
        agentsModelsList: async () => ({ items: [] }),
        sessionSendMessage: async () => ({}),
        sessionPermissionRespond: async () => ({}),
        sessionUserActionAnswer: async () => ({}),
        sessionModeSet: async () => ({}),
        sessionModesList: async () => ({}),
        sessionTargetPrimarySet: async () => ({}),
        sessionTargetTrackedSet: async () => ({}),
        sessionList: async () => ({}),
        sessionActivityGet: async () => ({}),
        sessionRecentMessagesGet: async () => ({}),
        daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
        daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
        daemonMemoryEnsureUpToDate: async () => ({}),
        resetGlobalVoiceAgent: async () => {},
        approvalsCreate,
    });
}

describe('stable plugin approval queue owner', () => {
    it('routes requests through the canonical action executor with host-stamped plugin provenance', async () => {
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: Readonly<Record<string, unknown>>,
        ) => ({ ok: true as const, result: { artifactId: 'approval-1' } }));
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => ({ execute }),
        }).bind(seed());

        await expect(queue.request({
            actionId: 'session.list',
            input: {},
            summary: 'List sessions',
        })).resolves.toEqual({ approvalRequestId: 'approval-1' });
        expect(execute).toHaveBeenCalledWith(
            'approval.request.create',
            expect.objectContaining({ actionId: 'session.list', actionArgs: {} }),
            expect.objectContaining({
                defaultSessionId: 'session-1',
                surface: 'plugin',
                authority: 'account_automation',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: 'acme.plugin',
                    contributionLocalId: 'action',
                    materialization: pluginMaterialization.materialization,
                },
            }),
        );
    });

    it('uses one stamped caller for a plugin-bound approval input and its Action dispatch', async () => {
        const resolveCurrentPluginMaterializationRef = vi.fn(
            pluginMaterialization.resolveCurrentPluginMaterializationRef,
        );
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: Readonly<Record<string, unknown>>,
        ) => ({ ok: true as const, result: { artifactId: 'approval-1' } }));
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => ({ execute }),
        }).bind(seed({ resolveCurrentPluginMaterializationRef }));

        await expect(queue.request({
            actionId: 'session.user_action.answer',
            input: {
                requestId: 'question-1',
                answers: [{ question: 'Continue?', values: ['Yes'] }],
            },
        })).resolves.toEqual({ approvalRequestId: 'approval-1' });

        expect(resolveCurrentPluginMaterializationRef).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith(
            'approval.request.create',
            expect.objectContaining({
                actionId: 'session.user_action.answer',
                actionArgs: {
                    sessionId: 'session-1',
                    requestId: 'question-1',
                    answers: [{ question: 'Continue?', values: ['Yes'] }],
                },
            }),
            expect.objectContaining({
                actionCaller: expect.objectContaining({
                    materialization: pluginMaterialization.materialization,
                }),
            }),
        );
    });

    it('rechecks generation currentness after awaiting the executor resolver and before the Action effect', async () => {
        let current = true;
        let releaseResolver!: () => void;
        const resolverGate = new Promise<void>((resolve) => {
            releaseResolver = resolve;
        });
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { items: [] },
        }));
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => {
                await resolverGate;
                return { execute };
            },
        }).bind(seed({ isGenerationCurrent: () => current }));

        const pending = queue.list();
        await vi.waitFor(() => expect(releaseResolver).toBeTypeOf('function'));
        current = false;
        releaseResolver();

        await expect(pending).rejects.toMatchObject({
            code: 'plugin_interaction_generation_retired',
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('reaches the real approval owner with stamped provenance and rejects fields outside the plugin schema', async () => {
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-1' }));
        const executor = createRealExecutor(approvalsCreate);
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => executor,
        }).bind(seed());

        await expect(queue.request({
            actionId: 'session.list',
            input: {},
            summary: 'List sessions',
        })).resolves.toEqual({ approvalRequestId: 'approval-1' });
        expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                createdBy: {
                    surface: 'system',
                    pluginId: 'acme.plugin',
                    contributionLocalId: 'action',
                    sessionId: 'session-1',
                },
                requestedSurface: 'plugin',
            }),
        }));

        await expect(queue.request({
            actionId: 'session.permission.respond',
            input: {
                requestId: 'permission-1',
                decision: 'allow',
            },
        })).resolves.toEqual({ approvalRequestId: 'approval-1' });
        expect(approvalsCreate).toHaveBeenLastCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                actionId: 'session.permission.respond',
                actionArgs: {
                    sessionId: 'session-1',
                    requestId: 'permission-1',
                    decision: 'allow',
                },
            }),
        }));

        await expect(queue.request({
            actionId: 'session.permission.respond',
            input: {
                requestId: 'permission-1',
                decision: 'allow',
                updatedPermissions: { mode: 'forged' },
            },
        } as never)).rejects.toMatchObject({
            code: 'plugin_action_input_schema_invalid',
        });
        expect(approvalsCreate).toHaveBeenCalledTimes(2);
    });

    it('projects canonical artifacts into the curated public approval DTOs', async () => {
        const canonical = {
            ...request('approved'),
            decision: { kind: 'approve' as const, decidedAtMs: 2 },
        } satisfies ApprovalRequestV1;
        const execute = vi.fn(async (actionId: string) => actionId === 'approval.request.get'
            ? { ok: true as const, result: { request: canonical } }
            : {
                ok: true as const,
                result: {
                    items: [{
                        artifactId: 'approval-1',
                        status: canonical.status,
                        actionId: canonical.actionId,
                        summary: canonical.summary,
                        updatedAtMs: canonical.updatedAtMs,
                    }],
                    queryPlan: { hydratedTranscripts: false },
                },
            });
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => ({ execute }),
        }).bind(seed());

        await expect(queue.get('approval-1')).resolves.toEqual({
            approvalRequestId: 'approval-1',
            status: 'approved',
            actionId: 'session.list',
            input: {},
            summary: 'List sessions',
            createdAtMs: 1,
            updatedAtMs: 1,
            decision: { kind: 'approve', decidedAtMs: 2 },
        });
        await expect(queue.list()).resolves.toEqual({
            items: [{
                approvalRequestId: 'approval-1',
                status: 'approved',
                actionId: 'session.list',
                summary: 'List sessions',
                updatedAtMs: 1,
            }],
        });
    });

    it('returns null when the canonical approval owner reports a missing request', async () => {
        const execute = vi.fn()
            .mockResolvedValueOnce({
                ok: false as const,
                errorCode: 'approval_not_found',
                error: 'approval_not_found',
            })
            .mockResolvedValueOnce({
                ok: false as const,
                errorCode: 'approval_store_unavailable',
                error: 'approval_store_unavailable',
            })
            .mockResolvedValueOnce({
                ok: true as const,
                result: {},
            });
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => ({ execute }),
        }).bind(seed());

        await expect(queue.get('missing-approval')).resolves.toBeNull();
        await expect(queue.get('unavailable-approval')).rejects.toMatchObject({
            code: 'approval_store_unavailable',
        });
        await expect(queue.get('malformed-approval')).rejects.toMatchObject({
            code: 'plugin_approval_queue_invalid_response',
        });
    });

    it('rejects sparse arrays and nonordinary objects in projected approval payloads and freezes projected input', async () => {
        const sparseArgs = [1, 3] as number[];
        delete sparseArgs[1];
        class NonordinaryArgs {
            constructor(readonly sessionId: string) {}
        }
        let actionArgs: unknown = { sessionId: 'session-1' };
        const execute = vi.fn(async (actionId: string) => (
            actionId === 'approval.request.get'
                ? { ok: true as const, result: { request: { ...request('open'), actionArgs } } }
                : { ok: false as const, errorCode: 'unexpected', error: 'unexpected' }
        ));
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => ({ execute }),
        }).bind(seed());

        actionArgs = sparseArgs;
        await expect(queue.get('approval-1')).rejects.toMatchObject({
            code: 'plugin_approval_queue_invalid_response',
        });
        actionArgs = new NonordinaryArgs('session-1');
        await expect(queue.get('approval-1')).rejects.toMatchObject({
            code: 'plugin_approval_queue_invalid_response',
        });
        actionArgs = { sessionId: 'session-1' };
        const approval = await queue.get('approval-1');
        expect(approval?.input).toEqual({ sessionId: 'session-1' });
        expect(Object.isFrozen(approval?.input)).toBe(true);
    });

    it('preserves canonical JSON null as an execution result', async () => {
        const execute = vi.fn(async (actionId: string) => (
            actionId === 'approval.request.get'
                ? {
                    ok: true as const,
                    result: {
                        request: {
                            ...request('executed'),
                            execution: {
                                executedAtMs: 4,
                                ok: true,
                                result: null,
                            },
                        },
                    },
                }
                : { ok: false as const, errorCode: 'unexpected', error: 'unexpected' }
        ));
        const queue = createStablePluginApprovalQueueOwner({
            resolveExecutor: async () => ({ execute }),
        }).bind(seed());

        await expect(queue.get('approval-1')).resolves.toMatchObject({
            execution: { ok: true, result: null },
        });
    });

    it('delivers one initial snapshot then serialized changed snapshots and disposes exactly', async () => {
        const coordinator = createBlockingApprovalCoordinator();
        let items: readonly ApprovalQueueListItemV1[] = [];
        const execute = vi.fn(async (actionId: string) => actionId === 'approval.request.list'
            ? { ok: true as const, result: { items, queryPlan: { hydratedTranscripts: false } } }
            : { ok: false as const, errorCode: 'unexpected', error: 'unexpected' });
        const queue = createStablePluginApprovalQueueOwner({
            coordinator,
            resolveExecutor: async () => ({ execute }),
        }).bind(seed());
        const snapshots: number[] = [];
        let releaseChanged!: () => void;
        const changedGate = new Promise<void>((resolve) => { releaseChanged = resolve; });
        let active = 0;
        let maxActive = 0;
        const secondChanged = new Promise<void>((resolve) => {
            void queue.watch(undefined, async (snapshot) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                snapshots.push(snapshot.items.length);
                if (snapshots.length === 2) await changedGate;
                active -= 1;
                if (snapshots.length === 3) resolve();
            }).then((subscription) => {
                items = [{
                    artifactId: 'approval-1', status: 'open', actionId: 'session.list',
                    summary: 'List sessions', updatedAtMs: 2,
                }];
                coordinator.notifyApprovalUpdated({ artifactId: 'approval-1', request: request() });
                items = [{
                    artifactId: 'approval-1', status: 'rejected', actionId: 'session.list',
                    summary: 'List sessions', updatedAtMs: 3,
                }];
                coordinator.notifyApprovalUpdated({ artifactId: 'approval-1', request: request('rejected') });
                releaseChanged();
                void secondChanged.then(() => {
                    subscription.dispose();
                    coordinator.notifyApprovalUpdated({ artifactId: 'approval-1', request: request('rejected') });
                });
            });
        });

        await secondChanged;
        await Promise.resolve();
        expect(snapshots).toEqual([0, 1, 1]);
        expect(maxActive).toBe(1);
    });
});
