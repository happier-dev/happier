import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
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

const STARTED_AT = Date.parse('2026-05-12T00:00:00.000Z');

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
