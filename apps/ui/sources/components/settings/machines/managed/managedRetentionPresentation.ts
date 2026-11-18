import type {
  MachineRetentionCategoryV1,
  MachineRetentionPolicyV1,
} from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1, isMachineRetainedWakeEligibleV1, resolveMachineRetentionNativeIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import type { RetentionV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { describeRetention as describeSharedRetention, formatRetentionDuration as formatSharedRetentionDuration,
  type ManagedDurationLabels } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { type ProviderPrice } from './managedMachineDisplay';
import { formatPriceUnit, formatProviderAmount } from '@/components/ui/presentation/providerCostPresentation';

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

/**
 * How a provider parks a machine for the Stop effect: its native Stop, or its native Suspend when that is
 * the only way it parks (the Protocol resolver decides). The words follow what will really happen.
 */
export type RetentionParking = 'stop' | 'suspend';

export function retentionParking(supportedIntents: Parameters<typeof resolveMachineRetentionNativeIntentV1>[1]): RetentionParking {
  return resolveMachineRetentionNativeIntentV1('stop', supportedIntents) === 'suspend' ? 'suspend' : 'stop';
}

function durationLabels(): ManagedDurationLabels {
  return { days: count => t('managedRetention.days', { count }), hours: count => t('managedRetention.hours', { count }),
    minutes: count => t('managedRetention.minutes', { count }) };
}

export function formatRetentionDuration(ms: number): string {
  return formatSharedRetentionDuration(ms, durationLabels());
}

export function describeRetention(
  retention: RetentionV1,
  formatTime: (at: number) => string = formatAsOfTime,
  parking: RetentionParking = 'stop',
): string {
  return describeSharedRetention(retention, { formatTime, parking, durationLabels: durationLabels(), labels: {
    untilDelete: t('managedRetention.untilDelete'),
    deleteAfterUnused: duration => t('managedRetention.deleteAfterUnused', { duration }),
    stopAfterUnused: duration => t('managedRetention.stopAfterUnused', { duration }),
    suspendAfterUnused: duration => t('managedRetention.suspendAfterUnused', { duration }),
    deleteAt: time => t('managedRetention.deleteAt', { time }), stopAt: time => t('managedRetention.stopAt', { time }),
    suspendAt: time => t('managedRetention.suspendAt', { time }),
  } });
}
/** stoppedBilling describes compute. Retained storage can still bill independently of that fact. */
export type RetentionConsequenceFacts = Readonly<{
  location: 'local' | 'cloud' | 'unknown';
  stoppedBilling: 'billed' | 'not-billed' | 'unknown';
  /** The provider's display name ("Hetzner"). */
  provider: string;
  /** How it parks for Stop; a suspend keeps the machine's state. */
  parking?: RetentionParking;
  /** The resource kind ("Sandbox"), for "Cua pauses this sandbox". */
  kind?: string;
  /** What the provider bills for storage it keeps while stopped; said as a short rate, never its label. */
  storageCharges?: readonly ProviderPrice[];
}>;

/**
 * The stopped storage rate as a short value ("$0.08 per GB-month"): the provider's labels are prose for its own
 * pricing page, not a receipt. Several charges in one unit read as "from" the lowest; otherwise the first.
 */
function describeStoppedStorageRate(charges: readonly ProviderPrice[] | undefined): string | null {
  const first = charges?.[0];
  if (!first) return null;
  const say = (price: ProviderPrice) => `${formatProviderAmount(price)} ${formatPriceUnit(price.unit)}`;
  if (!charges.every(price => price.unit === first.unit && price.currency === first.currency)) return say(first);
  const lowest = charges.reduce((low, price) => Number(price.amount) < Number(low.amount) ? price : low, first);
  return charges.some(price => Number(price.amount) !== Number(lowest.amount))
    ? t('managedRetention.storageFrom', { rate: say(lowest) }) : say(lowest);
}

/**
 * What the chosen Keep rule means for the machine and its bill, said once under the choices. The
 * choice's own label is already on screen, so this never repeats it (copy: one message per state).
 */
export function describeRetentionConsequence(
  retention: RetentionV1,
  facts: RetentionConsequenceFacts,
  formatTime: (at: number) => string = formatAsOfTime,
): string {
  const billed = facts.location !== 'local';
  if (retention.kind === 'until-delete')
    return billed && facts.stoppedBilling !== 'unknown'
      ? t('managedRetention.consequence.untilDeleteBilled')
      : t('managedRetention.consequence.untilDelete');
  if (retention.effect === 'delete') {
    if (retention.kind === 'unused') {
      const when = { duration: formatRetentionDuration(retention.afterMs) };
      return billed
        ? t('managedRetention.consequence.deleteBilled', when)
        : t('managedRetention.consequence.delete', when);
    }
    const when = { time: formatTime(retention.at) };
    return billed
      ? t('managedRetention.consequence.deleteAtBilled', when)
      : t('managedRetention.consequence.deleteAt', when);
  }
  if (facts.parking === 'suspend')
    return t('managedRetention.consequence.suspend', { provider: facts.provider, kind: facts.kind ?? t('common.machine') });
  if (facts.location === 'local')
    return t('managedRetention.categoryHelp.local');
  switch (facts.stoppedBilling) {
    case 'billed':
      return t('managedRetention.consequence.stopBilled', {
        provider: facts.provider,
      });
    case 'not-billed': {
      // The one statement of the stopped cost: with its storage rate when the provider declares one.
      const rate = describeStoppedStorageRate(facts.storageCharges);
      return rate
        ? t('managedRetention.consequence.stopNotBilledStorage', { provider: facts.provider, rate })
        : t('managedRetention.consequence.stopNotBilled', { provider: facts.provider });
    }
    case 'unknown':
      return t('managedRetention.consequence.stopUnknown', {
        provider: facts.provider,
      });
  }
}

/**
 * What a creation's end choice (Keep, Stop or Delete when its Session is archived or its task finishes) means for
 * the bill, beside the choice (T3 R3). Keep and Stop are the same consequences the retention rule says; Delete
 * happens at that end, so it says "then" rather than a duration. Amounts appear only when the provider declares them.
 */
export function describeArchiveChoiceConsequence(choice: 'keep' | 'stop' | 'delete', facts: RetentionConsequenceFacts): string {
  if (choice === 'delete')
    return facts.location === 'local' ? t('managedRetention.consequence.deleteOnEnd') : t('managedRetention.consequence.deleteOnEndBilled');
  return describeRetentionConsequence(choice === 'keep' ? { kind: 'until-delete' }
    : { kind: 'unused', afterMs: DEFAULT_MACHINE_UNUSED_RETENTION_MS_V1, effect: 'stop' }, facts);
}

/**
 * Whether Keep it offers "Start it for new messages and runs" beside this rule (58d §D4): only beside a rule
 * that stops the machine. Always on never stops, and a deleted machine has nothing to start; the stored
 * wake choice is kept either way, so changing the rule back shows it as it was.
 */
export function keepOffersWake(retention: RetentionV1): boolean {
  return retention.kind !== 'until-delete' && isMachineRetainedWakeEligibleV1(retention);
}

/**
 * What Always on and a start cost, in the provider's own rates (lab af-config K): its published monthly
 * rate when it has one, else its running rate. An hourly rate is never multiplied into a month.
 */
export function describeKeepCosts(prices: readonly ProviderPrice[] | undefined): Readonly<{ alwaysOn?: string; starting?: string }> {
  const running = prices?.[0];
  if (!running) return {};
  const rate = `${formatProviderAmount(running)} ${formatPriceUnit(running.unit)}`;
  // The same line item's monthly rate (a storage charge's month is not the machine's).
  const monthly = prices.find(price => price.unit === 'month' && JSON.stringify(price.label) === JSON.stringify(running.label));
  return {
    alwaysOn: monthly && monthly !== running ? t('managedRetention.aboutMonthly', { amount: formatProviderAmount(monthly) }) : rate,
    starting: t('managedRetention.startingBills', { price: rate }),
  };
}

/** The one-line summary a closed row shows: "Stop after 1 h unused · wakes". */
export function describeRetentionPolicy(
  policy: MachineRetentionPolicyV1,
): string {
  const label = describeRetention(policy.retention);
  return keepOffersWake(policy.retention) && policy.wakeOnAcceptedMessage
    ? joinHappierFacts(label, t('managedRetention.wakes'))
    : label;
}

/** "Stop after 1 h unused · wake on", for the Default: line under an override. */
export function describeDefaultPolicy(
  policy: MachineRetentionPolicyV1,
): string {
  const label = describeRetention(policy.retention);
  if (!keepOffersWake(policy.retention)) return label;
  return joinHappierFacts(label, policy.wakeOnAcceptedMessage ? t('managedRetention.wakeOn') : t('managedRetention.wakeOff'));
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
    parking?: RetentionParking;
  }>,
): readonly RetentionChoice[] {
  const effects = input.finiteOnly
    ? (['delete'] as const)
    : (input.effects ?? ['stop', 'delete']);
  const retentions: RetentionV1[] = input.finiteOnly
    ? []
    : [{ kind: 'until-delete' }];
  for (const effect of effects) {
    for (const afterMs of UNUSED_DURATIONS_MS)
      retentions.push({ kind: 'unused', afterMs, effect });
  }
  const currentId = retentionChoiceId(input.current);
  if (
    !retentions.some(
      (retention) => retentionChoiceId(retention) === currentId,
    ) &&
    (!input.finiteOnly ||
      (input.current.kind !== 'until-delete' &&
        input.current.effect === 'delete'))
  )
    retentions.push(input.current);
  return retentions.map((retention) => ({
    id: retentionChoiceId(retention),
    retention,
    title: describeRetention(retention, undefined, input.parking),
  }));
}

/** Finite resources end; the fact is never presented as a retained Stop or same-resource wake. */
export function describeFiniteRetention(retention: RetentionV1): string {
  if (retention.kind === 'unused')
    return t('managedRetention.endsAfterUnused', {
      duration: formatRetentionDuration(retention.afterMs),
    });
  if (retention.kind === 'deadline')
    return t('managedRetention.endsAt', { time: formatAsOfTime(retention.at) });
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
    parking?: RetentionParking;
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
    title: describeRetention(retention, undefined, input.parking),
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
