import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import {
    useEnabledAutomationsCountForSession,
    useOpenApprovalArtifactsForSession,
    useOpenApprovalSessionReferences,
} from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

function artifact(
    id: string,
    header: NonNullable<DecryptedArtifact['header']>,
    body?: unknown,
): DecryptedArtifact {
    return {
        id,
        header,
        title: header.title ?? null,
        sessions: header.sessions,
        draft: header.draft,
        body: typeof body === 'undefined' ? undefined : JSON.stringify(body),
        headerVersion: 1,
        bodyVersion: typeof body === 'undefined' ? undefined : 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
    };
}

function approvalBody(sessionId: string, actionId: string) {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId },
        requestedSurface: 'agent',
        actionId,
        actionArgs: {},
        summary: 'Approve',
    };
}

type AutomationFixture = Readonly<{
    id: string;
    name?: string;
    description?: string | null;
    enabled?: boolean;
    targetType: AutomationDefinition['targetType'];
    templateVersion?: number;
    lastRunAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    assignments?: AutomationDefinition['assignments'];
    linkedExistingSessionId?: string | null;
}>;

function automation(params: AutomationFixture): AutomationDefinition {
    const templateVersion = params.templateVersion ?? 1;
    return {
        id: params.id,
        name: params.name ?? params.id,
        description: params.description ?? null,
        enabled: params.enabled ?? true,
        triggers: [],
        targetType: params.targetType,
        existingSessionId: params.linkedExistingSessionId ?? null,
        templateVersion,
        lastRunAt: params.lastRunAt ?? null,
        createdAt: params.createdAt ?? 1,
        updatedAt: params.updatedAt ?? 1,
        assignments: params.assignments ?? [],
        detail: { kind: 'unloaded', templateVersion },
        linkedExistingSessionId: params.linkedExistingSessionId ?? null,
    };
}

afterEach(() => {
    standardCleanup();
});

describe('useOpenApprovalSessionReferences', () => {
    it('projects only non-draft open approval session ids and ignores unrelated artifact churn', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    'server-a': ['session-a'],
                },
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    'server-a': {
                        'session-a': buildSessionListRenderableFromSession(createSessionFixture({ id: 'session-a', serverId: 'server-a' })),
                    },
                },
                artifacts: {
                    open: artifact('open', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                        sessions: ['session-a'],
                    }),
                    draft: artifact('draft', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Draft approve',
                        approvalStatus: 'open',
                        sessionId: 'draft-session',
                        draft: true,
                    }),
                    note: artifact('note', {
                        v: 1,
                        kind: 'note',
                        title: 'Note',
                        sessionId: 'session-b',
                    }),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useOpenApprovalSessionReferences();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            expect(first).toEqual([{ kind: 'legacy_unscoped', sessionId: 'session-a' }]);
            expect(renderCount).toBe(1);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    artifacts: {
                        ...state.artifacts,
                        note: {
                            ...state.artifacts.note,
                            updatedAt: 2,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('projects server-scoped session identities when approval artifacts include a server id', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                artifacts: {
                    open: artifact('open', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                        sessions: ['session-a'],
                        serverId: 'server-a',
                    }),
                },
            }));

            const hook = await renderHook(() => useOpenApprovalSessionReferences(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([{
                kind: 'exact',
                address: { serverId: 'server-a', sessionId: 'session-a' },
            }]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('session detail scoped projections', () => {
    it('returns only non-draft open approvals for one session without the global artifacts hook', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    'server-a': ['session-a'],
                },
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    'server-a': {
                        'session-a': buildSessionListRenderableFromSession(createSessionFixture({ id: 'session-a', serverId: 'server-a' })),
                    },
                },
                artifacts: {
                    open: artifact('open', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                        actionId: 'session.list',
                        approvalSummary: 'Approve',
                    }, approvalBody('session-a', 'session.list')),
                    draft: artifact('draft', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Draft approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                        actionId: 'session.status.get',
                        approvalSummary: 'Approve',
                        draft: true,
                    }, approvalBody('session-a', 'session.status.get')),
                    other: artifact('other', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Other approve',
                        approvalStatus: 'open',
                        sessionId: 'session-b',
                        sessions: ['session-b'],
                        actionId: 'session.status.get',
                        approvalSummary: 'Approve',
                    }, approvalBody('session-b', 'session.status.get')),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useOpenApprovalArtifactsForSession({ serverId: 'server-a', sessionId: 'session-a' });
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            expect(first.map((entry) => entry.artifact.id)).toEqual(['open']);
            expect(renderCount).toBe(1);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    artifacts: {
                        ...state.artifacts,
                        other: {
                            ...state.artifacts.other,
                            updatedAt: 2,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('counts enabled automations for one session without subscribing to the global sorted automation list', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                automations: {
                    enabled: automation({
                        id: 'enabled',
                        enabled: true,
                        targetType: 'existingSession',
                        linkedExistingSessionId: 'session-a',
                    }),
                    plain: automation({
                        id: 'plain',
                        enabled: true,
                        targetType: 'existingSession',
                        linkedExistingSessionId: 'session-a',
                    }),
                    disabled: automation({
                        id: 'disabled',
                        enabled: false,
                        targetType: 'existingSession',
                        linkedExistingSessionId: 'session-a',
                    }),
                    other: automation({
                        id: 'other',
                        enabled: true,
                        targetType: 'existingSession',
                        linkedExistingSessionId: 'session-b',
                    }),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useEnabledAutomationsCountForSession('session-a');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(2);
            expect(renderCount).toBe(1);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    automations: {
                        ...state.automations,
                        other: {
                            ...state.automations.other,
                            updatedAt: 2,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(2);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
