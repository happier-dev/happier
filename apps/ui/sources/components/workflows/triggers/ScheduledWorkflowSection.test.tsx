import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { ScheduledWorkflowGroup, ScheduledWorkflowSectionView } from './ScheduledWorkflowSection';
import { projectScheduledWorkflowRows } from './scheduledWorkflowRows';

// Native Markdown SDK boundary, not schedule projection or presentation logic.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => { setScreenSharingPrivacyActive(false); await standardCleanup(); vi.useRealTimers(); });

describe('Scheduled Work rows', () => {
    it('names a destination through its Account Home even when another Home has the same Session id', async () => {
        const previous = storage.getState();
        try {
            const session = createSessionFixture({ id: 'session-one', serverId: 'schedule-home', metadata: {
                name: 'Release review', host: 'review-box', path: '/release' } });
            storage.setState({ profileScope: { serverId: 'schedule-home', accountId: 'owner' }, sessions: {},
                sessionListRowsByServerId: {
                    'schedule-home': { [session.id]: buildSessionListRenderableFromSession(session) },
                    'other-home': { [session.id]: buildSessionListRenderableFromSession({ ...session, serverId: 'other-home',
                        metadata: { name: 'Other review', host: 'other', path: '/other' } }) },
                } });
            const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true, health: 'available',
                destinations: { targetSessionIds: [session.id], usesOriginSession: false, unresolvedWorkflowRefs: [], leaves: [] },
                triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: Date.now() + 120_000,
                    createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                    schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
            const screen = await renderScreen(<ScheduledWorkflowSectionView rows={projectScheduledWorkflowRows([set])} onOpen={() => {}} />);
            expect(screen.findByTestId('scheduled-workflow:habit:timer-destination:session-one')?.props.accessibilityLabel).toBe('Release review');
            expect(screen.getTextContent()).not.toContain('message.sessionReferenceUnavailable');
            await act(async () => {
                storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'schedule-home': ['private'] } });
                storage.getState().setSessionTagAssignmentsOptimistic('schedule-home', session.id, ['private']);
                setScreenSharingPrivacyActive(true);
            });
            expect(screen.findByTestId('scheduled-workflow:habit:timer-destination:session-one')?.props.accessibilityLabel)
                .toBe('message.sessionReferenceUnavailable');
            expect(screen.getTextContent()).not.toContain('Release review');
            await act(async () => setScreenSharingPrivacyActive(false));
            expect(screen.findByTestId('scheduled-workflow:habit:timer-destination:session-one')?.props.accessibilityLabel).toBe('Release review');

        } finally { await act(async () => { storage.setState(previous); }); }
    });
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
        await act(async () => { vi.advanceTimersByTime(90_000); });
        // The trailing column says one word; the spoken label keeps the whole sentence.
        expect(screen.findByTestId('scheduled-workflow:habit:timer-next')?.props.children).toBe('workflows.triggers.row.nextPending');
        expect(screen.findByTestId('scheduled-workflow:habit:timer')?.props.accessibilityLabel).toContain('automations.list.nextRunPending');
        expect(screen.findByTestId('scheduled-workflow:habit:timer')?.props.accessibilityLabel).not.toContain('workflows.triggers.row.nextRun(');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('keeps the occurrence next run separate from step context in both Account and Writes-here rows', async () => {
        // Lab lane12-final `b-habit T`: the quiet line says which step writes here; when is the row's meta.
        const now = new Date(2026, 9, 10, 10).getTime();
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [{ kind: 'step', id: 'notes', name: 'Weekly release notes',
                document: { text: 'Draft', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            destinations: { targetSessionIds: ['session-one'], usesOriginSession: false, unresolvedWorkflowRefs: [],
                leaves: [{ sourceKey: '$root', blockId: 'notes', sessionIds: ['session-one'], ordinal: 2, name: 'Draft the notes' }] },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: now + 3 * 3_600_000,
                createdAt: now, updatedAt: now, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 86_400_000, scheduleExpr: null, timezone: null } }] });
        const rows = projectScheduledWorkflowRows([set]);
        const screen = await renderScreen(<ScheduledWorkflowSectionView rows={rows} onOpen={() => {}} />);
        expect(screen.findByTestId('scheduled-workflow:habit:timer-next')?.props.children).toContain('nextHours(count=3)');
        expect(screen.getTextContent().split('nextHours').length - 1).toBe(1);
        await screen.update(<ScheduledWorkflowSectionView rows={rows} onOpen={() => {}} sessionId="session-one" />);
        // In a Session's Writes here the next run is the title line's meta, not the trailing column.
        expect(screen.findByTestId('scheduled-workflow:habit:timer-next')).toBeNull();
        expect(screen.getTextContent().split('nextHours(count=3)').length - 1).toBe(1);
        const subtitle = screen.findByTestId('scheduled-workflow:habit:timer-subtitle');
        expect(JSON.stringify(subtitle?.props.children)).toContain('sessionWork.scheduled.step(ordinal=2,title=Draft the notes)');
        expect(JSON.stringify(subtitle?.props.children)).not.toContain('nextHours');
    });
    it('keeps the Account Scheduled group out of the session list until it has rows, and says a failed read once', async () => {
        // The group may not exist: drawing a loading strip that later turns into a group (or vanishes)
        // moves every session row under it. Last-known rows stay put while a read refreshes.
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'step', id: 'review',
                document: { text: 'Review code', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: 1234,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const rows = projectScheduledWorkflowRows([set]);
        const retry = vi.fn();
        const read = (status: 'loading' | 'ready' | 'failed', withRows: boolean) => ({ available: true,
            rows: withRows ? rows : [], status, retry, serverId: null });
        const screen = await renderScreen(<ScheduledWorkflowGroup read={read('loading', false)} />);
        expect(screen.findByTestId('workflows-column:group:scheduled')).toBeNull();
        expect(screen.findByTestId('scheduled-workflow-read')).toBeNull();
        await screen.update(<ScheduledWorkflowGroup read={read('loading', true)} />);
        expect(screen.findByTestId('scheduled-workflow:habit:timer')).not.toBeNull();
        expect(screen.findByTestId('scheduled-workflow-read')).toBeNull();
        await screen.update(<ScheduledWorkflowGroup read={read('failed', false)} />);
        expect(screen.findByTestId('workflows-column:group:scheduled')).not.toBeNull();
        expect(screen.findByTestId('scheduled-workflow-read')).not.toBeNull();
    });
    it('caps the Account Scheduled group so it never crowds sessions out of the list, and reveals the rest on demand', async () => {
        const set = (id: string, nextRunAt: number) => WorkflowTriggerSetV1Schema.parse({ automationId: id, revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'step', id: 'review',
                document: { text: 'Review code', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const rows = projectScheduledWorkflowRows(Array.from({ length: 6 }, (_, index) => set(`habit-${index}`, 1000 + index)));
        const read = { available: true, rows, status: 'ready' as const, retry: vi.fn(), serverId: null };
        const screen = await renderScreen(<ScheduledWorkflowGroup read={read} />);
        // The header still counts every schedule; only the rows are capped.
        expect(screen.findByTestId('workflows-column:group:scheduled-count')?.props.children).toBe(6);
        const shown = () => rows.filter((row) => screen.findByTestId(`scheduled-workflow:${row.key}`) !== null).length;
        expect(shown()).toBe(3);
        expect(screen.getTextContent()).toContain('sessionWork.showMore(count=3)');
        await act(async () => { screen.pressByTestId('workflows-column:group:scheduled-more'); });
        expect(shown()).toBe(6);
        expect(screen.findByTestId('workflows-column:group:scheduled-more')).toBeNull();
    });
    it('opens the scheduled workflow separately from its Session destination, retaining authored step context', async () => {
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'habit', revision: 1, enabled: true, health: 'available',
            target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [{ kind: 'step', id: 'review', name: 'Release review',
                document: { text: 'Review code', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
            destinations: { targetSessionIds: ['session-one'], usesOriginSession: false, unresolvedWorkflowRefs: [],
                leaves: [{ sourceKey: '$root', blockId: 'review', sessionIds: ['session-one'], ordinal: 1, name: 'Review' }] },
            triggers: [{ id: 'timer', revision: 1, enabled: true, kind: 'schedule', nextRunAt: 1234,
                createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }] });
        const rows = projectScheduledWorkflowRows([set]);
        const open = vi.fn();
        const screen = await renderScreen(<ScheduledWorkflowSectionView rows={rows} onOpen={open} />);
        expect(screen.getTextContent()).toContain('Release review');
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
        // An authored name is already the row title; repeating it as a step hides the next occurrence.
        const sameTitle = { ...set, destinations: { ...set.destinations!, leaves: [{ ...set.destinations!.leaves[0]!, name: 'Release review' }] } };
        await screen.update(<ScheduledWorkflowSectionView rows={projectScheduledWorkflowRows([sameTitle])} onOpen={open} />);
        expect(screen.getTextContent()).not.toContain('sessionWork.scheduled.step');
    });
});
