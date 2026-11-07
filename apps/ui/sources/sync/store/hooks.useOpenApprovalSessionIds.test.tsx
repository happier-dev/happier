import { afterEach, describe, expect, it, vi } from 'vitest';
import * as approvalAdmission from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { act } from 'react-test-renderer';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import {
    useEnabledAutomationsCountForSession,
    useOpenApprovalArtifactsForSession,
    useTranscriptApprovalArtifactsForSession,
    useOpenApprovalSessionReferences,
} from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

type ApprovalTestState = ReturnType<typeof storage.getState>;

/** Fixtures publish through the real Artifact ingress so its relationship projections stay authoritative. */
function publishApprovalTestState(update: Partial<ApprovalTestState> | ((state: ApprovalTestState) => Partial<ApprovalTestState>)): void {
    const before = storage.getState();
    const next = typeof update === 'function' ? update(before) : update;
    const { artifacts, ...rest } = next;
    storage.setState(rest);
    if (artifacts) storage.getState().applyArtifacts(Object.values(artifacts), before.artifacts);
}

function artifact(
    id: string,
    header: NonNullable<DecryptedArtifact['header']>,
    body?: unknown,
): Extract<DecryptedArtifact, { isDecrypted: true }> {
    const resolvedHeader = typeof body === 'undefined'
        ? header
        : { ...header, ...buildApprovalRequestArtifactHeaderV1(ApprovalRequestV1Schema.parse(body)) };
    return {
        id,
        header: resolvedHeader,
        title: resolvedHeader.title ?? null,
        sessions: resolvedHeader.sessions,
        draft: resolvedHeader.draft,
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
    it('shares admitted request identities across real open/transcript producers when one approval arrives', async () => {
        const previous = storage.getState();
        const target = { serverId: 'server-a', sessionId: 'producer-cost-session' };
        const make = (index: number) => artifact(`producer-cost-${index}`, { title: 'Approve', serverId: target.serverId },
            approvalBody(target.sessionId, 'session.list'));
        const retained = Array.from({ length: 139 }, (_, index) => make(index));
        const presentations = [] as const;
        publishApprovalTestState({ isDataReady: true, artifacts: Object.fromEntries(retained.map(row => [row.id, row])) });
        const admit = vi.spyOn(approvalAdmission, 'approvalArtifactBodyMatchesHeaderV1');
        try {
            const hook = await renderHook(() => ({ open: useOpenApprovalArtifactsForSession(target),
                references: useOpenApprovalSessionReferences(),
                transcript: useTranscriptApprovalArtifactsForSession(target, presentations) }));
            const initial = hook.getCurrent();
            expect(initial.open).toHaveLength(139);
            const incoming = make(139);
            admit.mockClear();
            await act(async () => publishApprovalTestState(state => ({ artifacts: { ...state.artifacts, [incoming.id]: incoming } })));
            const added = hook.getCurrent();
            expect(admit).toHaveBeenCalledTimes(1);
            expect(added.open.slice(0, 139).every((entry, index) => entry === initial.open[index])).toBe(true);
            expect(added.transcript.every((entry, index) => entry === added.open[index])).toBe(true);
            expect(added.transcript.slice(0, 139).every((entry, index) => entry === initial.transcript[index])).toBe(true);
            expect(added.references).toBe(initial.references);
            // Removing the first carrier of a still-present Session fact is not a badge change.
            await act(async () => publishApprovalTestState(state => {
                const artifacts = { ...state.artifacts };
                delete artifacts[retained[0]!.id];
                return { artifacts };
            }));
            expect(hook.getCurrent().references).toBe(initial.references);
            expect(hook.getCurrent().open).toHaveLength(139);
            expect(admit).toHaveBeenCalledTimes(1);
            await hook.unmount();
        } finally {
            admit.mockRestore();
            await standardCleanup();
            storage.setState(previous);
        }
    });

    it('projects only non-draft open approval session ids and ignores unrelated artifact churn', async () => {
        const previousState = storage.getState();
        try {
            publishApprovalTestState((state) => ({
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
                    }, approvalBody('session-a', 'session.list')),
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
                publishApprovalTestState((state) => ({
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

            await act(async () => {
                publishApprovalTestState((state) => {
                    const open = state.artifacts.open;
                    if (!open?.isDecrypted || !open.header) throw new Error('Approval fixture must have a readable header');
                    return {
                        artifacts: {
                            ...state.artifacts,
                            open: {
                                ...open,
                                header: { ...open.header, serverId: 'server-b' },
                            },
                        },
                    };
                });
            });

            expect(hook.getCurrent()).toEqual([{
                kind: 'exact',
                address: { serverId: 'server-b', sessionId: 'session-a' },
            }]);
            expect(hook.getCurrent()).not.toBe(first);
            expect(renderCount).toBe(2);

            await act(async () => {
                publishApprovalTestState((state) => {
                    const open = state.artifacts.open;
                    if (!open?.isDecrypted || !open.header) throw new Error('Approval fixture must have a readable header');
                    return {
                        artifacts: {
                            ...state.artifacts,
                            open: {
                                ...open,
                                header: { ...open.header, approvalStatus: 'approved' },
                            },
                        },
                    };
                });
            });

            expect(hook.getCurrent()).toEqual([]);
            expect(renderCount).toBe(3);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('projects server-scoped session identities when approval artifacts include a server id', async () => {
        const previousState = storage.getState();
        try {
            publishApprovalTestState((state) => ({
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
                    }, approvalBody('session-a', 'session.list')),
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
    it('does not revisit retained approval headers on an unrelated Artifact arrival at Account scale', async () => {
        const previousState = storage.getState();
        const target = { serverId: 'postperf-home', sessionId: 'visible-session' };
        let retainedHeaderReads = 0;
        const retained = Array.from({ length: 512 }, (_, index) => {
            const row = artifact(`postperf-retained-${index}`, { title: 'Approve', serverId: target.serverId },
                approvalBody(`closed-session-${index}`, 'session.list'));
            const header = row.header;
            // Count data examined by the real store and mounted selector; no domain logic is replaced.
            Object.defineProperty(row, 'header', { enumerable: true, get: () => {
                retainedHeaderReads += 1;
                return header;
            } });
            return row;
        });
        const selected = artifact('postperf-selected', { title: 'Approve', serverId: target.serverId },
            approvalBody(target.sessionId, 'session.list'));
        const note = artifact('postperf-note', { kind: 'note', title: 'Unrelated' });
        let renders = 0;
        try {
            publishApprovalTestState({ isDataReady: true });
            storage.getState().applyArtifacts([...retained, selected, note]);
            const hook = await renderHook(() => {
                renders += 1;
                return useOpenApprovalArtifactsForSession(target);
            });
            try {
                expect(hook.getCurrent().map(entry => entry.artifact.id)).toEqual([selected.id]);
                const before = hook.getCurrent();
                renders = 0;
                retainedHeaderReads = 0;
                await act(async () => storage.getState().updateArtifact({ ...note, updatedAt: 2 }));
                const unrelatedHeaderReads = retainedHeaderReads;
                const unrelatedRenders = renders;
                expect(hook.getCurrent()).toBe(before);

                // The quiet-path contract must still deliver a real approval settlement.
                const settled = artifact(selected.id, { title: 'Approve', serverId: target.serverId }, {
                    ...approvalBody(target.sessionId, 'session.list'), status: 'executed', updatedAtMs: 2,
                    decision: { kind: 'approve', decidedAtMs: 2 },
                    execution: { executedAtMs: 2, ok: true, result: {} },
                });
                await act(async () => storage.getState().updateArtifact({ ...settled, headerVersion: 2, bodyVersion: 2 }));
                expect(hook.getCurrent()).toEqual([]);
                expect(renders).toBe(1);
                expect(unrelatedRenders).toBe(0);
                expect(unrelatedHeaderReads).toBe(0);
            } finally { await hook.unmount(); }
        } finally { storage.setState(previousState); }
    });

    it('reprojects a hydrated legacy approval only for its linked Session when same-Home membership arrives', async () => {
        const previousState = storage.getState();
        try {
            publishApprovalTestState({ isDataReady: true, sessions: {}, ordinarySessionListMembershipByServerId: {}, artifacts: {
                open: artifact('open', { v: 1, kind: 'approval_request.v1', title: 'Approve' }, approvalBody('session-a', 'session.list')),
            } });
            const hook = await renderHook(() => ({
                sessionA: useOpenApprovalArtifactsForSession({ serverId: 'legacy-home', sessionId: 'session-a' }),
                sessionB: useOpenApprovalArtifactsForSession({ serverId: 'legacy-home', sessionId: 'session-b' }),
            }));
            expect(hook.getCurrent()).toEqual({ sessionA: [], sessionB: [] });
            const artifactsBefore = storage.getState().artifacts;
            await act(async () => { publishApprovalTestState({ ordinarySessionListMembershipByServerId: { 'legacy-home': ['session-a', 'session-b'] } }); });
            expect(storage.getState().artifacts).toBe(artifactsBefore);
            expect(hook.getCurrent().sessionA.map(entry => entry.artifact.id)).toEqual(['open']);
            expect(hook.getCurrent().sessionB).toEqual([]);
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });

    it('reprojects an existing approval when its local Home profile acquires the portable identity', async () => {
        const previousState = storage.getState();
        const serverUrl = 'https://approval-delayed-profile.test';
        const profile = await upsertServerProfile({ serverUrl });
        const body = ApprovalRequestV2Schema.parse({ ...approvalBody('session-a', 'session.title.set'), v: 2,
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote-profile', serverIdentityId: 'srv_delayed_approval_home', sessionId: 'session-a',
                actionId: 'session.title.set', requestId: 'request-1' } });
        const header = buildApprovalRequestArtifactHeaderV1(body);
        try {
            publishApprovalTestState({ isDataReady: true, artifacts: { open: {
                ...artifact('open', header), body: JSON.stringify(body), bodyVersion: 1,
            } } });
            const hook = await renderHook(() => useOpenApprovalArtifactsForSession({ serverId: profile.id, sessionId: 'session-a' }));
            expect(hook.getCurrent()).toEqual([]);
            const artifactsBefore = storage.getState().artifacts;
            await act(async () => { await setServerProfileIdentityForUrl(serverUrl, 'srv_delayed_approval_home'); });
            expect(storage.getState().artifacts).toBe(artifactsBefore);
            expect(hook.getCurrent().map(entry => entry.artifact.id)).toEqual(['open']);
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });

    it('returns only non-draft open approvals for one session without the global artifacts hook', async () => {
        const previousState = storage.getState();
        try {
            publishApprovalTestState((state) => ({
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
                publishApprovalTestState((state) => ({
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
            publishApprovalTestState((state) => ({
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
                publishApprovalTestState((state) => ({
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
