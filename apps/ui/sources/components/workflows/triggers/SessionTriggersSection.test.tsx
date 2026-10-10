import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { projectSessionTriggerGroups } from './sessionTriggerGroups';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Native Markdown SDK boundary; trigger summaries do not use streaming text.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { SessionTriggersSectionView } = await import('./SessionTriggersSection');
const { WorkflowTriggerSection } = await import('./WorkflowTriggerSection');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT } = await import('./workflowTriggerDraft');
const { WorkflowTriggerSetV1Schema, AutomationTriggerIdSchema } = await import('@happier-dev/protocol');

type Groups = React.ComponentProps<typeof SessionTriggersSectionView>['groups'];
afterEach(async () => { await standardCleanup(); vi.useRealTimers(); });

const GROUPS: Groups = [
    {
        id: 'lifecycle:turnEnds',
        glyph: 'arrows-clockwise',
        title: 'When a turn ends',
        rows: [
            { key: 'review:t1', automationId: 'review', triggerId: AutomationTriggerIdSchema.parse('t1'), revision: 1, sourceUnavailable: false, title: 'Review & converge', enabled: true, outcome: { text: 'Ran 20m ago', tone: 'neutral' } },
            { key: 'notify:t2', automationId: 'notify', triggerId: AutomationTriggerIdSchema.parse('t2'), revision: 1, sourceUnavailable: false, title: 'Notify me', enabled: true, outcome: null },
        ],
    },
    {
        id: 'schedule:daily',
        glyph: 'clock',
        title: 'Every day at 09:00',
        rows: [
            { key: 'ci:t3', automationId: 'ci', triggerId: AutomationTriggerIdSchema.parse('t3'), revision: 1, sourceUnavailable: false, title: 'Summarize overnight CI', enabled: false, outcome: { text: 'Failed', tone: 'danger' } },
        ],
    },
];

/** The sheet's drawn group separators: unlabelled lines (labelled row elements can report the same role under the test renderer). */
function separators(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => typeof node.type === 'string' && node.props.role === 'separator' && !('accessibilityLabel' in node.props));
}

describe('SessionTriggersSectionView', () => {
    it('refreshes mounted next-run and last-result labels with the same projected groups', async () => {
        vi.useFakeTimers();
        const now = new Date(2026, 9, 10, 10).getTime();
        vi.setSystemTime(now);
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'step', id: 'review',
                document: { text: 'Review code', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: now + 120_000,
                createdAt: now, updatedAt: now, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const groups = projectSessionTriggerGroups({ sets: [set], lastRunAtByAutomationId: { habit: now - 90_000 },
            resolveWorkflowTitle: () => null, formatAge: (at) => formatRelativeTimeShort(at, now) });
        const screen = await renderScreen(<SessionTriggersSectionView groups={groups} status="ready"
            pendingKeys={new Set()} onToggle={vi.fn()} onOpen={vi.fn()} onAdd={vi.fn()} onRetry={vi.fn()} />);
        expect(screen.getTextContent()).toContain('nextMinutes(count=2)');
        expect(screen.getTextContent()).toContain('minutesAgoShort(count=1)');
        await act(async () => { vi.advanceTimersByTime(30_001); });
        expect(screen.getTextContent()).toContain('nextMinutes(count=1)');
        expect(screen.getTextContent()).toContain('minutesAgoShort(count=2)');
        expect(vi.getTimerCount()).toBe(1);
    });
    it('keeps history behind the habit row rather than a second control line', async () => {
        const history = vi.fn();
        const onOpen = vi.fn();
        const screen = await renderScreen(<SessionTriggersSectionView groups={GROUPS} status="ready"
            pendingKeys={new Set()} onToggle={vi.fn()} onOpen={onOpen} onAdd={vi.fn()} onRetry={vi.fn()}
            onHistory={history} />);
        expect(screen.findByTestId('session-work-trigger:ci:t3-history')).toBeNull();
        expect(screen.findByTestId('session-work-trigger:ci:t3-runNow')).toBeNull();
        screen.pressByTestId('session-work-trigger:ci:t3');
        expect(onOpen).toHaveBeenCalledWith(GROUPS[1]!.rows[0], expect.anything());
    });
    it('keeps a paused habit last result and its directly usable row-end toggle', async () => {
        const toggle = vi.fn();
        const screen = await renderScreen(<SessionTriggersSectionView groups={GROUPS} status="ready"
            pendingKeys={new Set()} onToggle={toggle} onOpen={vi.fn()} onAdd={vi.fn()} onRetry={vi.fn()}
            onHistory={vi.fn()} />);
        expect(screen.getTextContent()).toContain('Failed');
        const actions = screen.findByTestId('session-work-trigger:ci:t3-actions');
        expect(actions).toBeNull();
        screen.findByTestId('session-work-trigger:ci:t3-switch')?.props.onValueChange(true);
        expect(toggle).toHaveBeenCalledWith(GROUPS[1]!.rows[0], true);
    });
    it('offers PR-link Retry while keeping ordinary trigger rows usable', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<SessionTriggersSectionView groups={GROUPS} status="ready" pullRequestLinksUnavailable
            pendingKeys={new Set()} onToggle={vi.fn()} onOpen={vi.fn()} onAdd={vi.fn()} onRetry={retry} />);
        expect(screen.findByTestId('session-work-trigger:review:t1-switch')?.props.disabled).not.toBe(true);
        expect(screen.findByTestId('session-work-triggers-failed')).toBeNull();
        expect(screen.findByTestId('session-work-trigger-links-unavailable')).not.toBeNull();
        screen.pressByTestId('session-work-trigger-links-unavailable-action');
        expect(retry).toHaveBeenCalledOnce();
    });
    it('does not claim Manual while the workflow trigger read failed, and offers Retry', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<WorkflowTriggerSection
            testIDPrefix="failed-editor" set={null} draft={EMPTY_WORKFLOW_TRIGGER_DRAFT} onChangeDraft={vi.fn()}
            status="failed" onRetry={retry}
            runsOn={null} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]}
        />);
        expect(screen.findByTestId('failed-editor-triggers-manual')).toBeNull();
        const action = screen.findAll((node) => node.props.testID === 'failed-editor-triggers-read-retry' && typeof node.props.onPress === 'function')[0];
        expect(action).toBeDefined();
        await action?.props.onPress();
        expect(retry).toHaveBeenCalled();
    });
    it('does not expose legacy editing in the workflow editor', async () => {
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'legacy', revision: 1, enabled: true,
            health: 'available', legacy: { editable: false, reason: 'created_in_0_2', placements: [{ machineId: 'm1', directory: '/repo' }] },
            target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [{ kind: 'step', id: 's1',
                document: { text: 'Review release', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            triggers: [] });
        const screen = await renderScreen(<WorkflowTriggerSection
            testIDPrefix="legacy-editor" set={set} draft={EMPTY_WORKFLOW_TRIGGER_DRAFT} onChangeDraft={vi.fn()}
            status="ready" onRetry={vi.fn()}
            runsOn="m1 · /repo" stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]}
        />);
        expect(screen.getTextContent()).toContain('Review release');
        expect(screen.getTextContent()).toContain('workflows.triggers.row.legacyCreated');
        expect(screen.findByTestId('legacy-editor-triggers-add')).toBeNull();
    });
    it('shows retained legacy details with a read-only switch', async () => {
        const screen = await renderScreen(<SessionTriggersSectionView
            groups={[{ ...GROUPS[0]!, rows: [{ ...GROUPS[0]!.rows[0]!, legacy: true, qualifier: 'm1 · /repo · Next: tomorrow' }] }]}
            status="ready" pendingKeys={new Set()} onToggle={vi.fn()} onOpen={vi.fn()} onAdd={vi.fn()} onRetry={vi.fn()}
        />);
        expect(screen.getTextContent()).toContain('m1 · /repo · Next: tomorrow');
        expect(screen.findByTestId('session-work-trigger:review:t1-switch')?.props.disabled).toBe(true);
    });
    it('draws the owner-approved section: "Triggers · {n} on · ⓘ", one sheet group per event, rows named by what they run', async () => {
        const onToggle = vi.fn();
        const onOpen = vi.fn();
        const screen = await renderScreen(
            <SessionTriggersSectionView
                groups={GROUPS}
                status="ready"
                pendingKeys={new Set(['notify:t2'])}
                onToggle={onToggle}
                onOpen={onOpen}
                onAdd={vi.fn()}
                onRetry={vi.fn()}
            />,
        );
        const text = screen.getTextContent();

        expect(text).toContain('workflows.triggers.section.title');
        // Only switched-on triggers count.
        expect(text).toContain('workflows.triggers.section.countOn(count=2)');
        expect(screen.findByTestId('session-work-triggers-info')?.props.accessibilityLabel).toBe('workflows.triggers.section.info');
        expect(screen.findByTestId('session-work-triggers-add')).not.toBeNull();

        // Each event heads its rows, in order; only the group boundary draws a line.
        expect(text.indexOf('When a turn ends')).toBeLessThan(text.indexOf('Review & converge'));
        expect(text.indexOf('Notify me')).toBeLessThan(text.indexOf('Every day at 09:00'));
        expect(text.indexOf('Every day at 09:00')).toBeLessThan(text.indexOf('Summarize overnight CI'));
        expect(separators(screen)).toHaveLength(1);
        // A group counts its rows only when there is more than one.
        const groupLabel = (id: string) => screen.findAll((node) => node.props.testID === `session-work-triggers-group:${id}` && 'title' in node.props)[0];
        expect(groupLabel('lifecycle:turnEnds')?.props.count).toBe(2);
        expect(groupLabel('schedule:daily')?.props.count).toBeUndefined();
        expect(groupLabel('schedule:daily')?.props.title).toBe('Every day at 09:00');

        // Off names the schedule state; it does not erase the actual last result.
        expect(text).toContain('workflows.triggers.row.off');
        expect(text).toContain('Failed');
        expect(text).toContain('Ran 20m ago');

        // The switch writes through the host, and waits while its write is in flight.
        screen.findByTestId('session-work-trigger:review:t1-switch')?.props.onValueChange(false);
        expect(onToggle).toHaveBeenCalledWith(GROUPS[0]!.rows[0], false);
        // Pressing a row opens its popover beside it.
        screen.pressByTestId('session-work-trigger:review:t1');
        expect(onOpen).toHaveBeenCalledWith(GROUPS[0]!.rows[0], expect.objectContaining({ current: null }));
        expect(screen.findByTestId('session-work-trigger:notify:t2-switch')?.props.disabled).toBe(true);
    });

    it('paints a failed outcome in the trouble tone', async () => {
        const screen = await renderScreen(
            <SessionTriggersSectionView
                groups={[{ ...GROUPS[1]!, rows: [{ ...GROUPS[1]!.rows[0]!, enabled: true }] }]}
                status="ready"
                pendingKeys={new Set()}
                onToggle={vi.fn()}
                onOpen={vi.fn()}
                onAdd={vi.fn()}
                onRetry={vi.fn()}
            />,
        );
        const outcome = screen.findHostByTestId('session-work-trigger:ci:t3-outcome');
        expect(outcome).not.toBeNull();
        expect(screen.getTextContent()).toContain('Failed');
    });
});
