import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { SessionExecutionRunInfoCard } from '@/components/sessions/runs/details/SessionExecutionRunInfoCard';
import { t } from '@/text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { deriveExecutionRunSubagents } from '@/sync/domains/session/subagents/executionRuns/deriveExecutionRunSubagents';

import { resolveAgentActivityEntryFromSubagent } from './fromSubagent';
import { deriveAgentActivityEntries, toAgentActivityCountable } from '@/sync/domains/session/agentActivity/deriveAgentActivityEntries';
import { deriveAgentActivityCounts } from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';
import { toLocalAgentActivityEntry } from '@/sync/domains/session/agentActivity/sources/fromSessionSubagents';
import { buildAgentActivitySectionModel } from '../list/agentActivitySectionModel';

const STARTED_AT = Date.parse('2026-05-12T00:00:00.000Z');

describe('retained execution-run current work', () => {
    it('keeps idle handles sendable while only the busy sibling counts and spins, then reopens work on send', async () => {
        const messages: readonly ToolCallMessage[] = ['busy', 'idle'].map((runId) => ({
            kind: 'tool-call', id: `message-${runId}`, localId: null, createdAt: STARTED_AT,
            tool: {
                id: `tool-${runId}`, name: 'SubAgentRun', state: 'completed',
                input: { runId, intent: 'delegate', runClass: 'long_lived', ioMode: 'streaming' },
                result: { runId, status: 'succeeded' },
                createdAt: STARTED_AT, startedAt: STARTED_AT, completedAt: STARTED_AT + 1_000,
                description: null,
            }, children: [],
        }));
        const project = (turnInFlight: boolean) => {
            const subagents = deriveExecutionRunSubagents({ messages, activeExecutionRuns: [
                { runId: 'idle', status: 'running', runClass: 'long_lived', turnInFlight },
                { runId: 'busy', status: 'running', runClass: 'long_lived', turnInFlight: true },
            ] });
            const rows = subagents.map((subagent) => resolveAgentActivityEntryFromSubagent({ subagent }));
            const merged = deriveAgentActivityEntries({ headline: null, local: subagents.map((subagent, i) =>
                toLocalAgentActivityEntry({ subagent, projection: rows[i]! })) });
            return { subagents, rows, counts: deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable)) };
        };
        const idle = project(false);
        expect(idle.subagents.find((subagent) => subagent.id === 'execution_run:idle'))
            .toMatchObject({ status: 'running', isActive: false, capabilities: { canSend: true, canStop: true } });
        expect(idle.counts.live).toBe(1);
        expect(buildAgentActivitySectionModel({ entries: idle.rows }).sections.map((section) => [section.id, section.entries.map((row) => row.id)]))
            .toEqual([['working', ['execution_run:busy']], ['idle', ['execution_run:idle']]]);

        const { AgentActivityRow } = await import('../row/AgentActivityRow');
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
        const idleRow = idle.rows.find((row) => row.id === 'execution_run:idle');
        expect(idleRow).toBeDefined();
        const screen = await renderScreen(<AgentActivityRow entry={idleRow!} onPress={() => {}} testID="idle-row" />);
        expect(screen.findAllHostsByTestId('idle-row').some((host) => host.props.accessibilityState?.busy === false)).toBe(true);
        expect(screen.findAllHostsByTestId('idle-row:elapsed')).toHaveLength(0);
        expect(screen.tree.findAllByType(ActivitySpinner)).toHaveLength(0);

        expect(project(true).counts.live).toBe(2);
        expect(project(false).counts.live).toBe(1);
    });

    it('keeps permission attention separate from idle work counts and still counts a failed run', () => {
        const failedMessage: ToolCallMessage = {
            kind: 'tool-call', id: 'failed-message', localId: null, createdAt: STARTED_AT,
            tool: {
                id: 'failed-tool', name: 'SubAgentRun', state: 'completed',
                input: { runId: 'failed', intent: 'delegate', runClass: 'long_lived', ioMode: 'streaming' },
                result: { runId: 'failed', status: 'failed' },
                createdAt: STARTED_AT, startedAt: STARTED_AT, completedAt: STARTED_AT + 1_000,
                description: null,
            }, children: [],
        };
        const subagents = deriveExecutionRunSubagents({ messages: [failedMessage], activeExecutionRuns: [
            { runId: 'idle', status: 'running', runClass: 'long_lived', turnInFlight: false },
            { runId: 'busy', status: 'running', runClass: 'long_lived', turnInFlight: true },
        ] });
        const local = subagents.map((subagent) => toLocalAgentActivityEntry({
            subagent,
            projection: resolveAgentActivityEntryFromSubagent({
                subagent, hasPendingPermission: subagent.runRef?.runId === 'idle',
            }),
        }));
        expect(local.find((entry) => entry.runId === 'idle')).toMatchObject({ status: 'waiting', isActive: false });
        const merged = deriveAgentActivityEntries({ headline: null, local });
        expect(deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable))).toMatchObject({ live: 1, failed: 1 });
    });

    it('keeps missing turn evidence conservative and bounded runs active even when false is supplied', () => {
        const subagents = deriveExecutionRunSubagents({ messages: [], activeExecutionRuns: [
            { runId: 'legacy', status: 'running', runClass: 'long_lived' },
            { runId: 'bounded', status: 'running', runClass: 'bounded', turnInFlight: false },
        ] });
        expect(subagents.map((subagent) => subagent.isActive)).toEqual([true, true]);
    });

    it('shows idle current work in the direct run row and run details', async () => {
        const run = ExecutionRunPublicStateSchema.parse({
            runId: 'idle', callId: 'call-idle', sidechainId: 'sidechain-idle', intent: 'delegate',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default',
            retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'streaming', status: 'running',
            turnInFlight: false, startedAtMs: STARTED_AT,
        });
        const row = await renderScreen(<ExecutionRunRow run={run} />);
        const card = await renderScreen(<SessionExecutionRunInfoCard run={run} />);
        expect(JSON.stringify(row.tree.toJSON())).toContain(t('diagnosis.machineRuns.idle'));
        expect(JSON.stringify(card.tree.toJSON())).toContain(t('diagnosis.machineRuns.idle'));
    });
});

function makeSubagent(overrides: Partial<SessionSubagent> = {}): SessionSubagent {
    return {
        id: 'execution_run:run_1',
        kind: 'execution_run',
        status: 'running',
        display: { title: 'Audit the reducer' },
        transcript: {},
        recipient: null,
        capabilities: {
            canOpen: true,
            canSend: false,
            canStop: false,
            canLaunchChild: false,
            canDelete: false,
            canOpenAdvancedRun: false,
        },
        timestamps: { startedAtMs: STARTED_AT },
        ...overrides,
    } as SessionSubagent;
}

describe('resolveAgentActivityEntryFromSubagent — timestamps pass through as derived (D-8)', () => {
    it('carries both instants when the finish is genuinely known', () => {
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({
                status: 'succeeded',
                timestamps: { startedAtMs: STARTED_AT, finishedAtMs: STARTED_AT + 16_000 },
            }),
        });

        expect(entry.startedAtMs).toBe(STARTED_AT);
        expect(entry.endedAtMs).toBe(STARTED_AT + 16_000);
    });

    it('carries an unfinished agent’s start with no finish', () => {
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({ status: 'running' }),
        });

        expect(entry.startedAtMs).toBe(STARTED_AT);
        expect(entry.endedAtMs).toBeNull();
    });

    it('never substitutes the finish for a missing start', () => {
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({
                status: 'succeeded',
                timestamps: { finishedAtMs: STARTED_AT + 16_000 },
            }),
        });

        expect(entry.startedAtMs).toBeNull();
    });

    it('reports a pending permission as waiting without disturbing the clock', () => {
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({ status: 'running' }),
            hasPendingPermission: true,
        });

        expect(entry.status).toBe('waiting');
        expect(entry.startedAtMs).toBe(STARTED_AT);
    });
});

describe('resolveAgentActivityEntryFromSubagent — the meta line is a liveness signal (D-8 corridor)', () => {
    it('does not show a finished agent’s last reply as its subtitle', () => {
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({
                status: 'succeeded',
                display: { title: 'Audit the reducer', providerLabel: 'codex' },
                timestamps: { startedAtMs: STARTED_AT, finishedAtMs: STARTED_AT + 16_000 },
            }),
            activityPreview: 'OK',
        });

        expect(entry.metaDetail).not.toBe('OK');
        // The identity line is what a finished row can still say truthfully.
        expect(entry.metaDetail).toContain('codex');
    });

    it('still shows what a live agent is doing', () => {
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({ status: 'running' }),
            activityPreview: 'Reading executionRunSubagentStatus.ts',
        });

        expect(entry.metaDetail).toBe('Reading executionRunSubagentStatus.ts');
    });
});

describe('AgentActivityRow — the composed path renders no elapsed rather than 0:00 (D-8)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(STARTED_AT + 42_000));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders no elapsed column for a finished agent with no recorded finish', async () => {
        const { AgentActivityRow } = await import('../row/AgentActivityRow');
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({ status: 'succeeded', timestamps: { startedAtMs: STARTED_AT } }),
        });

        const screen = await renderScreen(<AgentActivityRow entry={entry} testID="row" />);

        // Host-restricted: a composite that forwards `testID` and renders `null` still matches the
        // plain query, which would make this pass for the wrong reason.
        expect(screen.findAllHostsByTestId('row:elapsed')).toHaveLength(0);
        // Guard against a vacuous pass: the row itself must actually be on screen.
        expect(screen.findAllHostsByTestId('row').length).toBeGreaterThan(0);
    });

    it('renders the true total for a finished agent whose finish is known', async () => {
        const { AgentActivityRow } = await import('../row/AgentActivityRow');
        const entry = resolveAgentActivityEntryFromSubagent({
            subagent: makeSubagent({
                status: 'succeeded',
                timestamps: { startedAtMs: STARTED_AT, finishedAtMs: STARTED_AT + 16_000 },
            }),
        });

        const screen = await renderScreen(<AgentActivityRow entry={entry} testID="row" />);

        const elapsed = screen.findAllHostsByTestId('row:elapsed');
        expect(elapsed.length).toBeGreaterThan(0);
        expect(elapsed.at(-1)?.props?.children).toBe('0:16');
    });
});

/**
 * The whole chain, on the shape P3-B captured on a real device.
 *
 * Its trace is the specification: the clock ticked `0:00 -> 0:09` correctly, then collapsed to
 * `0:00` ~836 ms BEFORE the status flipped. The lead is explained by the two fields coming from
 * different places — the transcript marks the run finished immediately, while `effectiveStatus`
 * stays `running` until the 5 s execution-run poll drops it — so a fix that only satisfies the
 * settled state would still show a zero during that window. Both frames are asserted.
 */
describe('execution run -> row, end to end (D-8 device trace)', () => {
    const REQUESTED_AT = Date.parse('2026-05-12T00:00:00.000Z');
    const RUN_ID = 'run_0f1e2d3c4b5a';

    function createFinishedRunMessage(): ToolCallMessage {
        return {
            kind: 'tool-call',
            id: 'message_subagent_run',
            localId: null,
            createdAt: REQUESTED_AT,
            tool: {
                id: 'tool_subagent_run',
                name: 'SubAgentRun',
                state: 'completed',
                input: { runId: RUN_ID, label: 'Delegate', intent: 'delegate' },
                createdAt: REQUESTED_AT,
                startedAt: REQUESTED_AT,
                // The result landed sixteen seconds later — the number the row must show.
                completedAt: REQUESTED_AT + 16_000,
                description: null,
                result: { status: 'succeeded', runId: RUN_ID, sidechainId: 'sidechain_1' },
            },
            children: [],
        } as ToolCallMessage;
    }

    async function renderRunRow(messages: readonly Message[], activeRunStatus?: string) {
        const subagents = deriveExecutionRunSubagents({
            messages,
            ...(activeRunStatus ? { activeExecutionRuns: [{ runId: RUN_ID, status: activeRunStatus }] } : {}),
        });
        const subagent = subagents.find((candidate) => candidate.id === `execution_run:${RUN_ID}`);
        expect(subagent, 'fixture must derive the execution run').toBeDefined();

        const entry = resolveAgentActivityEntryFromSubagent({ subagent: subagent! });
        const { AgentActivityRow } = await import('../row/AgentActivityRow');
        const screen = await renderScreen(<AgentActivityRow entry={entry} testID="row" />);
        return {
            status: entry.status,
            elapsed: screen.findAllHostsByTestId('row:elapsed').at(-1)?.props?.children ?? null,
        };
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(REQUESTED_AT + 20_000));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows the true total once the run has settled', async () => {
        const { status, elapsed } = await renderRunRow([createFinishedRunMessage()]);

        expect(status).toBe('succeeded');
        expect(elapsed).toBe('0:16');
    });

    it('shows the true total during the window where the poll still calls the run running', async () => {
        const { status, elapsed } = await renderRunRow([createFinishedRunMessage()], 'running');

        // Exactly P3-B's ~836 ms window: the transcript is terminal, the registry has not caught up.
        expect(status).toBe('running');
        expect(elapsed).toBe('0:16');
    });
});
