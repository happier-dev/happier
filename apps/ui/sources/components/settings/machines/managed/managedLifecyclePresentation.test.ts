import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { describeManagedLifecycleState, resolveManagedNativeEndState } from './managedLifecyclePresentation';
import { formatRetentionDuration } from './managedRetentionPresentation';

describe('native Ends presentation', () => {
  const duration = { id: '3600', title: '1 hour', afterMs: 3_600_000, idleAfterMs: 600_000 };
  it.each([undefined, 600_000])('uses the durable configured limits with idle %s and no clock deadline', idleAfterMs => {
    const state = { kind: 'configuredLimits' as const, provider: 'Modal', lifetimeMs: duration.afterMs,
      ...(idleAfterMs === undefined ? {} : { idleMs: idleAfterMs }) };
    const presentation = describeManagedLifecycleState(state);
    expect(presentation).toBeDefined();
    expect(presentation).toMatchObject({ tone: 'neutral', actions: [],
      detail: t('managedRetention.configuredLimits', { provider: 'Modal', lifetime: formatRetentionDuration(duration.afterMs),
        idle: idleAfterMs === undefined ? undefined : formatRetentionDuration(idleAfterMs) }) });
    expect(resolveManagedNativeEndState({ provider: 'Modal', finiteOnly: true,
      duration: { ...duration, idleAfterMs } })).toEqual(state);
  });
  it('gives every state a list row shows as a status word its one short word (TH D3)', () => {
    for (const state of [{ kind: 'creationCanceledCleanup' }, { kind: 'cleanupUnknown' }, { kind: 'mayExist', name: 'Cua' },
      { kind: 'cleanupPending' }, { kind: 'creationWaiting', name: 'Boat' }] as const) {
      const presentation = describeManagedLifecycleState(state as Parameters<typeof describeManagedLifecycleState>[0]);
      expect(presentation.word).toEqual(expect.any(String));
      expect(presentation.word).not.toBe(presentation.line);
    }
  });
  it('says an unconfirmed cancellation cleanup once, as the page banner with its bill consequence (TH D-J)', () => {
    const cloud = describeManagedLifecycleState({ kind: 'creationCanceledCleanup' });
    expect(cloud.banner?.title).toBe(cloud.word);
    expect(cloud.line).toBe(`${t('managedMachines.creation.canceledCleanup')} ${t('managedMachines.creation.mayBill')}`);
    // A local machine runs on its controller and bills no one.
    expect(describeManagedLifecycleState({ kind: 'creationCanceledCleanup', cost: { kind: 'local' } }).line)
      .toBe(t('managedMachines.creation.canceledCleanup'));
  });
  it('prefers a real native expiry even when the creation record includes limits', () => {
    const state = resolveManagedNativeEndState({ provider: 'Modal', finiteOnly: true, duration, nativeExpiry: 1_790_008_200_000 });
    expect(state).toEqual({ kind: 'nativeExpiry', provider: 'Modal', at: 1_790_008_200_000 });
    expect(state && describeManagedLifecycleState(state).detail).toBe(t('managedRetention.nativeExpiry', {
      provider: 'Modal', time: formatAsOfTime(1_790_008_200_000) }));
  });
  it('does not reinterpret a duration on a non-finite resource as termination or invent a missing limit', () => {
    expect(resolveManagedNativeEndState({ provider: 'Fly', finiteOnly: false, duration })).toBeNull();
    expect(resolveManagedNativeEndState({ provider: 'Modal', finiteOnly: true })).toBeNull();
  });
});

describe('the one destructive action of a machine being created (TH MB-6)', () => {
  it('is Delete once a bound resource can be deleted, and Cancel creation before anything is bound', async () => {
    const { resolveManagedDestructiveAction } = await import('./managedLifecyclePresentation');
    expect(resolveManagedDestructiveAction({ allocation: 'bound', deleteSupported: true })).toBe('delete');
    expect(resolveManagedDestructiveAction({ allocation: 'bound', deleteSupported: false })).toBe('cancelCreation');
    expect(resolveManagedDestructiveAction({ allocation: 'may-exist', deleteSupported: true })).toBe('cancelCreation');
    expect(resolveManagedDestructiveAction({ allocation: 'unsubmitted', deleteSupported: true })).toBe('cancelCreation');
  });
});
