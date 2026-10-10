import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildInboxWorkGroups, type InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';

const paints = new Map<string, number>();
installSessionSubagentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ View: ({ children, ...props }: React.PropsWithChildren<{ testID?: string }>) => {
            if (props.testID?.endsWith('.summary')) paints.set(props.testID, (paints.get(props.testID) ?? 0) + 1);
            return React.createElement('View', props, children);
        } });
    },
});
const { InboxWorkItemRow } = await import('./InboxWorkItemRow');

describe('Inbox Work row stability', () => {
    it('does not repaint an unchanged real row when another Inbox run updates', async () => {
        const run = (id: string, updatedAt: string) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id, state: 'interrupted', updatedAt }), null);
        const a = run('a', '2026-09-30T11:00:00.000Z');
        const b = run('b', '2026-09-30T11:00:00.000Z');
        const input = { sessionEntries: [], workflowRuns: [a, b], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null };
        const first = buildInboxWorkGroups(input);
        const actions = { navigate: vi.fn(), settle: vi.fn(async () => {}), setReminder: vi.fn(async () => {}) };
        const draw = (items: readonly InboxWorkItem[]) => <>{items.map((item) => <InboxWorkItemRow key={item.key} item={item}
            spansHomes={false} workflowServerId="home" identityDisplay="none" presentation="screen" {...actions} />)}</>;
        const screen = await renderScreen(draw(first.flatMap((group) => group.items)));
        const before = paints.get('inbox.run.a.summary');
        const changedBefore = paints.get('inbox.run.b.summary') ?? 0;
        expect(before).toBeGreaterThan(0);
        const next = buildInboxWorkGroups({ ...input, workflowRuns: [a, run('b', '2026-09-30T11:05:00.000Z')] }, first);
        await act(async () => screen.tree.update(draw(next.flatMap((group) => group.items))));
        expect(paints.get('inbox.run.a.summary')).toBe(before);
        expect(paints.get('inbox.run.b.summary')).toBeGreaterThan(changedBefore);
    });
});
