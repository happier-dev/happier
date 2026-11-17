import { describe, expect, it, vi } from 'vitest';

import {
    AgentSessionRuntimeEventV1Schema,
    type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol/runtime/agentSessionV1';
import { SessionTurnMutationV1Schema, type SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';

import { createSessionTurnLifecycle } from './lifecycle';
import { projectAutomationSessionLifecycleLaunchProfileId } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { logger } from '@/ui/logger';

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
    return AgentSessionRuntimeEventV1Schema.parse({
        sequence: ++nextRuntimeEventSequence,
        ...input,
        ...(input.kind === 'turn-start' && input.startedBy === undefined
            ? { startedBy: 'host' }
            : {}),
    });
}

describe('createSessionTurnLifecycle', () => {
    it.each([
        { kind: 'turn-complete', action: 'complete' },
        { kind: 'turn-failed', action: 'fail', diagnostic: { code: 'provider_error', severity: 'error' } },
        { kind: 'turn-cancelled', action: 'cancel', cause: 'user' },
    ])('stamps the selected launch profile on begin and $kind without exposing its id', async ({ action, ...terminal }) => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({ session: {
            sessionId: 'profile-session', getMetadataSnapshot: () => ({ profileId: 'selected-profile' }),
            enqueueSessionTurnMutation: mutation => { mutations.push(SessionTurnMutationV1Schema.parse(mutation)); },
        } });
        try {
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'profile-session', turnId: 'profile-turn', emittedAtMs: 1 }));
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ ...terminal, sessionId: 'profile-session', turnId: 'profile-turn', emittedAtMs: 2 }));
            await lifecycle.drainAcceptedLifecycle();
            expect(mutations.filter(mutation => mutation.action === 'begin' || mutation.action === action)).toEqual([
                expect.objectContaining({ action: 'begin', automationLifecycleFacts: { launchProfileId: projectAutomationSessionLifecycleLaunchProfileId('selected-profile') } }),
                expect.objectContaining({ action, automationLifecycleFacts: { launchProfileId: projectAutomationSessionLifecycleLaunchProfileId('selected-profile') } }),
            ]);
            expect(JSON.stringify(mutations)).not.toContain('selected-profile');
        } finally { lifecycle.dispose(); }
    });

    it('leaves a quiet native turn active without scheduling silence diagnostics', async () => {
        vi.useFakeTimers();
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: { sessionId: 'quiet-session', enqueueSessionTurnMutation: mutation => { mutations.push(mutation); } },
        });
        try {
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
                kind: 'turn-start', sessionId: 'quiet-session', turnId: 'quiet-turn', emittedAtMs: 1,
            }));
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(15 * 60_000);
            expect(lifecycle.hasActiveTurn()).toBe(true);
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
                kind: 'turn-complete', sessionId: 'quiet-session', turnId: 'quiet-turn', emittedAtMs: 15 * 60_000,
            }));
            await lifecycle.drainAcceptedLifecycle();
            expect(lifecycle.hasActiveTurn()).toBe(false);
            expect(mutations.map(mutation => mutation.action)).toEqual(['begin', 'complete']);
        } finally { lifecycle.dispose(); vi.useRealTimers(); }
    });

    it('projects exact-turn retries, clears on real progress and Stop, and suppresses unchanged facts', async () => {
        const progress: unknown[] = [];
        const mutations: SessionTurnMutationV1[] = [];
        const options = {
            session: { sessionId: 'retry-session', enqueueSessionTurnMutation: (mutation: SessionTurnMutationV1) => { mutations.push(mutation); } },
            onTurnProgressChanged: (input: unknown) => { progress.push(input); },
        };
        const lifecycle = createSessionTurnLifecycle(options);
        const send = (input: Readonly<Record<string, unknown>>) => lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            sessionId: 'retry-session', turnId: 'retry-turn', emittedAtMs: 100, ...input,
        }));
        send({ kind: 'turn-start' });
        const retry = { attempt: 1, reason: 'connection_failed' };
        send({ kind: 'turn-progress', retry });
        send({ kind: 'turn-progress', retry });
        send({ kind: 'turn-progress', retry: { ...retry, attempt: 2 }, emittedAtMs: 101 });
        send({ kind: 'turn-progress', turnId: 'foreign-turn' });
        send({ kind: 'turn-progress', sessionId: 'foreign-session' });
        send({ kind: 'turn-agent-id-observed', agentTurnId: 'next-native-attempt' });
        expect(progress).toEqual([
            { progress: null, observedAt: 100 },
            { progress: { turnId: 'retry-turn', phase: 'retrying', ...retry }, observedAt: 100 },
            { progress: { turnId: 'retry-turn', phase: 'retrying', ...retry, attempt: 2 }, observedAt: 101 },
        ]);
        send({ kind: 'turn-progress', emittedAtMs: 102 });
        for (let i = 0; i < 100; i++) send({ kind: 'turn-progress', emittedAtMs: 103 + i });
        expect(progress).toHaveLength(4);
        expect(progress[3]).toEqual({ progress: null, observedAt: 102 });
        send({ kind: 'turn-progress', retry, emittedAtMs: 203 });
        send({ kind: 'turn-cancelled', cause: 'user', emittedAtMs: 204 });
        send({ kind: 'turn-cancelled', cause: 'user', emittedAtMs: 205 });
        send({ kind: 'turn-progress', retry, emittedAtMs: 206 });
        expect(lifecycle.hasActiveTurn()).toBe(false);
        expect(progress.slice(-2)).toEqual([
            { progress: { turnId: 'retry-turn', phase: 'retrying', ...retry }, observedAt: 203 },
            { progress: null, observedAt: 204 },
        ]);
        await lifecycle.drainAcceptedLifecycle();
        expect(mutations.filter(mutation => mutation.action === 'cancel')).toHaveLength(1);
        expect(mutations.filter(mutation => mutation.action === 'touch_active')).toHaveLength(0);
    });

    it('retains a native carrier close through the failed turn without inventing a Team denial', async () => {
        const { createSessionBrokerApplicationEvidence } = await import('@/providers/broker/sessionBrokerApplicationEvidence');
        const evidence = createSessionBrokerApplicationEvidence({ sessionId: 'carrier-session', pid: process.pid,
            readActiveTurnId: () => 'carrier-turn', isCurrent: () => true });
        let nativeReads = 0;
        const carrierFailure = { closingSide: 'initiator', closingStage: 'local_http_head' } as const;
        evidence.observeCarrierFailure(async () => { nativeReads++; return carrierFailure; });
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'carrier-session',
            enqueueSessionTurnMutation: async mutation => { mutations.push(SessionTurnMutationV1Schema.parse(mutation)); } },
            readTeamCredentialFailureEvidence: turnId => evidence.readFailureEvidence(turnId),
        });
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'carrier-session', turnId: 'carrier-turn', emittedAtMs: 1 }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-failed', sessionId: 'carrier-session', turnId: 'carrier-turn', emittedAtMs: 2,
            diagnostic: { code: 'codex_app_server_turn_failed', severity: 'error', message: 'Native transport closed' } }));
        await lifecycle.drainAcceptedLifecycle();
        const failed = mutations.find(mutation => mutation.action === 'fail');
        expect(failed).toMatchObject({ issue: { source: 'agent_session_error', failureCause: { carrierFailure } } });
        if (!failed || failed.action !== 'fail') throw new Error('Missing failure mutation');
        expect(failed.issue.teamCredential).toBeUndefined();
        expect(nativeReads).toBe(1);
    });

    it.each([false, true])('records payload-free enrichment outcomes without extra evidence reads or mutation writes (logging failed=%s)', async loggingFailed => {
        const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => { if (loggingFailed) throw new Error('File logging unavailable'); });
        let reads = 0;
        const mutations: SessionTurnMutationV1[] = [];
        try {
            for (const scenario of ['applied', 'evidence_absent', 'read_failed', 'cancellation', 'non_team_failure'] as const) {
                const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'logged-session',
                    enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
                    ...(scenario === 'non_team_failure' ? {} : { readTeamCredentialFailureEvidence: async () => {
                        reads++;
                        if (scenario === 'read_failed') throw new Error('secret evidence read payload');
                        return { denial: scenario === 'applied' ? { v: 1 as const, resourceId: 'private-resource', reasonCode: 'resource_forbidden' as const } : null };
                    } }),
                });
                lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'logged-session', turnId: scenario, emittedAtMs: 1 }));
                lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ sessionId: 'logged-session', turnId: scenario, emittedAtMs: 2,
                    ...(scenario === 'cancellation' ? { kind: 'turn-cancelled', cause: 'user' } : {
                        kind: 'turn-failed', diagnostic: { code: 'codex_app_server_turn_failed', severity: 'error', message: 'private native payload' },
                    }) }));
                await lifecycle.drainAcceptedLifecycle();
            }
            const context = { stage: 'failure_enrichment', sessionId: 'logged-session', pid: process.pid };
            expect(log.mock.calls.filter(([, record]) => record && typeof record === 'object'
                && 'stage' in record && record.stage === 'failure_enrichment').map(([, record]) => record)).toEqual([
                { ...context, turnId: 'applied', outcome: 'applied' },
                { ...context, turnId: 'evidence_absent', outcome: 'skipped', reason: 'evidence_absent' },
                { ...context, turnId: 'read_failed', outcome: 'skipped', reason: 'evidence_absent' },
            ]);
            expect(reads).toBe(3); // One per eligible failure; no cancellation or diagnostic probes.
            expect(mutations.map(mutation => mutation.action)).toEqual(['begin', 'fail', 'begin', 'fail', 'begin', 'fail', 'begin', 'cancel', 'begin', 'fail']);
        } finally { log.mockRestore(); }
    });

    it.each(['accepted', 'mutation_failed', 'marker_failed', 'no_publisher', 'logger_failed'] as const)(
        'records exact begin/terminal publication with %s custody', async scenario => {
            const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => { if (scenario === 'logger_failed') throw new Error('File logging unavailable'); });
            let writes = 0;
            let markers = 0;
            try {
                const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'logged-session',
                    ...(scenario === 'no_publisher' ? {} : { enqueueSessionTurnMutation: async () => {
                        writes++;
                        if (scenario === 'mutation_failed') throw new Error('secret persistence payload');
                    } }),
                }, onAcceptedTurnLifecycle: async marker => {
                    markers++;
                    if (scenario === 'marker_failed' && marker.event !== 'task_started') throw new Error('secret marker payload');
                } });
                lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'logged-session', turnId: 'logged-turn', emittedAtMs: 1 }));
                lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'logged-session', turnId: 'logged-turn', emittedAtMs: 2 }));
                await lifecycle.drainAcceptedLifecycle();
                const context = { stage: 'turn_publication', sessionId: 'logged-session', turnId: 'logged-turn', pid: process.pid };
                const records = log.mock.calls.filter(([, record]) => record && typeof record === 'object'
                    && 'stage' in record && record.stage === 'turn_publication').map(([, record]) => record);
                expect(records).toEqual(scenario === 'mutation_failed' ? [
                    { ...context, action: 'begin', outcome: 'failed', reason: 'mutation_failed' },
                ] : scenario === 'marker_failed' ? [
                    { ...context, action: 'complete', outcome: 'failed', reason: 'marker_failed' },
                ] : []);
                expect(writes).toBe(scenario === 'no_publisher' ? 0 : scenario === 'mutation_failed' ? 1 : 2);
                expect(markers).toBe(scenario === 'no_publisher' ? 0 : scenario === 'mutation_failed' ? 1 : 2);
            } finally { log.mockRestore(); }
        },
    );

    it('writes no investigation records for successful turns', async () => {
        const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const mutations: SessionTurnMutationV1[] = [];
        try {
            const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'quiet-session',
                enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
                onAcceptedTurnLifecycle: async () => {},
            });
            for (let turn = 0; turn < 100; turn++) {
                lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'quiet-session', turnId: `turn-${turn}`, emittedAtMs: turn * 2 }));
                lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'quiet-session', turnId: `turn-${turn}`, emittedAtMs: turn * 2 + 1 }));
            }
            await lifecycle.drainAcceptedLifecycle();
            expect(mutations).toHaveLength(200);
            expect(log.mock.calls.filter(([label]) => label === '[provider-broker-application]')).toHaveLength(0);
        } finally { log.mockRestore(); }
    });

    it('retains refused begin identity without a retry timer or a terminal marker clear', async () => {
        vi.useFakeTimers();
        const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const mutations: SessionTurnMutationV1[] = [];
        let attempts = 0;
        const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'retry-session',
            enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
            onAcceptedTurnLifecycle: async () => {
                attempts++;
                throw new Error('private marker failure');
            },
        });
        try {
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'retry-session', turnId: 'retry-turn', emittedAtMs: 1 }));
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'retry-session', turnId: 'retry-turn', emittedAtMs: 2 }));
            await vi.advanceTimersByTimeAsync(500);
            expect(attempts).toBe(1);
            expect(vi.getTimerCount()).toBe(0);
            expect(mutations).toEqual([]);
            await lifecycle.drainAcceptedLifecycle();
            expect(log.mock.calls.filter(([label]) => label === '[provider-broker-application]')).toEqual([
                ['[provider-broker-application]', { stage: 'turn_publication', sessionId: 'retry-session', turnId: 'retry-turn',
                    pid: process.pid, action: 'begin', outcome: 'failed', reason: 'marker_failed' }],
            ]);
        } finally {
            lifecycle.retireAcceptedLifecyclePublication();
            await vi.advanceTimersByTimeAsync(50);
            await lifecycle.drainAcceptedLifecycle();
            log.mockRestore();
            vi.useRealTimers();
        }
        expect(mutations).toEqual([]);
    });

    it.each(['accepted', 'unavailable'] as const)('keeps confirmed open usable when local mutation custody is %s', async custody => {
        const mutations: unknown[] = [];
        const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'confirmed-session',
            enqueueSessionTurnMutation: async mutation => {
                mutations.push(mutation);
                if (custody === 'unavailable') throw new Error('fixture local custody unavailable');
            },
        } });
        await expect(lifecycle.confirmSessionOpened()).resolves.toBeUndefined();
        expect(mutations.map(mutation => SessionTurnMutationV1Schema.parse(mutation))).toEqual([
            expect.objectContaining({ action: 'session_opened', sessionId: 'confirmed-session' }),
        ]);
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('publishes the exact accepted failure issue once per turn to the recovery observer', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const accepted = vi.fn(async (_event: unknown, _issue: unknown) => {});
        const lifecycle = createSessionTurnLifecycle({
            session: { sessionId: 'accepted-issues', async enqueueSessionTurnMutation(mutation) { mutations.push(mutation); } },
            agentId: 'claude', onAcceptedTurnFailure: accepted,
        });
        for (const [turnId, emittedAtMs] of [['first-turn', 1000], ['second-turn', 3000]] as const) {
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'accepted-issues', turnId, emittedAtMs }));
            const failed = canonicalRuntimeEvent({ kind: 'turn-failed', sessionId: 'accepted-issues', turnId, emittedAtMs: emittedAtMs + 10,
                diagnostic: { code: 'usage_limit', severity: 'error', message: 'Usage limit reached' } });
            lifecycle.observeRuntimeEvent(failed);
            lifecycle.observeRuntimeEvent(failed);
        }
        await lifecycle.drainAcceptedLifecycle();
        const failed = mutations.filter((mutation) => mutation.action === 'fail');
        expect(accepted).toHaveBeenCalledTimes(2);
        expect(accepted.mock.calls[0]?.[1]).toBe(failed[0]?.issue);
        expect(accepted.mock.calls[1]?.[1]).toBe(failed[1]?.issue);
        expect(accepted.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ occurredAt: 1010 }));
    });

    it.each(['turn-cancelled', 'turn-complete'] as const)(
        'settles the exact yielded question turn as waiting after %s', async kind => {
            const mutations: SessionTurnMutationV1[] = [];
            const markers: unknown[] = [];
            const factsChanged = vi.fn();
            const session = {
                sessionId: 'question-session',
                async enqueueSessionTurnMutation(mutation: SessionTurnMutationV1) { mutations.push(mutation); },
                readQuestionWaitTurnId() { return this.sessionId === 'question-session' ? 'question-turn' : null; },
            };
            const lifecycle = createSessionTurnLifecycle({ session,
                onTurnFactsChanged: factsChanged,
                readTurnFacts: () => ({ initiator: 'user', workDepth: 0 }),
                onAcceptedTurnLifecycle: async marker => { markers.push(marker); },
            });
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: session.sessionId,
                emittedAtMs: 100, turnId: 'question-turn' }));
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind, sessionId: session.sessionId,
                emittedAtMs: 200, turnId: 'question-turn', ...(kind === 'turn-cancelled' ? { cause: 'user' } : {}) }));
            // A later duplicate terminal must not publish a conflicting outcome.
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: session.sessionId,
                emittedAtMs: 210, turnId: 'question-turn' }));
            await lifecycle.drainAcceptedLifecycle();
            expect(mutations.map(mutation => mutation.action)).toEqual(['begin', 'wait']);
            expect(markers).toEqual([
                { event: 'task_started', turnId: 'question-turn' },
                { event: 'assistant_message_end', turnId: 'question-turn' },
            ]);
            expect(lifecycle.hasActiveTurn()).toBe(false);
            expect(factsChanged).toHaveBeenLastCalledWith({ turnId: 'question-turn', facts: null });
        },
    );

    it('keeps later completion, explicit Stop and failures distinct from a question wait', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        let questionWaitTurnId: string | null = 'question-turn';
        const session = Object.assign({ sessionId: 'question-session',
            async enqueueSessionTurnMutation(mutation: SessionTurnMutationV1) { mutations.push(mutation); },
        }, { readQuestionWaitTurnId: () => questionWaitTurnId });
        const lifecycle = createSessionTurnLifecycle({ session });
        for (const [turnId, terminal] of [
            ['answer-turn', 'turn-complete'], ['stopped-turn', 'turn-cancelled'], ['failed-turn', 'turn-failed'],
        ] as const) {
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: session.sessionId,
                emittedAtMs: 100, turnId }));
            if (terminal === 'turn-cancelled') questionWaitTurnId = null; // Explicit Stop withdraws the owner's intent.
            if (terminal === 'turn-failed') questionWaitTurnId = turnId;
            lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: terminal, sessionId: session.sessionId,
                emittedAtMs: 200, turnId,
                ...(terminal === 'turn-cancelled' ? { cause: 'user' } : {}),
                ...(terminal === 'turn-failed' ? { diagnostic: { code: 'session_error', severity: 'error' } } : {}),
            }));
        }
        await lifecycle.drainAcceptedLifecycle();
        expect(mutations.map(mutation => mutation.action)).toEqual(['begin', 'complete', 'begin', 'cancel', 'begin', 'fail']);
    });

    it.each([false, true])('retains the receiver-bound persistence port with marker publication=%s', async markers => {
        // Home mutation persistence is the system boundary; its connection
        // method uses its receiver, as the real ApiSessionClient does.
        const persistence = {
            sessionId: 'receiver-session',
            mutations: [] as SessionTurnMutationV1[],
            async enqueueSessionTurnMutation(mutation: SessionTurnMutationV1) {
                this.mutations.push(mutation);
            },
        };
        const lifecycle = createSessionTurnLifecycle({ session: persistence,
            ...(markers ? { onAcceptedTurnLifecycle: async () => {} } : {}),
        });
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: persistence.sessionId,
            emittedAtMs: 100, turnId: 'receiver-turn' }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: persistence.sessionId,
            emittedAtMs: 200, turnId: 'receiver-turn' }));
        await lifecycle.drainAcceptedLifecycle();
        expect(persistence.mutations).toEqual(expect.arrayContaining([
            expect.objectContaining({ action: 'begin', sessionId: persistence.sessionId, turnId: 'receiver-turn' }),
            expect.objectContaining({ action: 'complete', sessionId: persistence.sessionId, turnId: 'receiver-turn' }),
        ]));
    });

    it('persists qualified quota attribution and the current Agent from a canonical diagnostic', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({ agentId: 'agy',
            session: { sessionId: 'quota-session', enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
        });
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'quota-session', emittedAtMs: 100, turnId: 'quota-turn' }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-failed', sessionId: 'quota-session', emittedAtMs: 200, turnId: 'quota-turn',
            diagnostic: { code: 'provider_usage_limit', severity: 'error', message: 'Usage Limit Reached', details: { v: 1, source: 'usage_limit', runtimeAuthClassification: {
                kind: 'usage_limit', limitCategory: 'usage_limit', serviceId: 'happier.agent.antigravity/antigravity-account', profileId: 'selected-profile', groupId: 'selected-pool',
                resetsAtMs: null, retryAfterMs: null, quotaScope: 'account', planType: null, rateLimits: null, source: 'stable_provider_message',
            } } },
        }));
        await lifecycle.drainAcceptedLifecycle();
        expect(mutations.find(mutation => mutation.action === 'fail')).toMatchObject({ issue: { agentId: 'agy', source: 'usage_limit', usageLimit: {
            connectedService: { serviceId: 'happier.agent.antigravity/antigravity-account', profileId: 'selected-profile', groupId: 'selected-pool' },
        } } });
    });

    it('retains the startup auth cause through host failure publication', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: { sessionId: 'startup-session', enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
        });
        const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', occurredAt: 100,
            error: { code: 'codex_refresh_free_auth_unsupported', details: { reason: 'workspace_incompatible',
                failureCause: { phase: 'authentication', failureReason: 'unknown', reason: 'workspace_incompatible' } } },
        });
        expect(issue.failureCause).toMatchObject({ reason: 'workspace_incompatible' });
        await lifecycle.failTurn({ allocateWhenIdle: true, issue, occurredAt: 100 });
        expect(mutations.find(mutation => mutation.action === 'fail')).toMatchObject({ issue });
    });

    it('orders startup begin before failure persistence without daemon marker callbacks', async () => {
        let releaseBegin!: () => void;
        const begin = new Promise<void>(resolve => { releaseBegin = resolve; });
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: { sessionId: 'startup-session', enqueueSessionTurnMutation: async mutation => {
                // Persistence is the system boundary. A failed write cannot settle
                // a turn until its begin exists in the durable projection.
                if (mutation.action === 'begin') await begin;
                mutations.push(mutation);
            } },
        });
        const failure = lifecycle.failTurn({ allocateWhenIdle: true,
            issue: classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: new Error('Spawn failed') }),
        });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(mutations).toEqual([]);
        } finally {
            releaseBegin();
            await failure;
        }
        expect(mutations.map(mutation => mutation.action)).toEqual(['begin', 'fail']);
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('awaits startup failure persistence before draining without daemon marker callbacks', async () => {
        let releasePersistence!: () => void;
        const persistence = new Promise<void>((resolve) => { releasePersistence = resolve; });
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                // Durable mutation persistence is the system boundary.
                enqueueSessionTurnMutation: async (mutation) => {
                    if (mutation.action === 'fail') await persistence;
                    mutations.push(mutation);
                },
            },
        });
        let drained = false;
        const failure = lifecycle.failTurn({
            allocateWhenIdle: true,
            issue: classifyPrimarySessionRuntimeIssue({
                cause: 'session_error', error: { code: 'daemon_plugin_catalog_unavailable' },
            }),
        }).then(() => { drained = true; });
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(drained).toBe(false);
            releasePersistence();
            await failure;
            expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'fail']);
        } finally {
            releasePersistence();
            await failure;
        }
    });

    it('freezes host turn facts into begin before later inputs change the host snapshot', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        let facts = { initiator: 'agent_session' as const, workDepth: 5 };
        const lifecycle = createSessionTurnLifecycle({
            session: { sessionId: 'session-1', enqueueSessionTurnMutation: async (mutation) => { mutations.push(mutation); } },
            readTurnFacts: () => facts,
        });
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 100, turnId: 'turn-1' }));
        facts = { initiator: 'agent_session', workDepth: 9 };
        await lifecycle.drainAcceptedLifecycle();
        expect(mutations[0]).toMatchObject({ action: 'begin', initiator: 'agent_session', workDepth: 5 });
    });

    it.each(['agent_session', 'user', 'host'] as const)('binds only the exact native input that caused a canonical turn start (%s)', async initiator => {
        const mutations: SessionTurnMutationV1[] = [];
        let activeInput: { inputId: string; turnId: string } | null = {
            inputId: 'accepted-follow-up', turnId: 'turn-2',
        };
        const lifecycle = createSessionTurnLifecycle({
            session: { sessionId: 'session-1', enqueueSessionTurnMutation: async mutation => { mutations.push(mutation); } },
            readStartingInput: () => activeInput,
            readTurnFacts: () => ({ initiator, workDepth: 1 }),
        });
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'session-1',
            emittedAtMs: 100, turnId: 'human-turn' }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1',
            emittedAtMs: 110, turnId: 'human-turn' }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'session-1',
            emittedAtMs: 120, turnId: 'turn-2' }));
        activeInput = null;
        await lifecycle.drainAcceptedLifecycle();
        expect(mutations.filter(mutation => mutation.action === 'begin')).toEqual([
            expect.not.objectContaining({ startingInputId: 'accepted-follow-up' }),
            expect.objectContaining({ action: 'begin', turnId: 'turn-2', startingInputId: 'accepted-follow-up', initiator }),
        ]);
    });

    it('persists the workflow invocation identity with the host frozen depth', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: { sessionId: 'session-1', enqueueSessionTurnMutation: async (mutation) => { mutations.push(mutation); } },
            readTurnFacts: () => ({ initiator: 'workflow', workDepth: 3, workflowInvocation: { runId: 'run-1', invocationRecordId: 'invocation-1' } }),
        });
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 100, turnId: 'turn-1' }));
        await lifecycle.drainAcceptedLifecycle();
        expect(mutations[0]).toMatchObject({ action: 'begin', initiator: 'workflow', workDepth: 3, workflowInvocation: { runId: 'run-1', invocationRecordId: 'invocation-1' } });
    });

    it('records exact begin marker custody before publishing the server begin mutation', async () => {
        let recordMarker!: () => void;
        const markerRecorded = new Promise<void>((resolve) => {
            recordMarker = resolve;
        });
        const enqueueSessionTurnMutation = vi.fn(async () => undefined);
        const onAcceptedTurnLifecycle = vi.fn(async () => {
            await markerRecorded;
        });
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation,
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        await vi.waitFor(() => expect(onAcceptedTurnLifecycle).toHaveBeenCalledOnce());
        expect(enqueueSessionTurnMutation).not.toHaveBeenCalled();

        recordMarker();
        await lifecycle.drainAcceptedLifecycle();
        expect(onAcceptedTurnLifecycle).toHaveBeenCalledWith({
            event: 'task_started',
            turnId: 'turn-1',
        });
        expect(enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
            action: 'begin',
            turnId: 'turn-1',
        }));
        expect(onAcceptedTurnLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
            enqueueSessionTurnMutation.mock.invocationCallOrder[0]!,
        );
    });

    it('retains exact marker custody when server begin persistence rejects', async () => {
        const onAcceptedTurnLifecycle = vi.fn();
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async (mutation) => {
                    if (mutation.action === 'begin') throw new Error('outbox unavailable');
                },
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }));
        await lifecycle.drainAcceptedLifecycle();

        expect(onAcceptedTurnLifecycle).toHaveBeenCalledTimes(1);
        expect(onAcceptedTurnLifecycle).toHaveBeenCalledWith({
            event: 'task_started',
            turnId: 'turn-1',
        });
    });

    it('serializes exact begin before accepted matching terminal publication', async () => {
        let releaseBeginNotification!: () => void;
        const beginNotificationReleased = new Promise<void>((resolve) => {
            releaseBeginNotification = resolve;
        });
        const observed: string[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async () => undefined,
            },
            onAcceptedTurnLifecycle: async (input) => {
                observed.push(`${input.event}:${input.turnId}`);
                if (input.event === 'task_started') await beginNotificationReleased;
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }));
        await vi.waitFor(() => expect(observed).toEqual(['task_started:turn-1']));

        releaseBeginNotification();
        await vi.waitFor(() => {
            expect(observed).toEqual([
                'task_started:turn-1',
                'assistant_message_end:turn-1',
            ]);
        });
    });

    it('publishes a terminal admission override as failed without duplicating a follow-up mutation', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const onAcceptedTurnLifecycle = vi.fn();
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async (mutation) => {
                    mutations.push(mutation);
                    return mutation.action === 'complete'
                        ? { terminalStatusOverride: 'failed' as const }
                        : undefined;
                },
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-admission-failed',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-admission-failed',
        }));
        await lifecycle.drainAcceptedLifecycle();

        expect(onAcceptedTurnLifecycle).toHaveBeenLastCalledWith({
            event: 'assistant_message_end',
            turnId: 'turn-admission-failed',
            terminalStatus: 'failed',
        });
        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
    });

    it('drains writer-owned exact begin publication before cleanup', async () => {
        let releasePublishedBegin!: () => void;
        const publishedBegin = new Promise<void>((resolve) => {
            releasePublishedBegin = resolve;
        });
        const onAcceptedTurnLifecycle = vi.fn(async () => {
            await publishedBegin;
        });
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async () => undefined,
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));

        await vi.waitFor(() => expect(onAcceptedTurnLifecycle).toHaveBeenCalledTimes(1));
        let drained = false;
        const drain = lifecycle.drainAcceptedLifecycle().then(() => {
            drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);

        releasePublishedBegin();
        await drain;
        expect(drained).toBe(true);
    });

    it('retires a rejected accepted-begin publication so cleanup can drain', async () => {
        const onAcceptedTurnLifecycle = vi.fn(async () => {
            throw new Error('daemon is quiescing');
        });
        const enqueueSessionTurnMutation = vi.fn(async () => undefined);
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation,
            },
            onAcceptedTurnLifecycle,
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));

        await vi.waitFor(() => expect(onAcceptedTurnLifecycle).toHaveBeenCalled());
        lifecycle.retireAcceptedLifecyclePublication();
        await lifecycle.drainAcceptedLifecycle();

        expect(enqueueSessionTurnMutation).not.toHaveBeenCalled();
    });

    it('authors no broad terminal when runtime-ended has no active exact turn', () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'runtime-ended',
            sessionId: 'session-1',
            emittedAtMs: 100,
            cause: 'providerEnded',
            retryable: false,
        }));

        expect(mutations).toEqual([]);
    });

    it('fails the exact active turn when the runtime ends without a turn terminal', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'runtime-ended',
            sessionId: 'session-1',
            emittedAtMs: 200,
            cause: 'providerEnded',
            retryable: false,
        }));

        await lifecycle.drainAcceptedLifecycle();
        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'fail']);
        expect(mutations[1]).toMatchObject({
            action: 'fail', turnId: 'turn-1', observedAt: 200,
            issue: { code: 'provider_runtime_ended' },
        });
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('ignores late lifecycle evidence for a turn after its exact terminal event', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: async (mutation) => {
                    mutations.push(mutation);
                },
            },
        });
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 100, turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 200, turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-agent-id-observed', sessionId: 'session-1', emittedAtMs: 300,
            turnId: 'turn-1', agentTurnId: 'late-provider-turn',
        }));
        await lifecycle.drainAcceptedLifecycle();

        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
    });

    it('[p03redesign.F1] keeps an active turn live without durable writes: N active minutes add no turn mutation', async () => {
        // Each durable turn mutation is one server receipt row and one push to every viewer.
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'claude',
            session: { sessionId: 'session-1', enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); } },
        });
        const send = (kind: 'turn-start' | 'turn-progress' | 'turn-complete', emittedAtMs: number) => lifecycle.observeRuntimeEvent(
            canonicalRuntimeEvent({ kind, sessionId: 'session-1', emittedAtMs, turnId: 'turn-1', agentTurnId: 'provider-turn-1' }));
        send('turn-progress', 90);
        send('turn-start', 100);
        const minutes = 10;
        for (let minute = 0; minute <= minutes; minute += 1) send('turn-progress', 250 + minute * 60_000);
        send('turn-complete', 250 + (minutes + 1) * 60_000);
        await lifecycle.drainAcceptedLifecycle();
        // Started and ended are the only state changes; liveness stays with presence.
        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
    });

    it('clears terminal turn state when a terminal mutation write throws synchronously', () => {
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'claude',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    if (mutation.action === 'complete') throw new Error('outbox unavailable');
                },
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));

        expect(() => lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }))).not.toThrow();

        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('clears terminal turn state when a terminal mutation write rejects asynchronously', async () => {
        const enqueueSessionTurnMutation = vi.fn(async (mutation: SessionTurnMutationV1) => {
            if (mutation.action === 'complete') throw new Error('outbox unavailable');
        });
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'claude',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation,
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 200,
            turnId: 'turn-1',
        }));
        await lifecycle.drainAcceptedLifecycle();

        expect(enqueueSessionTurnMutation).toHaveBeenCalledTimes(2);
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('leaves canonical rollback-boundary persistence to the native session owner', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });

        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 100,
            turnId: 'turn-1',
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-rollback-boundary',
            sessionId: 'session-1',
            emittedAtMs: 120,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
            providerCheckpoint: { kind: 'codex_checkpoint', turn: 1 },
        }));
        lifecycle.observeRuntimeEvent(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 130,
            turnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
        }));
        await lifecycle.drainAcceptedLifecycle();

        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
    });
});
