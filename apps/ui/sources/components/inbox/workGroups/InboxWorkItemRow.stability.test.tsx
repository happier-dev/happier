import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildInboxWorkGroups, type InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { en } from '@/text/translations/en';
import { buildInboxItems } from '../inboxItems';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { resolveWorkStatusRowMark } from '@/components/work/status/workStatusRowMark';
import { Icon } from '@/components/ui/icons/Icon';

const paints = vi.hoisted(() => new Map<string, number>());
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Linking: { openURL: openUrl }, View: ({ children, ...props }: React.PropsWithChildren<{ testID?: string }>) => {
        if (props.testID?.endsWith('.summary')) paints.set(props.testID, (paints.get(props.testID) ?? 0) + 1);
        return React.createElement('View', props, children);
    } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { tLoose, setPreferredLanguageFromSettings } = await vi.importActual<typeof import('@/text/i18n')>('@/text/i18n');
    setPreferredLanguageFromSettings('en');
    return createTextModuleMock({ translate: (key, options) => key === 'workflows.run.attentionWaitRow' ? `${options?.step} is waiting for you`
        : key === 'workflows.run.attentionWaitRowMore' ? `${options?.step} and ${options?.count} more wait for you`
        : key === 'workflows.run.attentionApprovalRow' ? `Approve ${options?.step}`
        : key.startsWith('files.') ? tLoose(key) : key });
});
const { InboxWorkItemRow } = await import('./InboxWorkItemRow');

describe('Inbox Work row stability', () => {
    it('presents an interrupted run without a hold as an Update through the shared Work mapping', async () => {
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'interrupted', state: 'interrupted' }), null);
        const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const item = groups.flatMap(group => group.items)[0];
        if (!item) throw new Error('interrupted_item_missing');
        const projected = buildInboxItems({ workGroups: groups, sessionPresentation: { sessionsNeedingAttention: [], readySessions: [],
            markAllReadTargets: [], pendingRequestHydrationTargets: [] }, workflowServerId: 'home', accountServerId: 'home', notices: [] });
        expect(projected[0]).toMatchObject({ type: 'update', view: 'updates' });
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={vi.fn()} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        const rendered = screen.tree.root.findAll(node => node.props.testID === 'inbox.run.interrupted' && node.props.status !== undefined)[0];
        expect(rendered?.props.status).toMatchObject(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'interrupted', word: rendered?.props.status.word, failureUnseen: false, invocationAttentionRequired: false,
            inAttentionWindow: false,
        } }));
    });
    it('marks a failed unseen Run with the calm rose dot from the work-status row mark, never a warning icon', async () => {
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'failed', state: 'failed', failureUnseen: true }), null);
        const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const item = groups.flatMap(group => group.items)[0];
        if (!item) throw new Error('failed_item_missing');
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={vi.fn()} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        const runRow = screen.findHostByTestId('inbox.run.failed')!;
        // React.memo: the rendered instance carries the inner component.
        const marks = runRow.findAll(node => node.type === WorkStatusRowMark.type);
        expect(marks.map(mark => resolveWorkStatusRowMark(mark.props.status))).toEqual(['danger']);
        expect(runRow.findAll(node => node.type === Icon.type && node.props.name === 'warning')).toHaveLength(0);
        await screen.unmount();
    });
    it('opens the canonical PR URL as the Landing primary action even in a list-detail Inbox', async () => {
        const restoreAuth = installSignedOutAuthForTest();
        // URL opening is a local Action; keep its real policy/executor and mock only native Linking.
        await import('@/sync/ops/actions/defaultActionExecutor');
        openUrl.mockClear();
        const session = createSessionFixture({ id: 'landing', serverId: 'home' });
        const navigate = vi.fn();
        const onSelectItem = vi.fn();
        const item = { kind: 'landing', key: 'landing:landing', session,
            link: { sessionId: session.id, serverId: 'home', number: 42, url: 'https://github.com/acme/widgets/pull/42', state: 'open', observedAt: 100 } } as const;
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={navigate} onSelectItem={onSelectItem} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain(en.files.sourceControlOperations.update.pullRequests.states.open);
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('files.sourceControl.pullRequests.states.open');
        try {
            await act(async () => { screen.findHostByTestId('inbox.landing.landing')!.props.onPress(); });
            await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(item.link.url));
            expect(navigate).not.toHaveBeenCalled();
            expect(onSelectItem).not.toHaveBeenCalled();
        } finally { await screen.unmount(); restoreAuth(); }
    });
    it('renders the held-step names from the Run summary through the real Inbox projection and row', async () => {
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'held', state: 'waiting_for_review', attentionRequired: true,
            heldStep: { invocationId: 'review', label: 'Review the changelog', laneLabel: 'Changelog' } }), null);
        const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const item = groups.flatMap(group => group.items)[0];
        if (!item) throw new Error('held_item_missing');
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={vi.fn()} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        const content = JSON.stringify(screen.tree.toJSON());
        expect(content).toContain('Review the changelog is waiting for you');
        expect(content).toContain('Changelog');
    });
    it('names the first of several holds and how many more wait (DESIGN-17 R4)', async () => {
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'held5', state: 'waiting_for_review', attentionRequired: true,
            heldCount: 5, heldStep: { invocationId: 'review', label: 'Review the changelog draft' } }), null);
        const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const item = groups.flatMap(group => group.items)[0];
        if (!item) throw new Error('held_item_missing');
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={vi.fn()} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Review the changelog draft and 4 more wait for you');
    });
    it('tells two approval-held Runs apart by the step each one waits on, from the Run summary alone', async () => {
        const approvalRun = (id: string, stepName: string, title: string) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id, state: 'paused', attentionRequired: true, invocationAttentionRequired: true,
            stepProgress: { completed: 0, total: 2, destinations: [
                { sourceKey: '$root', blockId: `${id}-block`, ordinal: 1, name: stepName, sessionIds: [],
                    observation: { recordId: `${id}-record`, sequence: '1', attempt: '0', contentRevision: '4',
                        lifecycle: 'waiting_for_approval', blockKind: 'action' } },
            ] } }), { kind: 'available', value: { title } });
        const rows = [approvalRun('digest', 'Send the weekly digest', 'Weekly digest'), approvalRun('notes', 'Publish the release notes', 'Release notes')];
        const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: rows, automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const items = groups.flatMap(group => group.items);
        expect(items).toHaveLength(2);
        const lines: string[] = [];
        for (const item of items) {
            const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
                presentation="screen" navigate={vi.fn()} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
            lines.push(JSON.stringify(screen.tree.toJSON()));
            await screen.unmount();
        }
        // The need leads, so a narrow row that truncates the line trims the step name, never the need.
        expect(lines[0]).toContain('Approve Send the weekly digest');
        expect(lines[1]).toContain('Approve Publish the release notes');
        expect(lines[0]).not.toContain('Publish the release notes');
        // The Run's own name titles the row when the summary's metadata carries it.
        expect(lines[0]).toContain('Weekly digest');
        expect(lines[1]).toContain('Release notes');
    });
    it('does not repaint an unchanged real row when another Inbox run updates', async () => {
        const run = (id: string, updatedAt: string) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id, state: 'interrupted', updatedAt }), null);
        const a = run('a', '2026-09-30T11:00:00.000Z');
        const b = run('b', '2026-09-30T11:00:00.000Z');
        const input = { sessionEntries: [], workflowRuns: [a, b], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null };
        const first = buildInboxWorkGroups(input);
        const actions = { navigate: vi.fn(), settle: vi.fn(async () => {}), setReminder: vi.fn(async () => {}) };
        const draw = (items: readonly InboxWorkItem[]) => <>{items.map((item) => <InboxWorkItemRow key={item.key} item={item}
            spansHomes={false} workflowServerId="home" identityDisplay="none" presentation="screen" {...actions} />)}</>;
        const screen = await renderScreen(draw(first.flatMap((group) => group.items)));
        expect(screen.findHostByTestId('inbox.run.a.summary')).not.toBeNull();
        expect(screen.findHostByTestId('inbox.run.b.summary')).not.toBeNull();
        const before = paints.get('inbox.run.a.summary');
        const changedBefore = paints.get('inbox.run.b.summary') ?? 0;
        expect(before).toBeGreaterThan(0);
        const next = buildInboxWorkGroups({ ...input, workflowRuns: [a, run('b', '2026-09-30T11:05:00.000Z')] }, first);
        await screen.update(draw(next.flatMap((group) => group.items)));
        expect(paints.get('inbox.run.a.summary')).toBe(before);
        expect(paints.get('inbox.run.b.summary')).toBeGreaterThan(changedBefore);
    });
});
