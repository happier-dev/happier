import * as React from 'react';
import { I18nManager } from 'react-native';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { SessionSummaryCard } from './SessionSummaryCard';
import type { SessionSummaryCardModel } from './sessionSummaryProjection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
        plan: null,
        facts: [],
        ...overrides,
    };
}

describe('SessionSummaryCard (the Companion hero)', () => {
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
    it('presents a native permission with the offered choices of the shared prompt card and answers the exact choice', async () => {
        const respondToPermission = vi.fn(async () => {});
        const nativeChoices = {
            requirementId: 'occurrence', source: 'native',
            choices: [
                { id: 'once', label: 'Allow once', decision: 'approved' as const, scope: 'once' as const, response: { approved: true } },
                { id: 'reject', label: 'Reject', decision: 'denied' as const, scope: 'once' as const, response: { approved: false } },
            ],
        };
        const request = { id: 'permission', kind: 'permission' as const, tool: 'Shell', arguments: { command: 'pwd' }, createdAt: 100, nativeChoices };
        const screen = await renderWithSessionTranscriptSource(
            <AppPaneProvider>
                <SessionSummaryCard
                    model={model({ needsYou: { request, moreCount: 0 } })}
                    density="compact"
                    session={createSessionFixture({ id: 'session-1', active: true, presence: 'online', serverId: 'home-a' })}
                    serverId="home-a"
                />
            </AppPaneProvider>,
            createTestSessionTranscriptSource({
                sessionId: 'session-1', serverId: 'home-a',
                agentState: { requests: { permission: { tool: request.tool, arguments: request.arguments, createdAt: 100, nativeChoices } } },
                interaction: { canSendMessages: true, canApprovePermissions: true },
                actions: { respondToPermission, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
            }),
        );
        expect(screen.findByTestId('permission-prompt-card')).not.toBeNull();
        expect(screen.findByTestId('session-companion-summary-allow')).toBeNull();
        const once = screen.findAll((node) => typeof node.type === 'string' && node.props.testID === 'permission-footer.choice.once')[0];
        expect(once?.props.accessibilityState?.disabled).not.toBe(true);
        await act(async () => { once?.props.onPress(); });
        expect(respondToPermission).toHaveBeenCalledWith(expect.objectContaining({
            id: 'permission', nativeChoice: expect.objectContaining({ requirementId: 'occurrence', choiceId: 'once' }),
        }));
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

    it('shows the waiting-for-you status and its timer', async () => {
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({ needsYou: { request: { id: 'req-1', kind: 'permission', tool: 'Bash', arguments: {}, createdAt: 1_000 }, moreCount: 0 },
                    sinceMs: Date.now() })}
                density="compact"
            />,
        );

        expect(screen.findByTestId('session-companion-summary-status')?.props.children)
            .toBe('sessionCompanion.status.waitingForYou');
        expect(screen.findByTestId('session-companion-summary-timer')).not.toBeNull();
        await screen.unmount();
    });

    it('opens each fact and the dedicated Recap row at its existing owner in a compact card', async () => {
        const openWorkTab = vi.fn();
        const openGit = vi.fn();
        const openApprovals = vi.fn();
        const openFull = vi.fn();
        const screen = await renderScreen(
            <SessionSummaryCard
                model={model({
                    nowLine: 'Testing the next change',
                    rows: [
                        { kind: 'work', label: 'Testing the next change', status: null, destination: 'work' },
                        { kind: 'approvals', count: 1, destination: 'approvals' },
                        { kind: 'workflow', runCount: 2, destination: 'workTab' },
                        { kind: 'recap', text: 'Wrapped up the resize test', source: 'synopsis', destination: 'workTab' },
                    ],
                    facts: [
                        { kind: 'runningWork', count: 2, destination: 'workTab' },
                        { kind: 'changes', count: 14, destination: 'git' },
                        { kind: 'context', percent: 62, stale: false, destination: 'usage' },
                    ],
                })}
                density="compact"
                destinations={{ workTab: openWorkTab, git: openGit, approvals: openApprovals }}
                onOpenFullSurface={openFull}
            />,
        );

        screen.findByTestId('session-companion-summary-fact-runningWork')?.props.onPress();
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
