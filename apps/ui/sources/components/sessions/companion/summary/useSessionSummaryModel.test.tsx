import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestSessionTranscriptSource, renderHookWithSessionTranscriptSource as renderHook } from '@/dev/testkit/sessionTranscriptSource';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { Session } from '@/sync/domains/state/storageTypes';

const awarenessTimes = vi.hoisted(() => [] as number[]);
const awarenessSessions = vi.hoisted(() => [] as unknown[]);
const liveSessionRow = vi.hoisted(() => ({ current: null as unknown }));
const approvalSessionTargets = vi.hoisted(() => [] as Array<{ serverId: string; sessionId: string } | null | undefined>);
const activityInputs = vi.hoisted(() => [] as unknown[]);
const scmInputs = vi.hoisted(() => [] as unknown[]);
const usageInputs = vi.hoisted(() => [] as unknown[]);
const activityCounts = vi.hoisted(() => ({ current: { live: 0, total: 0 } }));
const activityEntries = vi.hoisted(() => ({ current: [] as Array<{
    id: string;
    title: string;
    status: string;
}> }));
const usageState = vi.hoisted(() => ({ current: null as null | {
    contextSnapshot: {
        v: 1;
        modelId: string | null;
        usedTokens: number;
        windowTokens: number | null;
        totalProcessedTokens: number | null;
        baselineTokens: number | null;
        isAutoCompactEnabled: boolean | null;
        categories: null;
        observedAtMs: number;
        source: 'provider_turn';
    };
    contextSnapshotStale: boolean;
} }));

vi.mock('@/sync/domains/session/awareness/sessionAwareness', () => ({
    projectUiSessionAwareness: (_session: Session, nowMs: number) => {
        awarenessTimes.push(nowMs);
        awarenessSessions.push(_session);
        return {
            v: 1,
            sessionId: 'session-1',
            title: 'Session',
            lifecycle: 'active',
            runtime: 'online',
            freshness: nowMs >= 61_000 ? 'stale' : 'live',
            operational: { primary: 'ready', reasons: [] },
            encryption: 'plain',
            availability: 'complete',
        };
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: (_id: string, serverId?: string | null) => {
        const row = liveSessionRow.current as Session | null;
        return !serverId || row?.serverId === serverId ? row : null;
    },
    useOpenApprovalArtifactsForSession: (target: { serverId: string; sessionId: string } | null | undefined) => {
        approvalSessionTargets.push(target);
        return [];
    },
    useSessionProjectScmSnapshot: (...input: unknown[]) => {
        scmInputs.push(input);
        return null;
    },
    useSessionUsage: (...input: unknown[]) => {
        usageInputs.push(input);
        return usageState.current;
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({ AGENT_IDS: [], getAgentCore: () => null }));
vi.mock('@/hooks/session/useSessionAgentActivity', () => ({
    useSessionAgentActivity: (input: unknown) => {
        activityInputs.push(input);
        return {
            counts: activityCounts.current,
            entries: activityEntries.current,
            readSubagentForEntry: () => null,
        };
    },
}));
vi.mock('@/components/sessions/agents/presentation/sessionAgentActivityPresentation', () => ({
    resolveSessionAgentActivityPresentation: ({ entry }: { entry: { title: string; status: string } }) => ({
        title: entry.title,
        statusLabel: entry.status,
    }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
// The synopsis reader is the System Record transport (a server boundary); the Recap's own resolution
// is covered in sessionRecap.test.ts.
vi.mock('@/sync/ops/sessionSynopsis', () => ({ observeSessionSynopses: () => () => {} }));

import { SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS } from '@/hooks/session/sessionListRuntimeClock';
import { useSessionSummaryModel } from './useSessionSummaryModel';

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    awarenessTimes.length = 0;
    approvalSessionTargets.length = 0;
    activityInputs.length = 0;
    scmInputs.length = 0;
    usageInputs.length = 0;
    activityCounts.current = { live: 0, total: 0 };
    activityEntries.current = [];
    usageState.current = null;
    awarenessSessions.length = 0;
    liveSessionRow.current = null;
});

describe('useSessionSummaryModel', () => {
    it('reads waiting questions from its exact Home-bound transcript source', async () => {
        const session = { id: 'session-1', serverId: 'home-a', active: true } as Session;
        const agentState = { requests: {
            question: { tool: 'AskUserQuestion', kind: 'user_action' as const, arguments: { questions: [] }, createdAt: 100 },
            permission: { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'pwd' }, createdAt: 200 },
        } };
        const source = createTestSessionTranscriptSource({
            sessionId: session.id, serverId: 'home-a',
            agentState,
        });
        const hook = await renderHook(() => useSessionSummaryModel({ session }), { source });
        expect(hook.getCurrent().needsYou).toMatchObject({ request: { id: 'question' }, moreCount: 1 });
        await hook.rerender(undefined, createTestSessionTranscriptSource({
            sessionId: session.id, serverId: 'home-other', agentState,
        }));
        expect(hook.getCurrent().needsYou).toBeNull();
        await hook.unmount();
    });

    it('advances awareness freshness on the canonical shared clock while the Session object stays stable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const session = { id: 'session-1' } as Session;
        const hook = await renderHook(() => useSessionSummaryModel({ session, serverId: 'server-a' }));

        expect(hook.getCurrent().stale).toBe(false);
        await flushHookEffects({
            advanceTimersMs: SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS,
            cycles: 1,
            turns: 2,
        });

        expect(hook.getCurrent().stale).toBe(true);
        expect(awarenessTimes.at(-1)).toBe(61_000);
        await hook.unmount();
    });

    it('projects awareness from the live Session row, not the stabilised shell object', async () => {
        // The shell's stable signature deliberately omits `activeAt` and `runtimeActivity*`,
        // so the object it hands down keeps reporting the heartbeat it was frozen with.
        const shellSession = { id: 'session-1', serverId: 'home-a', activeAt: 1_000 } as Session;
        liveSessionRow.current = { id: 'session-1', serverId: 'home-a', activeAt: 90_000, runtimeActivityActiveCount: 3 };
        const hook = await renderHook(() => useSessionSummaryModel({ session: shellSession, serverId: 'home-a' }));

        expect(awarenessSessions.at(-1)).toMatchObject({ activeAt: 90_000, runtimeActivityActiveCount: 3 });

        // A runtimeActivity-only update reaches the Summary while the shell reference is unchanged.
        liveSessionRow.current = { id: 'session-1', serverId: 'home-a', activeAt: 90_000, runtimeActivityActiveCount: 5 };
        await hook.rerender();
        expect(awarenessSessions.at(-1)).toMatchObject({ runtimeActivityActiveCount: 5 });

        // A row for another Home is never substituted for the exact Session this card describes.
        liveSessionRow.current = { id: 'session-1', serverId: 'home-other', activeAt: 500_000 };
        await hook.rerender();
        expect(awarenessSessions.at(-1)).toBe(shellSession);
        await hook.unmount();
    });

    it('does not borrow an unqualified same-id live row for a different Home', async () => {
        const shellSession = { id: 'same-session-id', activeAt: 1_000 } as Session;
        liveSessionRow.current = { id: 'same-session-id', activeAt: 90_000, runtimeActivityActiveCount: 3 };

        const hook = await renderHook(() => useSessionSummaryModel({ session: shellSession, serverId: 'home-b' }));
        expect(awarenessSessions.at(-1)).toBe(shellSession);
        await hook.unmount();
    });

    it('selects approvals by the exact Home-qualified Session identity', async () => {
        const session = { id: 'same-session-id' } as Session;
        const hook = await renderHook(() => useSessionSummaryModel({ session, serverId: 'home-b' }));

        expect(approvalSessionTargets.at(-1)).toEqual({ serverId: 'home-b', sessionId: 'same-session-id' });
        expect(activityInputs.at(-1)).toMatchObject({
            sessionId: 'same-session-id',
            serverId: 'home-b',
            session,
        });
        await hook.unmount();
    });

    it('uses the Session-owned Home when the route has not supplied a duplicate scope', async () => {
        const session = { id: 'same-session-id', serverId: 'home-from-session' } as Session;
        const hook = await renderHook(() => useSessionSummaryModel({ session }));

        expect(approvalSessionTargets.at(-1)).toEqual({ serverId: 'home-from-session', sessionId: 'same-session-id' });
        expect(activityInputs.at(-1)).toMatchObject({
            sessionId: 'same-session-id',
            serverId: 'home-from-session',
            session,
        });
        expect(scmInputs.at(-1)).toEqual(['same-session-id', 'home-from-session']);
        expect(usageInputs.at(-1)).toEqual([
            'same-session-id',
            { serverId: 'home-from-session', session },
        ]);
        await hook.unmount();
    });

    it('refuses a route Home that conflicts with the Session-owned Home', async () => {
        const session = { id: 'same-session-id', serverId: 'home-a' } as Session;
        const hook = await renderHook(() => useSessionSummaryModel({ session, serverId: 'home-b' }));

        expect(hook.getCurrent()).toMatchObject({
            scope: 'realm_unavailable',
            title: null,
            rows: [],
        });
        expect(approvalSessionTargets.at(-1)).toBeNull();
        await hook.unmount();
    });

    it('fails closed instead of borrowing same-id facts from the active Home when no Home can be proven', async () => {
        const session = { id: 'same-session-id' } as Session;
        const hook = await renderHook(() => useSessionSummaryModel({ session }));

        expect(hook.getCurrent()).toMatchObject({
            scope: 'realm_unavailable',
            title: null,
            agentLabel: null,
            rows: [],
        });
        expect(approvalSessionTargets.at(-1)).toBeNull();
        expect(activityInputs.at(-1)).toMatchObject({
            sessionId: 'same-session-id',
            serverId: '__unknown_server__',
            session: null,
        });
        expect(scmInputs.at(-1)).toEqual([null, null]);
        expect(usageInputs.at(-1)).toEqual([
            'same-session-id',
            { serverId: '__unknown_server__', session },
        ]);
        await hook.unmount();
    });

    it('composes the canonical Agent-activity count without fetching workflow details', async () => {
        activityCounts.current = { live: 2, total: 3 };
        activityEntries.current = [{ id: 'activity-1', title: 'Reviewing access', status: 'running' }];
        const hook = await renderHook(() => useSessionSummaryModel({
            session: { id: 'session-1' } as Session,
            serverId: 'server-a',
        }));

        expect(hook.getCurrent().rows.find((row) => row.kind === 'activity')).toEqual({
            kind: 'activity',
            liveCount: 2,
            totalCount: 3,
            title: 'Reviewing access',
            statusLabel: 'running',
            destination: 'workTab',
        });
        await hook.unmount();
    });

    it('keeps the last-known context percentage when the canonical usage snapshot is stale', async () => {
        usageState.current = {
            contextSnapshot: {
                v: 1,
                modelId: 'test-model',
                usedTokens: 2_000,
                windowTokens: 8_000,
                totalProcessedTokens: null,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_turn',
            },
            contextSnapshotStale: true,
        };
        const hook = await renderHook(() => useSessionSummaryModel({
            session: { id: 'session-1' } as Session,
            serverId: 'server-a',
        }));

        expect(hook.getCurrent().rows.find((row) => row.kind === 'usage')).toEqual({
            kind: 'usage',
            tokens: 2_000,
            contextPercent: 25,
            stale: true,
            destination: 'usage',
        });
        await hook.unmount();
    });
});
