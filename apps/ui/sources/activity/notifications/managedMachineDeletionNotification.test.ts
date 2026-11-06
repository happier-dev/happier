import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderObservationV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { readManagedMachineDeletionAttention } from '../attention/managedMachineDeletionAttention';
import { updateManagedMachineDeletionNotification } from './managedMachineDeletionNotification';

const native = vi.hoisted(() => ({
    scheduleNotificationAsync: vi.fn(async () => 'managed-deletion-1'),
    cancelScheduledNotificationAsync: vi.fn(async () => undefined),
}));

// Expo's OS transport is the boundary; notice selection and both consumer reads remain real.
vi.mock('expo-notifications', () => ({ ...native, SchedulableTriggerInputTypes: { DATE: 'date' } }));

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe('managed Machine provider deletion reminder consumers', () => {
    const observation = ProviderObservationV1Schema.parse({
        observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained',
        deletionNotices: [{ kind: 'stopped-storage', at: 10_000,
            rule: { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1_000 }, consequence: 'disk-deleted' }],
    });
    const input = { observation, leadTimeMs: 2_000, nowMs: 7_999, identifier: 'managed-deletion-1',
        content: { title: 'Disk deletion', body: 'Start this Machine to keep its disk.', data: { managedId: 'managed-1' } } };

    it('uses the same nearest deadline for the Stop schedule and app-open attention, without app timers', async () => {
        vi.useFakeTimers();
        expect(readManagedMachineDeletionAttention(input)).toBeNull();
        expect(await updateManagedMachineDeletionNotification(input)).toBe(input.identifier);
        expect(native.scheduleNotificationAsync).toHaveBeenCalledWith({
            identifier: input.identifier, content: { ...input.content, sound: 'default' },
            trigger: { type: 'date', date: new Date(8_000) },
        });
        expect(readManagedMachineDeletionAttention({ ...input, nowMs: 8_000 }))
            .toMatchObject({ notice: observation.deletionNotices?.[0], remindAt: 8_000, due: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a withdrawn native notice and reschedules the same OS identifier after a preference edit', async () => {
        await updateManagedMachineDeletionNotification(input);
        await updateManagedMachineDeletionNotification({ ...input, leadTimeMs: 1_000 });
        expect(native.scheduleNotificationAsync).toHaveBeenLastCalledWith({
            identifier: input.identifier, content: { ...input.content, sound: 'default' },
            trigger: { type: 'date', date: new Date(9_000) },
        });
        native.scheduleNotificationAsync.mockClear();
        const withdrawn = { ...input, observation: { ...observation, deletionNotices: [] } };
        expect(await updateManagedMachineDeletionNotification(withdrawn)).toBeNull();
        expect(native.cancelScheduledNotificationAsync).toHaveBeenLastCalledWith(input.identifier);
        expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
        expect(readManagedMachineDeletionAttention({ ...withdrawn, nowMs: 9_000 })).toBeNull();
    });

    it('keeps a rule-only date unscheduled and presents an already-due reminder immediately', async () => {
        const due = { ...input, nowMs: 8_000 };
        await updateManagedMachineDeletionNotification(due);
        expect(native.scheduleNotificationAsync).toHaveBeenLastCalledWith({
            identifier: input.identifier, content: { ...input.content, sound: 'default' }, trigger: null,
        });
        native.scheduleNotificationAsync.mockClear();
        const unknownDate = ProviderObservationV1Schema.parse({ ...observation,
            deletionNotices: observation.deletionNotices?.map(({ at, ...notice }) => notice) });
        await updateManagedMachineDeletionNotification({ ...input, observation: unknownDate });
        expect(native.scheduleNotificationAsync).not.toHaveBeenCalled();
    });
});
