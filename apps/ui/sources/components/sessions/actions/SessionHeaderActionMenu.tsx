import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listActionSpecs } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { storage, useSetting, useSettings } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import type { Session } from '@/sync/domains/state/storageTypes';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { executeSessionForkAction } from '@/sync/domains/sessionFork/executeSessionForkAction';
import { runSessionHandoffPickerFlow } from '@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow';
import { resolveSessionHandoffSourceMachineId } from '@/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId';
import {
  resolveSessionHandoffUiAvailability,
} from '@/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { getVoiceAgentSessionTeleportAvailability } from '@/voice/agent/getVoiceAgentSessionTeleportAvailability';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { useHasGlobalVoiceAgentConversation } from '@/voice/agent/useHasGlobalVoiceAgentConversation';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useSessionHandoffSourceReachability } from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';

export function SessionHeaderActionMenu(props: Readonly<{
  sessionId: string;
  session: Session;
  /**
   * Optional extra items to include in the action menu (typically from adjacent header icon actions
   * that are folded into the three-dots menu on narrow layouts).
   *
   * Extra item IDs must not collide with protocol action spec IDs.
   */
  extraItems?: ReadonlyArray<DropdownMenuItem>;
  /**
   * Optional handler for selecting extra items. Return `true` when the selection was handled.
   * This is primarily used to bridge extra items that need access to parent-owned state (e.g.
   * opening a pane tab) without adding new cross-cutting dependencies here.
   */
  onSelectExtraItem?: (actionId: string) => boolean;
}>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const enabledAgentIds = useEnabledAgentIds();
  const settings = useSettings();
  const sessionReplayEnabled = useSetting('sessionReplayEnabled');
  const voice = useSetting('voice');
  const hasGlobalVoiceAgentConversation = useHasGlobalVoiceAgentConversation();
  const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
  const sessionServerId = usePreferredServerIdForSession(props.sessionId);
  const reachableMachineId = React.useMemo(
    () => readMachineTargetForSession(props.sessionId)?.machineId ?? null,
    [props.sessionId, props.session.updatedAt, props.session.metadata],
  );
  const sourceMachineId = React.useMemo(
    () => resolveSessionHandoffSourceMachineId({
      reachableMachineId,
      sessionMetadata: props.session.metadata as any,
    }),
    [props.session.metadata, reachableMachineId],
  );
  const serverSnapshot = useServerFeaturesSnapshotForServerId(sessionServerId, { enabled: Boolean(sessionServerId) });
  const runtimeAvailability = useSessionHandoffSourceReachability({
    serverId: sessionServerId,
    sourceMachineId,
  });
  const handoffAvailability = resolveSessionHandoffUiAvailability({
    sessionId: props.sessionId,
    session: props.session,
    sessionHandoffFeatureEnabled: sessionHandoffEnabled,
    serverSnapshot,
    runtimeAvailability,
  });
  const [open, setOpen] = React.useState(false);
  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
      openSession: (childSessionId: string) => {
        router.push((`/session/${childSessionId}`) as any);
      },
    }),
    [router],
  );
  const teleportAvailability = React.useMemo(
    () => getVoiceAgentSessionTeleportAvailability({ voice, sessionId: props.sessionId }),
    [props.sessionId, voice],
  );
  const showTeleportAction = teleportAvailability.ok && hasGlobalVoiceAgentConversation;
  const actions = React.useMemo(() => {
    const actionItems: DropdownMenuItem[] = listActionSpecs()
      .filter((spec) => spec.surfaces.ui_button === true)
      .filter((spec) => isActionEnabledInState({ settings } as any, spec.id, { surface: 'ui_button', placement: 'session_action_menu' } as any))
      .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('session_action_menu' as any))
      .filter((spec) => spec.id !== 'session.fork' || canForkConversation({ session: props.session, replayEnabled: sessionReplayEnabled }) === true)
      .filter((spec) => spec.id !== 'session.handoff' || handoffAvailability.available)
      .map((spec) => ({
        id: spec.id,
        title: spec.title,
        subtitle: spec.description,
      }));

    const out: DropdownMenuItem[] = [];

    if (Array.isArray(props.extraItems) && props.extraItems.length > 0) {
      out.push(...props.extraItems);
    }

    if (showTeleportAction) {
      out.push({
        id: 'voice.teleport',
        title: t('voiceSurface.a11y.teleport'),
        subtitle: undefined,
      });
    }

    out.push(...actionItems);
    return out;
  }, [
    props.extraItems,
    props.session,
    sessionHandoffEnabled,
    sessionReplayEnabled,
    settings,
    showTeleportAction,
    handoffAvailability.available,
  ]);

  if (actions.length === 0) return null;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={actions}
      onSelect={(actionId) => {
        setOpen(false);
        if (props.onSelectExtraItem?.(actionId) === true) return;
        if (actionId === 'header.openRuns') {
          router.push((`/session/${props.sessionId}/runs`) as any);
          return;
        }
        if (actionId === 'header.openAutomations') {
          navigateWithBlurOnWeb(() => router.push((`/session/${props.sessionId}/automations`) as any));
          return;
        }
        if (actionId === 'voice.teleport') {
          fireAndForget(teleportVoiceAgentToSessionRoot({ sessionId: props.sessionId }), {
            tag: 'SessionHeaderActionMenu.execute.voiceTeleport',
          });
          return;
        }
        if (actionId === 'session.fork') {
          fireAndForget((async () => {
            const res = await executeSessionForkAction({
              execute: executor.execute as any,
              sessionId: props.sessionId,
              context: { defaultSessionId: props.sessionId, surface: 'ui_button', placement: 'session_action_menu' } as any,
            });
            if (!res.ok) {
              Modal.alert(t('common.error'), String(res.error ?? t('errors.failedToForkSession')));
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionFork' });
          return;
        }
        if (actionId === 'session.handoff') {
          // Defer opening the modal on web so the dropdown press/unmount cycle completes before we
          // mount another portal-backed surface (avoids flakey immediate dismissals in e2e).
          deferOnWeb(() => {
            fireAndForget((async () => {
              const serverId = sessionServerId;
              const res = await runSessionHandoffPickerFlow({
                execute: executor.execute as any,
                sessionId: props.sessionId,
                sourceMachineId: sourceMachineId ?? null,
                serverId,
                placement: 'session_action_menu',
              });
              if (!res?.ok) return;
            })(), { tag: 'SessionHeaderActionMenu.execute.sessionHandoff' });
          });
          return;
        }
        const defaultBackend = resolveSessionActionDefaultBackend({
          session: props.session,
          enabledAgentIds,
        });
        if (!defaultBackend) return;
        const input = buildExecutionRunActionDraftInputForUi({
          actionId: actionId as any,
          sessionId: props.sessionId,
          defaultBackendTarget: defaultBackend.backendTarget,
          defaultBackendId: defaultBackend.defaultBackendId,
          instructions: '',
        });
        storage.getState().createSessionActionDraft(props.sessionId, { actionId, input });
      }}
      trigger={({ toggle }) => (
            <Pressable
              onPress={toggle}
              hitSlop={15}
              testID="session-header-action-menu-trigger"
              accessibilityRole="button"
              accessibilityLabel={t('session.actionMenu.openA11y')}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.header.tint} />
          </View>
        </Pressable>
      )}
      placement="bottom"
      variant="slim"
      rowKind="selectableRow"
      search={false}
      matchTriggerWidth={false}
      maxWidthCap={320}
    />
  );
}
