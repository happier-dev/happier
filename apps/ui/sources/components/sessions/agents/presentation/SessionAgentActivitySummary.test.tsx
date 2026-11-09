import * as React from 'react';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { HappierWorkSummary } from '@happier-dev/plugin-ui/presentation';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { NO_SESSION_AGENT_ACTIVITY_ATTENTION, type AgentActivityEntry } from '@/sync/domains/session/agentActivity';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { SessionAgentActivitySummary } = await import('./SessionAgentActivitySummary');
const { resolveSessionAgentActivityPresentation } = await import('./sessionAgentActivityPresentation');
const { workStatusWordStyle } = await import('@/components/work/status/workStatusTreatment');

function entry(status: AgentActivityEntry['status']): AgentActivityEntry {
    return {
        id: 'execution_run:run_1',
        kind: 'execution_run',
        status,
        title: 'Review',
        metaDetail: null,
        startedAtMs: 1,
        endedAtMs: 2,
        provenance: 'merged',
        detailState: 'loaded',
        parentId: null,
        runId: 'run_1',
        sidechainId: null,
        subagentId: null,
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    };
}

async function stateWordStyle(status: AgentActivityEntry['status']) {
    const presentation = resolveSessionAgentActivityPresentation({ entry: entry(status) });
    const screen = await renderScreen(<SessionAgentActivitySummary presentation={presentation} testID="row" />);
    return StyleSheet.flatten(screen.findHostByTestId('row:state:label')?.props.style) ?? {};
}

describe('SessionAgentActivitySummary', () => {
    it('withdraws the retained live elapsed clock and reopens at the current start and status', async () => {
        const now = Date.parse('2026-09-30T12:00:00.000Z');
        vi.useFakeTimers({ now });
        const census = installTimerCensus((stack) => stack.includes('agentActivityClock') ? 'elapsed' : null);
        const initial = { ...entry('running'), startedAtMs: now - 2_000, endedAtMs: null };
        const draw = (active: boolean, value: AgentActivityEntry = initial) => <PluginSurfaceFocusEligibilityProvider active={active}>
            <SessionAgentActivitySummary presentation={resolveSessionAgentActivityPresentation({ entry: value })} testID="live" />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(draw(true));
        try {
            expect(census.read()).toEqual([{ kind: 'interval', delayMs: 1000, consumer: 'elapsed' }]);
            const first = screen.findByTestId('live:elapsed')?.props.children;
            await screen.update(draw(false));
            const before = census.readFires();
            await act(async () => { vi.advanceTimersByTime(300_000); });
            expect(census.readFires()).toEqual(before);
            expect(census.read()).toEqual([]);
            await screen.update(draw(true));
            expect(screen.findByTestId('live:elapsed')?.props.children).not.toBe(first);
            const updated = { ...initial, status: 'succeeded' as const, endedAtMs: Date.now() };
            await screen.update(draw(true, updated));
            expect(screen.findByTestId('live:elapsed')).toBeNull();
            expect(screen.findByTestId('live:live')).toBeNull();
            expect(census.read()).toEqual([]);
        } finally {
            await screen.unmount();
            census.stop();
            vi.useRealTimers();
        }
    });
    it('keeps a finished age on its display deadline while the genuine live elapsed leaf advances', async () => {
        const now = Date.parse('2026-09-30T12:00:00.000Z');
        vi.useFakeTimers({ now });
        const finished = resolveSessionAgentActivityPresentation({ entry: { ...entry('succeeded'), endedAtMs: now - 3_570_000 } });
        const live = resolveSessionAgentActivityPresentation({ entry: { ...entry('running'), startedAtMs: now - 2_000, endedAtMs: null } });
        const screen = await renderScreen(<><SessionAgentActivitySummary presentation={finished} showTime testID="finished" />
            <SessionAgentActivitySummary presentation={live} testID="live" /></>);
        try {
            expect(screen.getTextContent()).toContain('59m');
            const elapsed = screen.findByTestId('live:elapsed')?.props.children;
            expect(elapsed).toBeDefined();
            await act(async () => { vi.advanceTimersByTime(1_000); });
            expect(screen.findByTestId('live:elapsed')?.props.children).not.toBe(elapsed);
            expect(screen.getTextContent()).toContain('59m');
            await act(async () => { vi.advanceTimersByTime(28_999); });
            expect(screen.getTextContent()).toContain('59m');
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(screen.getTextContent()).toContain('1h');
        } finally {
            await act(async () => screen.tree.unmount());
            expect(vi.getTimerCount()).toBe(0);
            vi.useRealTimers();
        }
    });
    it('words an ended unit in the one work-status treatment: a timeout asks for attention, a failure is trouble', async () => {
        // Ended work reads the same here as on the Work row, the run row and the worker card (INT T4).
        expect(await stateWordStyle('timedOut')).toMatchObject(StyleSheet.flatten(workStatusWordStyle('attention')));
        expect(await stateWordStyle('failed')).toMatchObject(StyleSheet.flatten(workStatusWordStyle('danger')));
        expect(await stateWordStyle('succeeded')).toMatchObject(StyleSheet.flatten(workStatusWordStyle('neutral')));
    });

    it('draws through the shared Work summary leaf plugin authors use', async () => {
        const presentation = resolveSessionAgentActivityPresentation({ entry: entry('running') });
        const screen = await renderScreen(<SessionAgentActivitySummary presentation={presentation} testID="row" />);
        const shared = screen.findAll((node) => node.type === HappierWorkSummary
            || node.type === (HappierWorkSummary as unknown as { type?: unknown }).type);
        expect(shared).toHaveLength(1);
        expect(screen.findByTestId('row:live')).not.toBeNull();
    });
});
