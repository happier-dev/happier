import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import {
    useEnabledAutomationsCountForSession,
    useOpenApprovalArtifactsForSession,
    useOpenApprovalSessionIds,
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

type AutomationFixture = Readonly<{
    id: string;
    name?: string;
    description?: string | null;
    enabled?: boolean;
    targetType: AutomationDefinition['targetType'];
    templateVersion?: number;
    nextRunAt?: number | null;
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
        trigger: {
            kind: 'schedule',
            schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
        },
        targetType: params.targetType,
        existingSessionId: params.linkedExistingSessionId ?? null,
        templateVersion,
        nextRunAt: params.nextRunAt ?? null,
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

describe('useOpenApprovalSessionIds', () => {
    it('projects only non-draft open approval session ids and ignores unrelated artifact churn', async () => {
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
                return useOpenApprovalSessionIds();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            expect(first).toEqual(['session-a']);
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
                        serverId: 'server-a',
                    }),
                },
            }));

            const hook = await renderHook(() => useOpenApprovalSessionIds(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual(['server-a:session-a']);

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
                artifacts: {
                    open: artifact('open', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                        actionId: 'session.list',
                    }),
                    draft: artifact('draft', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Draft approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                        actionId: 'session.status.get',
                        draft: true,
                    }),
                    other: artifact('other', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Other approve',
                        approvalStatus: 'open',
                        sessionId: 'session-b',
                        actionId: 'session.status.get',
                    }),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useOpenApprovalArtifactsForSession('session-a');
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
