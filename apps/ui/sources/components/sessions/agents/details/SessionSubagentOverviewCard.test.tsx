import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { renderScreen } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '../sessionSubagentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The detail header renders the SAME row as the roster (A1/A3), configured the SAME way.
 *
 * The card used to hand-roll its own summary: it printed the raw status enum in grey while the
 * roster painted a coloured pill for the same value, so one subagent read as two different things
 * depending on which surface you were on. The contract worth pinning is therefore not "which facts
 * appear" but "this is the shared row, read-only" — the seven `Label: value` pills it used to draw
 * are gone by design (4.3 kill list) and their content belongs to the detail body below it.
 *
 * Sharing the component was not enough on its own: this host mounted it with neither the pinned
 * density nor a staleness value, so the same agent rendered one size LARGER here than in the roster
 * the reader had just pressed to get here, and kept a turning spinner while that roster said it had
 * not been heard from in ten minutes. Both are host configuration, and both are pinned below.
 */

const SESSION_ID = 'session-1';

/** The transcript reducer this card reads its evidence instant out of, per test. */
const reducerRef = vi.hoisted(() => ({
    snapshot: { reducerState: null as unknown, reducerVersion: 0 },
}));

function seedSidechain(sidechainId: string, createdAt: number): void {
    reducerRef.snapshot = {
        reducerState: { sidechains: new Map([[sidechainId, [{ createdAt, text: 'still going' }]]]) },
        reducerVersion: 1,
    };
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
    'session.agentActivity.status.running': 'Running',
    'session.agentActivity.status.succeeded': 'Succeeded',
};

installSessionSubagentCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessionMessagesReducerSnapshot: () => reducerRef.snapshot,
        });
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
                React.createElement('View', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) => {
                if (key === 'session.subagents.kind.execution_run') return 'Subagent';
                if (STATUS_WORDS[key]) return STATUS_WORDS[key];
                return values ? `${key}(${Object.values(values).join(',')})` : key;
            },
        });
    },
});

const EXECUTION_RUN: SessionSubagent = {
    id: 'execution_run:run_1',
    kind: 'execution_run',
    status: 'running',
    display: { title: 'run_1' },
    transcript: { toolMessageRouteId: 'tool:toolu_1', toolId: 'toolu_1', sidechainId: 'toolu_1' },
    runRef: { runId: 'run_1', backendId: 'codex', intent: 'review', runClass: 'long_lived' },
    recipient: { kind: 'execution_run', runId: 'run_1', label: 'run_1' },
    capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
    timestamps: { startedAtMs: 1_000 },
};

describe('SessionSubagentOverviewCard', () => {
    beforeEach(() => {
        reducerRef.snapshot = { reducerState: null, reducerVersion: 0 };
    });

    it('draws the row at the pinned roster density, never the reader’s list preference', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');
        const { AGENT_ACTIVITY_SURFACE_DENSITY, AGENT_STATUS_GLYPH_PX } = await import(
            '@/components/sessions/agentActivity/row/agentRowMetrics'
        );

        const screen = await renderScreen(
            <SessionSubagentOverviewCard sessionId={SESSION_ID} subagent={EXECUTION_RUN} />,
        );

        const mark = screen.findByTestId('session-subagent-overview:execution_run:run_1:status:mark');
        const markStyle = flatten(mark?.props.style);
        expect(markStyle.width).toBe(AGENT_STATUS_GLYPH_PX[AGENT_ACTIVITY_SURFACE_DENSITY]);
        // The default `uiItemDensity` is cozy, one step larger — which is what this header used to
        // inherit, so the same agent was bigger here than in the roster behind it.
        expect(markStyle.width).not.toBe(AGENT_STATUS_GLYPH_PX.cozy);

        await screen.unmount();
    });

    it('goes quiet when its agent has, instead of spinning against the roster’s silence note', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        // Eleven minutes past the last thing this agent's sidechain actually said.
        seedSidechain('toolu_1', Date.now() - 11 * 60_000);

        const screen = await renderScreen(
            <SessionSubagentOverviewCard sessionId={SESSION_ID} subagent={EXECUTION_RUN} />,
        );

        // The same evidence instant and the same threshold the roster uses, so the two surfaces
        // cannot describe one agent two ways.
        expect(screen.getTextContent()).toContain('session.agentActivity.staleness.stale');

        await screen.unmount();
    });

    it('claims nothing about silence when it has no evidence of activity', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        // No sidechain in the reducer: we have not looked, which is not the same as "nothing
        // happened" — and inventing a note here would be a claim about our own hydration.
        const screen = await renderScreen(
            <SessionSubagentOverviewCard sessionId={SESSION_ID} subagent={EXECUTION_RUN} />,
        );

        expect(screen.getTextContent()).not.toContain('session.agentActivity.staleness');

        await screen.unmount();
    });

    it('renders the shared agent-activity row, so the detail cannot disagree with the roster', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        const screen = await renderScreen(
            <SessionSubagentOverviewCard sessionId={SESSION_ID} subagent={EXECUTION_RUN} />,
        );

        const row = screen.findByTestId('session-subagent-overview:execution_run:run_1');
        expect(row).toBeTruthy();
        // A1: a translated status word, never the raw enum — the exact drift this card caused.
        expect(
            screen.findByTestId('session-subagent-overview:execution_run:run_1:status')?.props.accessibilityLabel,
        ).toBe('Running');
        expect(screen.getTextContent()).not.toContain('running');
        // A5: the seven fact pills are gone, and nothing reintroduced a status pill beside the row.
        expect(screen.getTextContent()).not.toContain('Type:');
        expect(screen.getTextContent()).not.toContain('Backend:');
    });

    it('is read-only: no press target and no overflow on the thing you already opened', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        const screen = await renderScreen(
            <SessionSubagentOverviewCard sessionId={SESSION_ID} subagent={EXECUTION_RUN} />,
        );

        expect(screen.findByTestId('session-subagent-overview:execution_run:run_1:overflow')).toBeNull();
        expect(
            screen.findByTestId('session-subagent-overview:execution_run:run_1')?.props.onPress,
        ).toBeUndefined();
    });

    it('shows a finished agent as finished, with an elapsed total rather than a live clock', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        const subagent: SessionSubagent = {
            id: 'subagent_sidechain:opaque-task',
            kind: 'subagent_sidechain',
            status: 'succeeded',
            display: { title: 'Inspect integration', providerLabel: 'Cursor' },
            transcript: { toolMessageRouteId: 'server:message-1', toolId: 'opaque-task' },
            nativeRef: {
                lifecycle: 'completion_only',
                type: 'custom',
                customType: 'specialist',
                model: 'cursor-model',
                agentId: 'cursor-agent-1',
                durationMs: 1_500,
            },
            recipient: null,
            capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: false },
            timestamps: { startedAtMs: 500, finishedAtMs: 2_000 },
        };

        const screen = await renderScreen(
            <SessionSubagentOverviewCard sessionId={SESSION_ID} subagent={subagent} />,
        );

        expect(
            screen.findByTestId('session-subagent-overview:subagent_sidechain:opaque-task:status')?.props.accessibilityLabel,
        ).toBe('Succeeded');
        // A frozen total from the entry's own timestamps: 500ms -> 2000ms is one second and change.
        expect(
            String(screen.findByTestId('session-subagent-overview:subagent_sidechain:opaque-task:elapsed')?.props.children ?? ''),
        ).toBe('0:01');
    });
});

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flatten));
    }
    return (style ?? {}) as Record<string, unknown>;
}
