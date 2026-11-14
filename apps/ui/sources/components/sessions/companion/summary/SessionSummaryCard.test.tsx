import * as React from 'react';
import { I18nManager } from 'react-native';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import type { SessionPendingPermission } from '@/sync/ops/sessionPendingPermissions';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { SessionSummaryCard } from './SessionSummaryCard';
import type { SessionSummaryCardModel } from './sessionSummaryProjection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ASK: SessionPendingPermission = {
    requestId: 'req-1',
    toolName: 'Bash',
    canApprove: true,
    summary: 'Run yarn test:ui',
    command: 'yarn test:ui',
    createdAtMs: 1_000,
    policy: { protocol: 'standard', usePermissionUpdates: false },
    answers: ['allowOnce', 'allowForSession', 'deny'],
};

function model(overrides: Partial<SessionSummaryCardModel> = {}): SessionSummaryCardModel {
    return {
        scope: 'exact',
        title: 'Fix settings modal remount',
        agentLabel: 'Claude',
        agentId: null,
        status: { state: 'thinking', statusText: 'Working', quiet: false },
        stale: false,
        availability: 'complete',
        encryption: 'plain',
        identityDestination: 'sessionInfo',
        rows: [],
        needsYou: null,
        sinceMs: null,
        progress: null,
        plan: null,
        facts: [],
        ...overrides,
    };
}

describe('SessionSummaryCard (the Companion hero)', () => {
    it('retires the answered receipt clock after its existing visibility window', async () => {
        vi.useFakeTimers({ now: Date.parse('2026-09-30T12:00:00.000Z') });
        const census = installTimerCensus((stack) => stack.includes('sessionListRuntimeClock') ? 'receipt' : null);
        const answerPermission = vi.fn(async () => {});
        const screen = await renderScreen(<SessionSummaryCard model={model({ needsYou: { request: ASK, moreCount: 0 } })}
            density="compact" answerPermission={answerPermission} />);
        try {
            await act(async () => { screen.pressByTestId('session-companion-summary-allow'); });
            await screen.update(<SessionSummaryCard model={model()} density="compact" answerPermission={answerPermission} />);
            expect(screen.findByTestId('session-companion-summary-answered')).not.toBeNull();
            // The existing visibility predicate includes the exact 60-second boundary.
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(screen.findByTestId('session-companion-summary-answered')).not.toBeNull();
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(screen.findByTestId('session-companion-summary-answered')).toBeNull();
            const before = census.readFires();
            await act(async () => { vi.advanceTimersByTime(300_000); });
            expect(census.readFires()).toEqual(before);
            expect(census.read()).toEqual([]);
        } finally {
            await screen.unmount();
            census.stop();
            vi.useRealTimers();
        }
    });
    it('pauses the retained receipt deadline while hidden and reopens with the expired receipt gone', async () => {
        vi.useFakeTimers({ now: Date.parse('2026-09-30T12:00:00.000Z') });
        const census = installTimerCensus((stack) => stack.includes('sessionListRuntimeClock') ? 'receipt' : null);
        const answerPermission = vi.fn(async () => {});
        const draw = (active: boolean, needsYou: SessionSummaryCardModel['needsYou']) =>
            <PluginSurfaceFocusEligibilityProvider active={active}>
                <SessionSummaryCard model={model({ needsYou })} density="compact" answerPermission={answerPermission} />
            </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(draw(true, { request: ASK, moreCount: 0 }));
        try {
            await act(async () => { screen.pressByTestId('session-companion-summary-allow'); });
            await screen.update(draw(true, null));
            expect(screen.findByTestId('session-companion-summary-answered')).not.toBeNull();
            await screen.update(draw(false, null));
            const before = census.readFires();
            await act(async () => { vi.advanceTimersByTime(300_000); });
            expect(census.readFires()).toEqual(before);
            expect(census.read()).toEqual([]);
            await screen.update(draw(true, null));
            expect(screen.findByTestId('session-companion-summary-answered')).toBeNull();
            const nextAsk = { ...ASK, requestId: 'req-2', summary: 'New permission request' };
            await screen.update(draw(true, { request: nextAsk, moreCount: 0 }));
            await act(async () => { screen.pressByTestId('session-companion-summary-deny'); });
            await screen.update(draw(true, null));
            expect(answerPermission).toHaveBeenLastCalledWith(nextAsk, 'deny');
            expect(screen.findByTestId('session-companion-summary-answered')).not.toBeNull();
        } finally {
            await screen.unmount();
            census.stop();
            vi.useRealTimers();
        }
    });
    it('uses the compact widget summary with a truthful full-surface route and expands detail for a tall body', async () => {
        const openFull = vi.fn();
        const summary = model({ rows: [
            { kind: 'approvals', count: 1, destination: 'approvals' },
            { kind: 'workflow', runCount: 2, destination: 'workTab' },
        ] });
        const render = (size: 'small' | 'tall') => <WidgetPresentationProvider value={{ size,
            footprint: { columns: 2, columnSpan: 1, rowSpan: size === 'small' ? 1 : 4,
                width: 'half', height: size === 'small' ? 'compact' : 'tall' } }}>
            <SessionSummaryCard model={summary} density="comfortable" presentation="full" onOpenFullSurface={openFull} />
        </WidgetPresentationProvider>;
        const screen = await renderScreen(render('small'));
        expect(screen.findByTestId('session-companion-summary-more')).not.toBeNull();
        screen.pressByTestId('session-companion-summary-more');
        expect(openFull).toHaveBeenCalledOnce();
        await screen.update(render('tall'));
        expect(screen.findByTestId('session-companion-summary-more')).toBeNull();
        expect(screen.findByTestId('session-companion-summary-row-approvals')).not.toBeNull();
    });
    it('renders a pending question through the shared prompt controls instead of permission answers', async () => {
        const answerUserAction = vi.fn(async () => {});
        const request = {
            id: 'question', kind: 'user_action' as const, tool: 'AskUserQuestion', createdAt: 100,
            arguments: { questions: [{ header: 'Direction', question: 'Which direction?', options: [{ label: 'Keep', description: 'Keep it' }], multiSelect: false }] },
        };
        const screen = await renderWithSessionTranscriptSource(
            <AppPaneProvider>
                <SessionSummaryCard
                    model={model({ needsYou: { request, moreCount: 1 } })}
                    density="compact"
                    session={createSessionFixture({ active: true, presence: 'online', serverId: 'home-a' })}
                    serverId="home-a"
                />
            </AppPaneProvider>,
            createTestSessionTranscriptSource({
                sessionId: 'session-1', serverId: 'home-a',
                agentState: { requests: { question: { tool: request.tool, kind: request.kind, arguments: request.arguments, createdAt: 100 } } },
                interaction: { canSendMessages: true, canApprovePermissions: true },
                actions: { answerUserAction, respondToPermission: async () => {}, abort: async () => {}, submitMessage: async () => {} },
            }),
        );
        expect(screen.findByTestId('user-action-prompt-card')).not.toBeNull();
        expect(screen.findByTestId('ask-user-question')).not.toBeNull();
        expect(screen.findByTestId('session-companion-summary-allow')).toBeNull();
        expect(screen.findByTestId('ask-user-question.option:0:0')?.props.disabled).toBe(false);
        expect(screen.findByTestId('session-companion-summary-ask-more-waiting')).not.toBeNull();
        await act(async () => { screen.findByTestId('ask-user-question.option:0:0')?.props.onPress(); });
        await act(async () => { screen.findByTestId('ask-user-question.submit')?.props.onPress(); });
        expect(answerUserAction).toHaveBeenCalledWith({ id: 'question', answers: { 'Which direction?': ['Keep'] } });
    });

    it('does not admit question answers from the hidden measurement copy', async () => {
        const answerUserAction = vi.fn(async () => {});
        const request = {
            id: 'question', kind: 'user_action' as const, tool: 'AskUserQuestion', createdAt: 100,
            arguments: { questions: [{ question: 'Which direction?', options: [{ label: 'Keep' }], multiSelect: false }] },
        };
        const screen = await renderWithSessionTranscriptSource(
            <AppPaneProvider>
                <SessionSummaryCard
                    model={model({ needsYou: { request, moreCount: 0 } })}
                    density="compact"
                    session={createSessionFixture({ active: true, presence: 'online', serverId: 'home-a' })}
                    serverId="home-a"
                    readOnly
                />
            </AppPaneProvider>,
            {
                ...createTestSessionTranscriptSource({
                    sessionId: 'session-1', serverId: 'home-a',
                    agentState: { requests: { question: { tool: request.tool, kind: request.kind, arguments: request.arguments, createdAt: 100 } } },
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                    actions: { answerUserAction, respondToPermission: async () => {}, abort: async () => {}, submitMessage: async () => {} },
                }),
                kind: 'app',
            },
        );
        expect(screen.findByTestId('ask-user-question.option:0:0')?.props.disabled).toBe(true);
        await act(async () => { screen.findByTestId('ask-user-question.option:0:0')?.props.onPress(); });
        await act(async () => { screen.findByTestId('ask-user-question.submit')?.props.onPress(); });
        expect(answerUserAction).not.toHaveBeenCalled();
    });

    it('names an unproven Home as unavailable and presents no invented status line', async () => {
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({ scope: 'realm_unavailable', status: null, availability: 'locked', encryption: 'unknown' })}
                density="compact"
            />,
        );

        expect(screen.findByTestId('session-companion-summary-availability')?.props.children)
            .toBe('sessionBoard.board.unavailable.reason');
        expect(screen.findByTestId('session-companion-summary-status')).toBeNull();
    });

    it('explains canonical locked content instead of silently looking complete', async () => {
        const screen = await renderScreen(
            <SessionSummaryCard model={model({ availability: 'locked', encryption: 'locked' })} density="compact" />,
        );

        expect(screen.findByTestId('session-companion-summary-availability')?.props.children)
            .toBe('status.encryptedUnavailable');
        expect(screen.findByTestId('session-companion-summary-status')).toBeNull();
    });

    it('titles itself with what it is and says the state on the line beneath, never the state as its title', async () => {
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({ status: { state: 'disconnected', statusText: 'Offline', quiet: false } })}
                density="compact"
            />,
        );
        try {
            expect(screen.findByTestId('session-companion-summary-title')?.props.children)
                .toBe('sessionBoard.companion.summary.title');
            expect(screen.findByTestId('session-companion-summary-status')?.props.children).toBe('Offline');
        } finally { await screen.unmount(); }
    });

    it('says the present in words: waiting for you, and the plan step the agent paused before', async () => {
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({ needsYou: { request: ASK, moreCount: 0 }, sinceMs: Date.now(), progress: { step: 4, total: 5 } })}
                density="compact"
            />,
        );

        expect(screen.findByTestId('session-companion-summary-status')?.props.children)
            .toBe('sessionCompanion.status.waitingForYou');
        expect(screen.findByTestId('session-companion-summary-what')?.props.children)
            .toBe('sessionCompanion.status.pausedBeforeStep(agent=Claude,step=4,total=5)');
        expect(screen.findByTestId('session-companion-summary-timer')).not.toBeNull();
    });

    it('answers the ask in place through the shared answer owner, then folds into one confirmation', async () => {
        let resolveAnswer: () => void = () => {};
        const answerPermission = vi.fn(() => new Promise<void>((resolve) => { resolveAnswer = resolve; }));
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({ needsYou: { request: ASK, moreCount: 0 } })}
                density="compact"
                answerPermission={answerPermission}
            />,
        );

        await act(async () => { screen.findByTestId('session-companion-summary-allow')?.props.onPress(); });
        expect(answerPermission).toHaveBeenCalledWith(ASK, 'allowOnce');
        // One answer at a time: the ask cannot be answered twice while the first is in flight.
        expect(screen.findByTestId('session-companion-summary-deny')?.props.disabled).toBe(true);

        await act(async () => { resolveAnswer(); });
        // The Session state the chat card reads drops the answered ask.
        await act(async () => {
            await screen.update(<SessionSummaryCard model={model()} density="compact" answerPermission={answerPermission} />);
        });
        expect(screen.findByTestId('session-companion-summary-ask')).toBeNull();
        expect(screen.findByTestId('session-companion-summary-answered')).not.toBeNull();
    });

    it('keeps the ask when the answer does not reach the session, and says so', async () => {
        const answerPermission = vi.fn(async () => { throw new Error('offline'); });
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({ needsYou: { request: ASK, moreCount: 0 } })}
                density="compact"
                answerPermission={answerPermission}
            />,
        );

        await act(async () => { screen.findByTestId('session-companion-summary-deny')?.props.onPress(); });
        expect(screen.findByTestId('session-companion-summary-ask-reason')?.props.children).toBe('sessionCompanion.ask.failed');
        expect(screen.findByTestId('session-companion-summary-allow')?.props.disabled).toBe(false);
    });

    it('keeps an unanswerable ask disabled without inventing machine reachability from Session status', async () => {
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({
                    status: { state: 'disconnected', statusText: 'Disconnected', quiet: false },
                    needsYou: { request: { ...ASK, answers: [] }, moreCount: 0 },
                })}
                density="compact"
                answerPermission={vi.fn(async () => {})}
                machineName="MacBook Pro"
            />,
        );

        expect(screen.findByTestId('session-companion-summary-allow')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-companion-summary-ask-reason')?.props.children)
            .toBe('sessionCompanion.ask.notAllowed');
    });

    it('opens each fact and the dedicated Recap row at its existing owner in a compact card', async () => {
        const openWorkTab = vi.fn();
        const openGit = vi.fn();
        const openApprovals = vi.fn();
        const openFull = vi.fn();
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({
                    rows: [
                        { kind: 'work', label: 'Testing the next change', status: null, destination: 'work' },
                        { kind: 'approvals', count: 1, destination: 'approvals' },
                        { kind: 'workflow', runCount: 2, destination: 'workTab' },
                        { kind: 'recap', text: 'Wrapped up the resize test', source: 'synopsis', destination: 'workTab' },
                    ],
                    facts: [
                        { kind: 'subagents', live: 2, total: 3, destination: 'workTab' },
                        { kind: 'changes', count: 14, destination: 'git' },
                        { kind: 'context', percent: 62, stale: false, destination: 'usage' },
                    ],
                })}
                density="compact"
                destinations={{ workTab: openWorkTab, git: openGit, approvals: openApprovals }}
                onOpenFullSurface={openFull}
            />,
        );

        screen.findByTestId('session-companion-summary-fact-subagents')?.props.onPress();
        screen.findByTestId('session-companion-summary-fact-changes')?.props.onPress();
        screen.findByTestId('session-companion-summary-row-approvals')?.props.onPress();
        expect(openWorkTab).toHaveBeenCalledTimes(1);
        expect(openGit).toHaveBeenCalledTimes(1);
        expect(openApprovals).toHaveBeenCalledTimes(1);
        // A fact with no handler is quiet text, never a dead button.
        expect(screen.findByTestId('session-companion-summary-fact-context')?.props.onPress).toBeUndefined();
        expect(screen.findByTestId('session-companion-summary-what')?.props.children).toBe('Testing the next change');
        const recap = screen.findByTestId('session-companion-summary-row-recap');
        expect(recap).not.toBeNull();
        expect(recap?.props.accessibilityLabel).toContain('sessionCompanion.recap.title');
        expect(recap?.props.accessibilityLabel).toContain('Wrapped up the resize test');
        screen.pressByTestId('session-companion-summary-row-recap');
        expect(openWorkTab).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('session-companion-summary-more')).toBeNull();
    });

    it('keeps Recap navigable in a compact widget without repeating it in the status line', async () => {
        const openWorkTab = vi.fn();
        const screen = await renderScreen(
            <WidgetPresentationProvider value={{ size: 'small', footprint: {
                columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact',
            } }}>
                <SessionSummaryCard
                    model={model({ rows: [{ kind: 'recap', text: 'Runbook published', source: 'worker_update', destination: 'workTab' }] })}
                    density="compact"
                    destinations={{ workTab: openWorkTab }}
                    onOpenFullSurface={() => undefined}
                />
            </WidgetPresentationProvider>,
        );
        expect(screen.findByTestId('session-companion-summary-row-recap')).not.toBeNull();
        expect(screen.findByTestId('session-companion-summary-what')).toBeNull();
        screen.pressByTestId('session-companion-summary-row-recap');
        expect(openWorkTab).toHaveBeenCalledOnce();
    });

    it('mirrors every directional disclosure caret in RTL', async () => {
        const previousIsRTL = I18nManager.isRTL;
        (I18nManager as { isRTL: boolean }).isRTL = true;
        try {
            const screen = await renderScreen(
                <SessionSummaryCard
                    model={model({
                        rows: [
                            { kind: 'approvals', count: 1, destination: 'approvals' },
                            { kind: 'workflow', runCount: 1, destination: 'workTab' },
                        ],
                    })}
                    density="compact"
                    destinations={{ approvals: () => undefined, workTab: () => undefined }}
                    onOpenFullSurface={() => undefined}
                />,
            );

            const carets = screen.findAllByProps({ name: 'caret-right' });
            expect(carets.length).toBeGreaterThan(0);
            for (const caret of carets) {
                expect(caret.props.mirrored).toBe(true);
            }
        } finally {
            (I18nManager as { isRTL: boolean }).isRTL = previousIsRTL;
        }
    });
});
