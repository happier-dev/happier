import type { StoredCredentials } from '@/persistence';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { buildMachineGuardEpisodeNotificationEvent } from '@/notifications/activity/buildMachineGuardEpisodeNotification';
import type { SessionGuardNoticeStateV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import type { GuardRuntimeInput } from './guardRuntime';
import type { IdleTerminalPolicyInput } from './idleTerminalPolicy';

type GuardNotificationInput = Readonly<{
  credentials: StoredCredentials;
  requesterAccountId: string | null;
  readTarget(): ReturnType<IdleTerminalPolicyInput['readTarget']> | null;
  signal: AbortSignal;
  secretSources?: TargetSecretSourcesV1;
  expoPushSender: Parameters<typeof dispatchActivityNotificationAsync>[0]['expoPushSender'];
  notifySessionWarning(sessionId: string, warning: Extract<SessionGuardNoticeStateV1, { kind: 'notify_terminal_warning' }>, signal: AbortSignal): Promise<boolean>;
}>;

/** Daemon guard notification admission and delivery for episodes and terminal warnings. */
export function createGuardNotifications(input: GuardNotificationInput): Readonly<{
  notifyEpisode: GuardRuntimeInput['notifyEpisode'];
  notifyWarning: IdleTerminalPolicyInput['notifyWarning'];
}> {
  const dispatch = async (event: Parameters<typeof dispatchActivityNotificationAsync>[0]['event'], signal?: AbortSignal) => {
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot || snapshot.scopeKey !== resolveAccountSettingsScopeKey(input.credentials))
      throw new Error('guard_notification_account_unavailable');
    await dispatchActivityNotificationAsync({ settings: snapshot.settings, secretSources: input.secretSources,
      signal: signal ? AbortSignal.any([input.signal, signal]) : input.signal,
      expoPushSender: input.expoPushSender, event });
  };
  return {
    notifyEpisode: async episode => {
      const target = input.readTarget();
      if (!target) throw new Error('guard_notification_account_unavailable');
      await dispatch(buildMachineGuardEpisodeNotificationEvent({ machineId: target.machineId, episode }));
    },
    notifyWarning: async ({ terminal, stopAt, idleMs, signal }) => {
      const custody = terminal.custody;
      const target = input.readTarget();
      if (!custody || !target || signal.aborted || custody.serverId !== target.serverId
        || custody.machineId !== target.machineId || custody.installationId !== target.installationId)
        throw new Error('guard_notification_terminal_unavailable');
      if (custody.kind === 'session') {
        if (!await input.notifySessionWarning(custody.sessionId, { kind: 'notify_terminal_warning',
          terminalId: terminal.terminalId, terminalKey: terminal.terminalKey, stopAt, idleMs }, signal))
          throw new Error('guard_notification_session_unavailable');
        return;
      }
      if (custody.requesterAccountId !== input.requesterAccountId)
        throw new Error('guard_notification_account_unavailable');
      await dispatch({ topic: 'guard_stop_warning', machineId: target.machineId,
        terminalId: terminal.terminalId, terminalKey: terminal.terminalKey, stopAt, idleMs, rule: 'idle_terminals' }, signal);
    },
  };
}
