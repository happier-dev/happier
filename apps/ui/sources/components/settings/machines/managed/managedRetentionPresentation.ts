import type {
  MachineRetentionCategoryV1,
  MachineRetentionPolicyV1,
} from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import type { RetentionV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * Words and choices for the one Keep it / wake control (plans 51/52). Policy resolution stays in the
 * Protocol resolver; this module only names a policy and lists the choices a person can pick.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The idle durations the When unused field offers, around D21's one-hour default. */
const UNUSED_DURATIONS_MS: readonly number[] = [
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  4 * HOUR_MS,
  8 * HOUR_MS,
  DAY_MS,
];

export type RetentionEffect = 'stop' | 'delete';

export function formatRetentionDuration(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0)
    return t('managedRetention.days', { count: ms / DAY_MS });
  if (ms >= HOUR_MS && ms % HOUR_MS === 0)
    return t('managedRetention.hours', { count: ms / HOUR_MS });
  return t('managedRetention.minutes', {
    count: Math.max(1, Math.round(ms / MINUTE_MS)),
  });
}

export function describeRetention(
  retention: RetentionV1,
  formatTime: (at: number) => string = formatAsOfTime,
): string {
  switch (retention.kind) {
    case 'until-delete':
      return t('managedRetention.untilDelete');
    case 'unused': {
      const duration = formatRetentionDuration(retention.afterMs);
      return retention.effect === 'stop'
        ? t('managedRetention.stopAfterUnused', { duration })
        : t('managedRetention.deleteAfterUnused', { duration });
    }
    case 'deadline': {
      const time = formatTime(retention.at);
      return retention.effect === 'stop'
        ? t('managedRetention.stopAt', { time })
        : t('managedRetention.deleteAt', { time });
    }
  }
}


/** A Stop rule is the only one a wake can follow: Delete leaves nothing to start, Until I delete it never stops. */
export function retentionStops(retention: RetentionV1): boolean {
  return retention.kind !== 'until-delete' && retention.effect === 'stop';
}

/** The one-line summary a closed row shows: "Stop after 1 h unused · wakes". */
export function describeRetentionPolicy(
  policy: MachineRetentionPolicyV1,
): string {
  const label = describeRetention(policy.retention);
  return retentionStops(policy.retention) && policy.wakeOnAcceptedMessage
    ? `${label} · ${t('managedRetention.wakes')}`
    : label;
}

/** "Stop after 1 h unused · wake on", for the Default: line under an override. */
export function describeDefaultPolicy(
  policy: MachineRetentionPolicyV1,
): string {
  const label = describeRetention(policy.retention);
  if (!retentionStops(policy.retention)) return label;
  return `${label} · ${policy.wakeOnAcceptedMessage ? t('managedRetention.wakeOn') : t('managedRetention.wakeOff')}`;
}

export type RetentionChoice = Readonly<{
  id: string;
  retention: RetentionV1;
  title: string;
}>;

export function retentionChoiceId(retention: RetentionV1): string {
  switch (retention.kind) {
    case 'until-delete':
      return 'until-delete';
    case 'unused':
      return `unused:${retention.effect}:${retention.afterMs}`;
    case 'deadline':
      return `deadline:${retention.effect}:${retention.at}`;
  }
}

/**
 * The When unused field's choices: Until I delete it, then each supported effect at each offered
 * duration. A current value outside the list (a preset's 90 minutes, a reviewed deadline) stays
 * selectable so opening the field never changes it.
 */
export function buildRetentionChoices(
  input: Readonly<{
    current: RetentionV1;
    effects?: readonly RetentionEffect[];
    finiteOnly?: boolean;
  }>,
): readonly RetentionChoice[] {
  const effects = input.finiteOnly ? ['delete'] as const : input.effects ?? ['stop', 'delete'];
  const retentions: RetentionV1[] = input.finiteOnly ? [] : [{ kind: 'until-delete' }];
  for (const effect of effects) {
    for (const afterMs of UNUSED_DURATIONS_MS)
      retentions.push({ kind: 'unused', afterMs, effect });
  }
  const currentId = retentionChoiceId(input.current);
  if (
    !retentions.some((retention) => retentionChoiceId(retention) === currentId)
    && (!input.finiteOnly || input.current.kind !== 'until-delete' && input.current.effect === 'delete')
  )
    retentions.push(input.current);
  return retentions.map((retention) => ({
    id: retentionChoiceId(retention),
    retention,
    title: describeRetention(retention),
  }));
}

/** Finite resources end; the fact is never presented as a retained Stop or same-resource wake. */
export function describeFiniteRetention(retention: RetentionV1): string {
  if (retention.kind === 'unused') return t('managedRetention.endsAfterUnused', { duration: formatRetentionDuration(retention.afterMs) });
  if (retention.kind === 'deadline') return t('managedRetention.endsAt', { time: formatAsOfTime(retention.at) });
  return t('managedMachines.options.unavailable');
}

/**
 * The three choices the configurator and receipt offer as radios: Until I delete it, Stop and Delete
 * after the current idle duration (D21's hour unless the policy chose another).
 */
export function buildRetentionKindChoices(
  input: Readonly<{
    current: RetentionV1;
    effects?: readonly RetentionEffect[];
  }>,
): readonly RetentionChoice[] {
  const effects = input.effects ?? ['stop', 'delete'];
  const afterMs =
    input.current.kind === 'unused'
      ? input.current.afterMs
      : DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1;
  const retentions: RetentionV1[] = [
    { kind: 'until-delete' },
    ...effects.map((effect): RetentionV1 => ({
      kind: 'unused',
      afterMs,
      effect,
    })),
  ];
  if (input.current.kind === 'deadline') retentions.push(input.current);
  return retentions.map((retention) => ({
    id: retentionChoiceId(retention),
    retention,
    title: describeRetention(retention),
  }));
}

/** The translation-key segment for a billing category (`local`, `runningOnly`, …). */
export function retentionCategoryKey(
  category: MachineRetentionCategoryV1,
): 'local' | 'runningOnly' | 'stoppedBilled' | 'unknown' {
  switch (category) {
    case 'local':
      return 'local';
    case 'running-only':
      return 'runningOnly';
    case 'stopped-billed':
      return 'stoppedBilled';
    case 'unknown':
      return 'unknown';
  }
}

export function retentionCategoryTitle(
  category: MachineRetentionCategoryV1,
): string {
  switch (category) {
    case 'local':
      return t('settingsMachines.localVirtualMachines');
    case 'running-only':
      return t('settingsMachines.runningOnly');
    case 'stopped-billed':
      return t('settingsMachines.stoppedBilled');
    case 'unknown':
      return t('settingsMachines.billingUnknown');
  }
}

export function retentionCategoryHelp(
  category: MachineRetentionCategoryV1,
): string {
  return t(`managedRetention.categoryHelp.${retentionCategoryKey(category)}`);
}
