import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { ManagedCost } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ProviderNativeOptionFactsV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedAsleepWake } from '@/sync/domains/pending/managedWakeProjection';
import { formatRetentionDuration } from './managedRetentionPresentation';

/**
 * Every state a created machine can be in that needs words (plans 50/52, lab `m-life`): its cause in
 * the common vocabulary, interpolated from descriptor and observation facts, and its one real next
 * step. Never "deleted", "stopped" or "free" on a guess: accepted is not observed, unknown is not absent.
 * The caller supplies the observed state; this module only names it.
 */
export type ManagedLifecycleState =
  | Readonly<{ kind: 'creationWaiting'; name: string }>
  /** A submitted create the provider has not bound yet, while its acquire runs. */
  | Readonly<{ kind: 'creating'; name: string }>
  /** Provider calls run where the account lives; nothing is created until that machine is back. */
  | Readonly<{
      kind: 'controllerWaiting';
      name: string;
      controller: string;
      provider: string;
    }>
  | Readonly<{ kind: 'creationDisabled' }>
  | Readonly<{ kind: 'resourceReady' }>
  | Readonly<{ kind: 'observationUnavailable' }>
  | Readonly<{ kind: 'creationCanceledCleanup' }>
  /** Canceled before any resource was made: nothing exists, so nothing "no longer exists". */
  | Readonly<{ kind: 'creationCanceled' }>
  /** Creation settled without a bound native resource. */
  | Readonly<{ kind: 'notCreated' }>
  | Readonly<{ kind: 'stopPending' }>
  | Readonly<{ kind: 'powerPending'; provider: string; state: string }>
  /** Asleep with its storage kept; `wake` says what starts it again, from the wake owner. */
  | Readonly<{ kind: 'stoppedStorage'; wake?: ManagedAsleepWake }>
  | Readonly<{ kind: 'storageUnknown' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'volumeLost' }>
  | Readonly<{ kind: 'nativeExpiry'; provider: string; at: number }>
  | Readonly<{ kind: 'configuredLimits'; provider: string; lifetimeMs: number; idleMs?: number }>
  | Readonly<{ kind: 'unsupported'; provider: string; effect: string }>
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'activityUnknown' }>
  | Readonly<{ kind: 'draining' }>
  | Readonly<{ kind: 'cleanupPending'; reason?: string; cost?: ManagedCost }>
  | Readonly<{ kind: 'cleanupUnknown' }>
  | Readonly<{ kind: 'providerRemoved'; provider: string }>
  | Readonly<{
      kind: 'providerUnreachable';
      provider: string;
      checkedAt: number;
    }>
  | Readonly<{ kind: 'credentialRefused' }>
  | Readonly<{ kind: 'localMissing'; controller: string }>
  | Readonly<{ kind: 'controllerRequired'; controller: string }>
  | Readonly<{ kind: 'stoppedCharges'; charges: string }>
  | Readonly<{ kind: 'resumeUnsupported' }>
  | Readonly<{ kind: 'mayExist'; name: string }>;

export type ManagedLifecycleAction =
  /** Opens the Ask already waiting in Inbox for this resource (its cleanup Delete). */
  | 'review'
  | 'start'
  | 'checkNow'
  | 'tryAgain'
  | 'openProvider'
  | 'reinstall'
  | 'remove'
  | 'reconnect'
  | 'createAnother'
  | 'deleteNow'
  | 'cancel'
  | 'change';

export type ManagedLifecyclePresentation = Readonly<{
  /** `pending` draws the activity mark: something was requested and is not yet observed. */
  tone: 'neutral' | 'pending' | 'warning' | 'danger';
  /** What went wrong, in one sentence: the only part a warning or failure tints. */
  cause?: string;
  /** The state or the next step, said plainly after the cause. */
  detail?: string;
  /** The cause and detail as one sentence pair, for one-line consumers. */
  line: string;
  /** A word for a narrow one-line rail, where the line would truncate; absent where the line is already short. */
  word?: string;
  actions: readonly ManagedLifecycleAction[];
  /**
   * A state that blocks use or leaves billing uncertain speaks as the page's banner, titled with the
   * state; every other state is a fact on the resource's own row.
   */
  banner?: Readonly<{ title: string }>;
}>;

/** The retained creation receipt owns configured limits; a native expiry supersedes them. */
export function resolveManagedNativeEndState(input: Readonly<{
  provider: string;
  nativeExpiry?: number;
  finiteOnly?: boolean;
  duration?: ProviderNativeOptionFactsV1['duration'];
}>): Extract<ManagedLifecycleState, { kind: 'nativeExpiry' | 'configuredLimits' }> | null {
  if (input.nativeExpiry !== undefined) return { kind: 'nativeExpiry', provider: input.provider, at: input.nativeExpiry };
  if (!input.finiteOnly || !input.duration) return null;
  return { kind: 'configuredLimits', provider: input.provider, lifetimeMs: input.duration.afterMs,
    ...(input.duration.idleAfterMs === undefined ? {} : { idleMs: input.duration.idleAfterMs }) };
}

function present(
  tone: ManagedLifecyclePresentation['tone'],
  text: Readonly<{ cause?: string; detail?: string }>,
  actions: readonly ManagedLifecycleAction[],
  banner?: ManagedLifecyclePresentation['banner'],
): ManagedLifecyclePresentation {
  return {
    tone,
    ...(text.cause ? { cause: text.cause } : {}),
    ...(text.detail ? { detail: text.detail } : {}),
    line: [text.cause, text.detail].filter(Boolean).join(' '),
    actions,
    ...(banner ? { banner } : {}),
  };
}

export function describeManagedLifecycleState(
  state: ManagedLifecycleState,
): ManagedLifecyclePresentation {
  switch (state.kind) {
    case 'creationDisabled':
      return present(
        'neutral',
        { detail: t('managedMachines.creation.disabledDetail') },
        ['change'],
        { title: t('managedMachines.creation.disabledTitle') },
      );
    case 'creationWaiting':
      return present(
        'neutral',
        { detail: t('managedMachines.inspect.notCreated') },
        [],
      );
    case 'creating':
      // A row's status cell says the state in one word, the page its sentence (TH D3).
      return { ...present(
        'pending',
        { detail: t('managedMachines.creation.creating', { name: state.name }) },
        [],
      ), word: t('managedMachines.creation.creatingShort') };
    case 'controllerWaiting':
      return present(
        'neutral',
        {
          detail: t('managedMachines.controller.waitingDetail', {
            provider: state.provider,
            controller: state.controller,
            name: state.name,
          }),
        },
        ['cancel'],
        {
          title: t('managedMachines.controller.waiting', {
            controller: state.controller,
          }),
        },
      );
    case 'resourceReady':
      return present(
        'neutral',
        { detail: t('managedMachines.creation.resourceReady') },
        ['checkNow'],
      );
    case 'observationUnavailable':
      return present(
        'warning',
        {
          cause: t('managedMachines.creation.observationUnavailableCause'),
          detail: t('managedMachines.creation.observationUnavailableDetail'),
        },
        ['checkNow'],
      );
    case 'creationCanceledCleanup':
      return { ...present(
        'warning',
        { cause: t('managedMachines.creation.canceledCleanup') },
        ['review', 'deleteNow', 'checkNow', 'openProvider', 'remove'],
      ), word: t('managedMachines.creation.cleanupPendingShort') };
    case 'stopPending':
      return present('pending', { detail: t('managedPower.stopPending') }, [
        'checkNow',
      ]);
    case 'powerPending':
      return present(
        'pending',
        {
          detail: t('managedMachines.power.pending', {
            provider: state.provider,
            state: state.state,
          }),
        },
        ['checkNow'],
      );
    case 'stoppedStorage':
      return { ...present(
        'neutral',
        { detail: describeAsleepLine(state.wake) },
        ['start'],
      ), word: t('managedPower.asleep') };
    case 'storageUnknown':
      return present('warning', { cause: t('managedPower.storageUnknown') }, [
        'checkNow',
      ]);
    case 'creationCanceled':
      return { ...present('neutral', { detail: t('managedMachines.creation.canceledBeforeCreate') }, [
        'remove',
      ]), word: t('managedMachines.creation.canceledShort') };
    case 'notCreated':
      return { ...present('neutral', { detail: t('managedMachines.inspect.notCreated') }, ['remove']),
        word: t('managedMachines.inspect.notCreated') };
    // An ended resource can't come back; creating another is its own step through the configurator.
    case 'absent':
      return { ...present('neutral', { detail: t('managedPower.resourceAbsent') }, [
        'remove', 'createAnother',
      ]), word: t('managedPower.ended') };
    case 'expired':
      return { ...present('neutral', { detail: t('managedPower.expired') }, [
        'remove', 'createAnother',
      ]), word: t('managedPower.ended') };
    case 'volumeLost':
      return present('warning', { cause: t('managedPower.volumeLost') }, [
        'remove',
      ]);
    case 'configuredLimits':
      return present('neutral', {
        detail: t('managedRetention.configuredLimits', {
          provider: state.provider,
          lifetime: formatRetentionDuration(state.lifetimeMs),
          idle: state.idleMs === undefined ? undefined : formatRetentionDuration(state.idleMs),
        }),
      }, []);
    case 'nativeExpiry':
      return present(
        'neutral',
        {
          detail: t('managedRetention.nativeExpiry', {
            provider: state.provider,
            time: formatAsOfTime(state.at),
          }),
        },
        [],
      );
    case 'unsupported':
      return present(
        'neutral',
        {
          detail: t('managedPower.unsupported', {
            provider: state.provider,
            effect: state.effect,
          }),
        },
        [],
      );
    case 'busy':
      return present('neutral', { detail: t('managedRetention.busy') }, []);
    case 'activityUnknown':
      return present(
        'warning',
        { cause: t('managedRetention.activityUnknown') },
        ['checkNow'],
      );
    case 'draining':
      return present('pending', { detail: t('managedRetention.draining') }, []);
    case 'cleanupPending':
      return { ...present(
        'danger',
        {
          // The banner's title names the state; its body says what it means for the bill.
          detail: [state.cost?.kind === 'local' ? undefined : t('managedCleanup.pendingDetail'), state.reason]
            .filter(Boolean)
            .join(' '),
        },
        ['review', 'tryAgain', 'openProvider'],
        { title: t('managedCleanup.pendingTitle') },
      ), word: t('managedMachines.creation.cleanupPendingShort') };
    case 'cleanupUnknown':
      return { ...present(
        'warning',
        {
          cause: t('managedMachines.cleanup.unknownCause'),
          detail: t('managedMachines.cleanup.unknownDetail'),
        },
        ['checkNow', 'remove', 'openProvider'],
      ), word: t('managedMachines.creation.cleanupUnknownShort') };
    case 'providerRemoved':
      return present(
        'warning',
        {
          cause: t('managedMachines.provider.removed', {
            provider: state.provider,
          }),
        },
        ['reinstall'],
      );
    case 'providerUnreachable':
      return present(
        'warning',
        {
          cause: t('managedMachines.provider.unreachableCause', {
            provider: state.provider,
          }),
          detail: t('managedMachines.provider.lastChecked', {
            time: formatAsOfTime(state.checkedAt),
          }),
        },
        ['checkNow'],
      );
    case 'credentialRefused':
      return present(
        'warning',
        { cause: t('managedMachines.credential.refused') },
        ['reconnect'],
      );
    case 'localMissing':
      return present(
        'warning',
        {
          cause: t('managedMachines.local.missingCause', {
            controller: state.controller,
          }),
          detail: t('managedMachines.local.missingDetail'),
        },
        ['checkNow'],
      );
    case 'controllerRequired':
      return present(
        'neutral',
        {
          detail: t('managedMachines.controller.required', {
            controller: state.controller,
          }),
        },
        [],
      );
    case 'stoppedCharges':
      return present(
        'neutral',
        {
          detail: t('managedMachines.billing.stopped', {
            charges: state.charges,
          }),
        },
        [],
      );
    case 'resumeUnsupported':
      return present(
        'neutral',
        { detail: t('managedMachines.resume.unsupported') },
        ['createAnother'],
      );
    case 'mayExist':
      return { ...present(
        'warning',
        {
          cause: t('managedMachines.creation.unknownCause', {
            name: state.name,
          }),
          detail: t('managedMachines.creation.unknownDetail'),
        },
        ['checkNow', 'openProvider'],
      ), word: t('managedMachines.creation.mayExistShort') };
  }
}

export function managedLifecycleActionLabel(
  action: ManagedLifecycleAction,
  provider?: string,
): string {
  switch (action) {
    case 'review':
      return t('managedMachines.actions.review');
    case 'start':
      return t('managedMachines.actions.start');
    case 'checkNow':
      return t('managedMachines.inspect.checkNow');
    case 'tryAgain':
      return t('managedMachines.actions.tryAgain');
    case 'openProvider':
      return provider
        ? t('managedMachines.actions.openProvider', { provider })
        : t('managedMachines.actions.openConsole');
    case 'reinstall':
      return t('managedMachines.actions.reinstall');
    case 'remove':
      return t('managedMachines.actions.remove');
    case 'reconnect':
      return t('managedMachines.actions.reconnect');
    case 'createAnother':
      return t('managedMachines.actions.createAnother');
    case 'deleteNow':
      return t('managedMachines.actions.delete');
    case 'cancel':
      return t('common.cancel');
    case 'change':
      return t('managedMachines.actions.change');
  }
}

/** One word for the state everywhere ("Asleep", as the header and rail say it), then what starts it again. */
function describeAsleepLine(wake: ManagedAsleepWake | undefined): string {
  switch (wake?.kind) {
    case 'onSend': return t('managedPower.asleepWakesOnSend');
    case 'waitsForController': return wake.controller === null ? t('managedPower.asleepWaitsForControllerUnnamed')
      : t('managedPower.asleepWaitsForController', { controller: wake.controller });
    case 'off': return t('managedPower.asleepNoWake');
    case undefined: return t('managedPower.asleep');
  }
}
