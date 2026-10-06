import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import type { WorkflowAnnouncementState } from './workflowAnnouncementSelection';

/**
 * What arriving at a workflow surface announces.
 *
 * The comparison baseline used to be the empty state, which nobody was ever
 * shown — so simply opening a screen announced its blocks as newly inserted, or
 * an already-finished Run as having just finished. Only what changes after the
 * first observed state is a transition.
 */

const announcements = vi.hoisted(() => ({ messages: [] as string[] }));

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: (message: string) => { announcements.messages.push(message); },
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
    });
});

afterEach(async () => {
    announcements.messages.length = 0;
    await standardCleanup();
});

function state(overrides: Partial<WorkflowAnnouncementState> = {}): WorkflowAnnouncementState {
    return {
        blockIds: [],
        selectedBlockId: null,
        blockingIssue: null,
        attentionCount: 0,
        terminal: null,
        changedRowCount: 0,
        selectedRowChanged: false,
        attentionHasMore: false,
        historyIncomplete: false,
        ...overrides,
    } as WorkflowAnnouncementState;
}

async function renderAnnouncements(initial: WorkflowAnnouncementState, enabled = true) {
    const { useWorkflowAnnouncements } = await import('./useWorkflowAnnouncements');
    return renderHook(
        (props: Readonly<{ state: WorkflowAnnouncementState; enabled: boolean }>) => useWorkflowAnnouncements({
            state: props.state,
            enabled: props.enabled,
            resolveBlockLabel: (blockId) => blockId,
        }),
        { initialProps: { state: initial, enabled } },
    );
}

describe('useWorkflowAnnouncements', () => {
    it('announces a removed block using its last committed human label', async () => {
        const { useWorkflowAnnouncements } = await import('./useWorkflowAnnouncements');
        const hook = await renderHook(useWorkflowAnnouncements, { initialProps: {
            state: state({ blockIds: ['action-1'] }),
            resolveBlockLabel: (id: string) => id === 'action-1' ? 'Notify me' : id,
        } });
        await hook.rerender({ state: state(), resolveBlockLabel: (id: string) => id });
        expect(announcements.messages).toEqual(['workflows.a11y.removed:{"block":"Notify me","total":0}']);
    });
    it('says nothing about the state it arrives at', async () => {
        // Three blocks and a finished Run are what this surface *is*, not
        // something that just happened while the reader was listening.
        await renderAnnouncements(state({
            blockIds: ['analyze', 'implement', 'review'],
            terminal: 'completed',
            attentionCount: 2,
        }));

        expect(announcements.messages).toEqual([]);
    });

    it('announces the first committed change after that', async () => {
        const hook = await renderAnnouncements(state({ blockIds: ['analyze'] }));
        expect(announcements.messages).toEqual([]);

        await hook.rerender({
            state: state({ blockIds: ['analyze', 'implement'] }),
            enabled: true,
        });

        expect(announcements.messages).toHaveLength(1);
    });

    it('keeps a delayed surface baselined on what it was already showing', async () => {
        // The Run screen enables announcements only once its invocation window
        // has loaded. Enabling must not replay everything observed while quiet.
        const hook = await renderAnnouncements(state({ blockIds: ['analyze'] }), false);
        await hook.rerender({
            state: state({ blockIds: ['analyze', 'implement'], attentionCount: 3 }),
            enabled: false,
        });
        expect(announcements.messages).toEqual([]);

        await hook.rerender({
            state: state({ blockIds: ['analyze', 'implement'], attentionCount: 3 }),
            enabled: true,
        });
        expect(announcements.messages).toEqual([]);
    });

    it('says loaded instead of a total while more attention pages remain', async () => {
        const hook = await renderAnnouncements(state({ attentionCount: 2, attentionHasMore: true }));
        expect(announcements.messages).toEqual([]);

        await hook.rerender({
            state: state({ attentionCount: 4, attentionHasMore: true }),
            enabled: true,
        });

        // The same construction the visible needs-you header uses: a count of
        // loaded rows, never a claim about every step that will need you.
        expect(announcements.messages).toEqual(['4 workflows.a11y.needsYouLoaded']);
    });

    it('keeps a terminal summary neutral while attention pages remain', async () => {
        const hook = await renderAnnouncements(state({ attentionCount: 2, attentionHasMore: true }));

        await hook.rerender({
            state: state({ attentionCount: 2, attentionHasMore: true, terminal: 'completed' }),
            enabled: true,
        });

        expect(announcements.messages).toEqual([
            'workflows.a11y.terminal:{"state":"workflows.runState.completed"}',
        ]);
    });

    it('says the attention part of progress as loaded while attention pages remain', async () => {
        const hook = await renderAnnouncements(
            state({ attentionCount: 1, attentionHasMore: true, changedRowCount: 0 }),
        );

        await hook.rerender({
            state: state({ attentionCount: 1, attentionHasMore: true, changedRowCount: 2 }),
            enabled: true,
        });

        expect(announcements.messages).toEqual([
            'workflows.a11y.progress:{"count":2}; 1 workflows.a11y.needsYouLoaded',
        ]);
    });

    it('says a progress count as loaded while history pages remain', async () => {
        const hook = await renderAnnouncements(state({ changedRowCount: 0, historyIncomplete: true }));

        await hook.rerender({
            state: state({ changedRowCount: 3, historyIncomplete: true }),
            enabled: true,
        });

        expect(announcements.messages).toEqual(['workflows.a11y.progressLoaded:{"count":3}']);
    });
});
