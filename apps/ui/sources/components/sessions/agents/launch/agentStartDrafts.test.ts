import { describe, expect, it } from 'vitest';
import { SessionDraftDocumentV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import type { PaneDetailsStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { executionRunLauncherDraftFieldPath, readSessionLauncherDraftKeysFromDraft, readSessionLauncherDraftPreviewFromDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { executionRunLauncherDraftKey, projectAgentStartDrafts } from './agentStartDrafts';

function tab(key: string, kind: string, resource: unknown) {
    return { key, kind, title: key, resource, isPreview: false, isPinned: false };
}

function details(tabs: ReturnType<typeof tab>[], activeTabKey: string | null, isOpen = true): PaneDetailsStateView {
    return {
        isOpen,
        tabState: {},
        tabs,
        activeTabKey,
        groups: [{ id: 'g1', tabKeys: tabs.map((entry) => entry.key), activeTabKey, tabs, isFocused: true }],
        root: null,
        focusedGroupId: 'g1',
        maximizedGroupId: null,
    };
}

describe('projectAgentStartDrafts', () => {
    it('keeps comparison source drafts separate and never reads comparison identity as a role', () => {
        const comparison = { cwd: '/repo', comparison: { kind: 'branch' as const, base: 'main', head: 'HEAD' },
            scopeLabel: 'main → HEAD', defaultWalkthrough: true };
        const first = executionRunLauncherDraftKey({ intent: 'review', comparisonReview: comparison });
        const second = executionRunLauncherDraftKey({ intent: 'review', comparisonReview: { ...comparison,
            comparison: { kind: 'workingTree' as const } } });
        expect(first).not.toBe(second);
        expect(first).not.toBe(executionRunLauncherDraftKey({ intent: 'review' }));
        expect(projectAgentStartDrafts(null, [first, second])).toEqual([
            { key: first, tabKey: null, intent: 'review', roleId: null, comparison: true, active: false },
            { key: second, tabKey: null, intent: 'review', roleId: null, comparison: true, active: false },
        ]);
    });
    it('keeps two Discussion previews distinct from a retained plain conversation', () => {
        const discussionTabs = ['selection_1', 'selection_2'].map((draftCorrelationId) => {
            const discussion = createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({
                source: { kind: 'discussion', serverId: 'server-a', discussionId: 'discussion_1', messageIds: ['message_1'], draftCorrelationId },
                initialText: 'Selected context',
            });
            return tab(discussion.key, discussion.kind, discussion.resource);
        });
        const field = (value: unknown) => ({ mutationId: '00000000-0000-4000-8000-000000000001', value });
        const document = SessionDraftDocumentV2Schema.parse({
            v: 1,
            composer: { text: field(''), mentions: field([]), attachments: field([]) },
            target: { kind: 'session', routing: { recipient: field(null), agentContinuation: field(null), executionRunDelivery: field(null) } },
            extensions: { happier: Object.fromEntries([
                ['conversation', 'Plain conversation'],
                ['discussion:selection_1', 'First Discussion'],
                ['discussion:selection_2', 'Second Discussion'],
            ].map(([key, text]) => [executionRunLauncherDraftFieldPath(key!, 'text').fieldId, field(text)])) },
        });
        const drafts = projectAgentStartDrafts(details(discussionTabs, discussionTabs[0]!.key), readSessionLauncherDraftKeysFromDraft(document));

        expect(drafts.map(({ key, tabKey }) => ({ key, tabKey }))).toEqual([
            { key: 'discussion:selection_1', tabKey: discussionTabs[0]!.key },
            { key: 'discussion:selection_2', tabKey: discussionTabs[1]!.key },
            { key: 'conversation', tabKey: null },
        ]);
        expect(drafts.map(({ key }) => readSessionLauncherDraftPreviewFromDraft(document, key)))
            .toEqual(['First Discussion', 'Second Discussion', 'Plain conversation']);
    });

    it('lists each unsent start by what it will start, marking the one on screen', () => {
        const drafts = projectAgentStartDrafts(details([
            tab('execution-run-conversation-draft', 'executionRunLauncher', { kind: 'executionRunLauncher', mode: 'conversation' }),
            tab('execution-run-launcher:review', 'executionRunLauncher', { kind: 'executionRunLauncher', intent: 'review' }),
            tab('execution-run:run_1', 'executionRun', { kind: 'executionRun', runId: 'run_1' }),
            tab('execution-run-launcher', 'executionRunLauncher', { kind: 'executionRunLauncher' }),
        ], 'execution-run-launcher:review'));

        expect(drafts).toEqual([
            { key: 'conversation', tabKey: 'execution-run-conversation-draft', intent: null, roleId: null, active: false },
            { key: 'review', tabKey: 'execution-run-launcher:review', intent: 'review', roleId: null, active: true },
            // The intent-less launcher is "Advanced": a review with every choice.
            { key: 'review', tabKey: 'execution-run-launcher', intent: 'review', roleId: null, active: false },
        ]);
    });

    it('lists nothing once the draft has become its Run, and marks nothing while Details is closed', () => {
        expect(projectAgentStartDrafts(details([
            tab('execution-run:run_1', 'executionRun', { kind: 'executionRun', runId: 'run_1' }),
        ], 'execution-run:run_1'))).toEqual([]);
        expect(projectAgentStartDrafts(details([
            tab('execution-run-launcher:plan', 'executionRunLauncher', { kind: 'executionRunLauncher', intent: 'plan' }),
        ], 'execution-run-launcher:plan', false))[0]?.active).toBe(false);
    });

    it('keeps an unsent draft listed when no tab shows it, such as on a phone or after its tab closed', () => {
        const open = details([
            tab('execution-run-launcher:review', 'executionRunLauncher', { kind: 'executionRunLauncher', intent: 'review' }),
        ], 'execution-run-launcher:review');

        const drafts = projectAgentStartDrafts(open, ['review', 'conversation', 'plan:role_a', 'discussion:corr_1', 'not-a-draft']);

        // The open tab already shows `review`; a Discussion draft belongs to its selection, not to Work.
        expect(drafts).toEqual([
            { key: 'review', tabKey: 'execution-run-launcher:review', intent: 'review', roleId: null, active: true },
            { key: 'conversation', tabKey: null, intent: null, roleId: null, active: false },
            { key: 'plan:role_a', tabKey: null, intent: 'plan', roleId: 'role_a', active: false },
        ]);
        expect(projectAgentStartDrafts(null, ['conversation'])).toEqual([
            { key: 'conversation', tabKey: null, intent: null, roleId: null, active: false },
        ]);
    });
});
