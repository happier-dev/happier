import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * Every state a created machine can be in that needs words (plans 50/52, lab `m-life`): its cause in
 * the common vocabulary, interpolated from descriptor and observation facts, and its one real next
 * step. Never "deleted", "stopped" or "free" on a guess: accepted is not observed, unknown is not absent.
 * The caller supplies the observed state; this module only names it.
 */
export type ManagedLifecycleState =
  | Readonly<{ kind: 'creationWaiting'; name: string }>
  | Readonly<{ kind: 'creationDisabled' }>
  | Readonly<{ kind: 'resourceReady' }>
  | Readonly<{ kind: 'observationUnavailable' }>
  | Readonly<{ kind: 'creationCanceledCleanup' }>
  | Readonly<{ kind: 'stopPending' }>
  | Readonly<{ kind: 'powerPending'; provider: string; state: string }>
  | Readonly<{ kind: 'stoppedStorage' }>
  | Readonly<{ kind: 'storageUnknown' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'volumeLost' }>
  | Readonly<{ kind: 'nativeExpiry'; provider: string; at: number }>
  | Readonly<{ kind: 'unsupported'; provider: string; effect: string }>
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'activityUnknown' }>
  | Readonly<{ kind: 'draining' }>
  | Readonly<{ kind: 'cleanupPending'; reason?: string }>
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
  | 'checkNow'
  | 'tryAgain'
  | 'openProvider'
  | 'reinstall'
  | 'remove'
  | 'reconnect'
  | 'createAnother'
  | 'deleteNow';

export type ManagedLifecyclePresentation = Readonly<{
  /** `pending` draws the activity mark: something was requested and is not yet observed. */
  tone: 'neutral' | 'pending' | 'warning' | 'danger';
  line: string;
  actions: readonly ManagedLifecycleAction[];
}>;

export function describeManagedLifecycleState(
  state: ManagedLifecycleState,
): ManagedLifecyclePresentation {
  switch (state.kind) {
    case 'creationDisabled':
      return { tone: 'warning', line: t('managedMachines.creation.disabledDetail'), actions: [] };
    case 'creationWaiting':
      return { tone: 'neutral', line: t('managedMachines.creation.waiting', { name: state.name }), actions: [] };
    case 'resourceReady':
      return { tone: 'neutral', line: t('managedMachines.creation.resourceReady'), actions: ['checkNow'] };
    case 'observationUnavailable':
      return { tone: 'warning', line: t('managedMachines.creation.observationUnavailable'), actions: ['checkNow'] };
    case 'creationCanceledCleanup':
      return { tone: 'warning', line: t('managedMachines.creation.canceledCleanup'), actions: ['checkNow'] };
    case 'stopPending':
      return {
        tone: 'pending',
        line: t('managedPower.stopPending'),
        actions: ['checkNow'],
      };
    case 'powerPending':
      return {
        tone: 'pending',
        line: t('managedMachines.power.pending', {
          provider: state.provider,
          state: state.state,
        }),
        actions: ['checkNow'],
      };
    case 'stoppedStorage':
      return {
        tone: 'neutral',
        line: t('managedPower.stoppedStorage'),
        actions: [],
      };
    case 'storageUnknown':
      return {
        tone: 'warning',
        line: t('managedPower.storageUnknown'),
        actions: ['checkNow'],
      };
    case 'absent':
      return {
        tone: 'neutral',
        line: t('managedPower.resourceAbsent'),
        actions: ['remove'],
      };
    case 'expired':
      return {
        tone: 'neutral',
        line: t('managedPower.expired'),
        actions: ['remove'],
      };
    case 'volumeLost':
      return {
        tone: 'warning',
        line: t('managedPower.volumeLost'),
        actions: ['remove'],
      };
    case 'nativeExpiry':
      return {
        tone: 'neutral',
        line: t('managedRetention.nativeExpiry', {
          provider: state.provider,
          time: formatAsOfTime(state.at),
        }),
        actions: [],
      };
    case 'unsupported':
      return {
        tone: 'neutral',
        line: t('managedPower.unsupported', {
          provider: state.provider,
          effect: state.effect,
        }),
        actions: [],
      };
    case 'busy':
      return { tone: 'neutral', line: t('managedRetention.busy'), actions: [] };
    case 'activityUnknown':
      return {
        tone: 'warning',
        line: t('managedRetention.activityUnknown'),
        actions: ['checkNow'],
      };
    case 'draining':
      return {
        tone: 'pending',
        line: t('managedRetention.draining'),
        actions: [],
      };
    case 'cleanupPending':
      return {
        tone: 'danger',
        line: state.reason
          ? `${t('managedCleanup.pending')} ${state.reason}`
          : t('managedCleanup.pending'),
        actions: ['openProvider', 'tryAgain'],
      };
    case 'cleanupUnknown':
      return {
        tone: 'warning',
        line: t('managedMachines.cleanup.unknown'),
        actions: ['checkNow'],
      };
    case 'providerRemoved':
      return {
        tone: 'warning',
        line: t('managedMachines.provider.removed', {
          provider: state.provider,
        }),
        actions: ['reinstall'],
      };
    case 'providerUnreachable':
      return {
        tone: 'warning',
        line: t('managedMachines.provider.unreachable', {
          provider: state.provider,
          time: formatAsOfTime(state.checkedAt),
        }),
        actions: ['checkNow'],
      };
    case 'credentialRefused':
      return {
        tone: 'warning',
        line: t('managedMachines.credential.refused'),
        actions: ['reconnect'],
      };
    case 'localMissing':
      return {
        tone: 'warning',
        line: t('managedMachines.local.missing', {
          controller: state.controller,
        }),
        actions: ['checkNow'],
      };
    case 'controllerRequired':
      return {
        tone: 'neutral',
        line: t('managedMachines.controller.required', {
          controller: state.controller,
        }),
        actions: [],
      };
    case 'stoppedCharges':
      return {
        tone: 'neutral',
        line: t('managedMachines.billing.stopped', { charges: state.charges }),
        actions: [],
      };
    case 'resumeUnsupported':
      return {
        tone: 'neutral',
        line: t('managedMachines.resume.unsupported'),
        actions: ['createAnother'],
      };
    case 'mayExist':
      return {
        tone: 'warning',
        line: t('managedMachines.creation.unknown', { name: state.name }),
        actions: ['checkNow'],
      };
  }
}

export function managedLifecycleActionLabel(
  action: ManagedLifecycleAction,
  provider?: string,
): string {
  switch (action) {
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
  }
}
