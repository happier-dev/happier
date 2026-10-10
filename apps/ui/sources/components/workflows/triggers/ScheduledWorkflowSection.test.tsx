import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol';
import { ScheduledWorkflowSectionView } from './ScheduledWorkflowSection';
import { projectScheduledWorkflowRows } from './scheduledWorkflowRows';

// Native Markdown SDK boundary, not schedule projection or presentation logic.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => { await standardCleanup(); vi.useRealTimers(); });

describe('Scheduled Work rows', () => {
    it('refreshes the occurrence at its rounded display boundary without a data update', async () => {
        vi.useFakeTimers();
        const now = new Date(2026, 9, 10, 10).getTime();
        vi.setSystemTime(now);
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'step', id: 'review',
                document: { text: 'Review code', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: now + 120_000,
                createdAt: now, updatedAt: now, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const rows = projectScheduledWorkflowRows([set]);
        const screen = await renderScreen(<ScheduledWorkflowSectionView rows={rows} onOpen={() => {}} />);
        expect(screen.getTextContent()).toContain('nextMinutes(count=2)');
        await act(async () => { vi.advanceTimersByTime(30_001); });
        expect(screen.getTextContent()).toContain('nextMinutes(count=1)');
        expect(vi.getTimerCount()).toBe(1);
    });
    it('opens the scheduled workflow separately from its Session destination, retaining authored step context', async () => {
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [{ kind: 'step', id: 'review', name: 'Review',
                document: { text: 'Review code', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            destinations: { targetSessionIds: ['session-one'], usesOriginSession: false, unresolvedWorkflowRefs: [],
                leaves: [{ sourceKey: '$root', blockId: 'review', sessionIds: ['session-one'], ordinal: 1, name: 'Review' }] },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: 1234,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const rows = projectScheduledWorkflowRows([set]);
        const open = vi.fn();
        const screen = await renderScreen(<ScheduledWorkflowSectionView rows={rows} onOpen={open} />);
        expect(screen.getTextContent()).toContain('sessionWork.scheduled.step(ordinal=1,title=Review)');
        expect(screen.findByTestId('scheduled-workflow:habit:timer-destination:session-one')).not.toBeNull();
        expect(screen.findByTestId('scheduled-workflow:habit:timer-destination:session-one')?.props.accessibilityRole).toBe('link');
        expect(screen.findByTestId('scheduled-workflow:habit:timer-destination:session-one')?.props.accessibilityLabel)
            .toBe('message.sessionReferenceUnavailable');
        expect(screen.getTextContent()).not.toContain('session-one');
        screen.pressByTestId('scheduled-workflow:habit:timer');
        expect(open).toHaveBeenCalledWith(rows[0]);
        await screen.update(<ScheduledWorkflowSectionView rows={rows} onOpen={open} sessionId="session-one" />);
        screen.pressByTestId('scheduled-workflow:habit:timer');
        expect(open).toHaveBeenCalledTimes(2);
        expect(open).toHaveBeenLastCalledWith(rows[0]);
        // An inline prompt is already the row title; repeating it as a step hides the next occurrence.
        const sameTitle = { ...set, destinations: { ...set.destinations!, leaves: [{ ...set.destinations!.leaves[0]!, name: 'Review code' }] } };
        await screen.update(<ScheduledWorkflowSectionView rows={projectScheduledWorkflowRows([sameTitle])} onOpen={open} />);
        expect(screen.getTextContent()).not.toContain('sessionWork.scheduled.step');
    });
});
