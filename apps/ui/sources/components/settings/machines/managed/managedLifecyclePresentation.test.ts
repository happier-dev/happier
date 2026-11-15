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
      { kind: 'cleanupPending' }] as const) {
      const presentation = describeManagedLifecycleState(state as Parameters<typeof describeManagedLifecycleState>[0]);
      expect(presentation.word).toEqual(expect.any(String));
      expect(presentation.word).not.toBe(presentation.line);
    }
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
