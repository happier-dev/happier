import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listActionSpecs } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { storage, useSetting, useSettings } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
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
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { resolveSessionTargetServerId } from '@/components/sessions/model/resolveSessionTargetServerId';
import { getVoiceAgentSessionTeleportAvailability } from '@/voice/agent/getVoiceAgentSessionTeleportAvailability';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { useHasGlobalVoiceAgentConversation } from '@/voice/agent/useHasGlobalVoiceAgentConversation';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { machineDirectSessionFollowPolicySet } from '@/sync/ops/machineDirectSessions';
import { useSessionHandoffSourceReachability } from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import {
  readDirectSessionFollowPolicy,
  updateMetadataWithDirectSessionFollowPolicy,
} from '@/sync/domains/session/directSessions/directSessionFollowMetadata';
import { sync } from '@/sync/sync';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { resolveSessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import {
  createSessionReadStateDropdownItem,
  resolveSessionReadStateFromActionId,
} from '@/components/sessions/actions/sessionReadStateActionItems';
import { sessionSetManualReadStateWithServerScope } from '@/sync/ops';

function resolveSessionHandoffMenuSubtitle(handoffAvailability: ReturnType<typeof resolveSessionHandoffUiAvailability>, fallbackSubtitle: string | undefined): string | undefined {
  if (handoffAvailability.available) {
    return fallbackSubtitle;
  }

  switch (handoffAvailability.reason) {
    case 'handoff_feature_disabled':
      return t('common.disabled');
    case 'session_ineligible':
    case 'transport_unavailable':
    case 'runtime_direct_peer_unavailable':
      return t('common.unavailable');
  }
}

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
  const preferredSessionServerId = usePreferredServerIdForSession(props.sessionId, props.session.serverId ?? null);
  const sessionServerId = React.useMemo(
    () => resolveSessionTargetServerId(props.sessionId, preferredSessionServerId ?? props.session.serverId ?? null),
    [preferredSessionServerId, props.session.serverId, props.sessionId],
  );
  const reachableMachineId = useSessionReachableMachineTarget(props.sessionId)?.machineId ?? null;
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
    serverId: sessionServerId,
    reachableMachineId,
    session: props.session,
    sessionHandoffFeatureEnabled: sessionHandoffEnabled,
    serverSnapshot,
    runtimeAvailability,
  });
  const [open, setOpen] = React.useState(false);
  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: () => sessionServerId,
      openSession: (childSessionId: string) => {
        router.push((`/session/${childSessionId}`) as any);
      },
    }),
    [router, sessionServerId],
  );
  const teleportAvailability = React.useMemo(
    () => getVoiceAgentSessionTeleportAvailability({ voice, sessionId: props.sessionId }),
    [props.sessionId, voice],
  );
  const showTeleportAction = teleportAvailability.ok && hasGlobalVoiceAgentConversation;
  const directSessionLink = readDirectSessionLink(props.session.metadata);
  const directSessionFollowPolicy = readDirectSessionFollowPolicy(props.session.metadata);
  const directSessionAgentId = React.useMemo(
    () => resolveAgentIdFromFlavor(
      typeof (props.session.metadata as Record<string, unknown> | null | undefined)?.flavor === 'string'
        ? String((props.session.metadata as Record<string, unknown>).flavor)
        : directSessionLink?.providerId ?? null,
    ),
    [props.session.metadata, directSessionLink?.providerId],
  );
  const supportsDirectSessionBackgroundFollow =
    directSessionAgentId != null
      ? resolveAgentUiBehavior(directSessionAgentId).directSessions?.supportsBackgroundFollow === true
      : false;
  const actions = React.useMemo(() => {
    const actionItems: DropdownMenuItem[] = listActionSpecs()
      .filter((spec) => spec.surfaces.ui === true)
      .filter((spec) => isActionEnabledInState({ settings } as any, spec.id, { surface: 'ui', placement: 'session_action_menu' } as any))
      .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('session_action_menu' as any))
      .filter((spec) => spec.id !== 'session.fork' || canForkConversation({ session: props.session, replayEnabled: sessionReplayEnabled }) === true)
      .map((spec) => ({
        id: spec.id,
        title: spec.title,
        subtitle: spec.id === 'session.handoff'
          ? resolveSessionHandoffMenuSubtitle(handoffAvailability, spec.description)
          : spec.description,
        ...(spec.id === 'session.handoff' && handoffAvailability.available !== true
          ? { disabled: true }
          : {}),
      }));

    const out: DropdownMenuItem[] = [];

    if (directSessionLink && supportsDirectSessionBackgroundFollow) {
      out.push({
        id: 'session.directSession.backgroundFollow',
        title: t('session.actionMenu.backgroundFollow'),
        subtitle: directSessionFollowPolicy === 'background_follow' ? t('common.enabled') : t('common.disabled'),
      });
    }

    if (Array.isArray(props.extraItems) && props.extraItems.length > 0) {
      out.push(...props.extraItems);
    }

    if (props.session.archivedAt == null) {
      const readStateItem = createSessionReadStateDropdownItem(
        resolveSessionReadStateAction(props.session),
        theme.colors.header.tint,
      );
      if (readStateItem) {
        out.push(readStateItem);
      }
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
    sessionReplayEnabled,
    settings,
    showTeleportAction,
    handoffAvailability,
    directSessionLink,
    directSessionFollowPolicy,
    supportsDirectSessionBackgroundFollow,
    theme.colors.header.tint,
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
        if (actionId === 'session.directSession.backgroundFollow') {
          fireAndForget((async () => {
            if (!directSessionLink) return;
            const nextPolicy = directSessionFollowPolicy === 'background_follow' ? 'attached_only' : 'background_follow';
            const result = await machineDirectSessionFollowPolicySet({
              machineId: directSessionLink.machineId,
              sessionId: props.sessionId,
              providerId: directSessionLink.providerId,
              remoteSessionId: directSessionLink.remoteSessionId,
              source: directSessionLink.source,
              enabled: nextPolicy === 'background_follow',
            }, sessionServerId ? { serverId: sessionServerId } : undefined).catch(() => undefined);
            if (!result?.ok) {
              return;
            }
            sync.applySessionMetadataLocally(props.sessionId, (metadata) =>
              updateMetadataWithDirectSessionFollowPolicy(metadata, {
                policy: nextPolicy,
                updatedAtMs: result.updatedAtMs,
              }),
            );
          })(), { tag: 'SessionHeaderActionMenu.execute.directSessionBackgroundFollow' });
          return;
        }
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
        const manualReadState = resolveSessionReadStateFromActionId(actionId);
        if (manualReadState) {
          fireAndForget((async () => {
            const result = await sessionSetManualReadStateWithServerScope(
              props.sessionId,
              manualReadState,
              { serverId: sessionServerId ?? null },
            );
            if (!result.success) {
              Modal.alert(
                t('common.error'),
                result.message || t(
                  manualReadState === 'read'
                    ? 'sessionInfo.failedToMarkSessionRead'
                    : 'sessionInfo.failedToMarkSessionUnread',
                ),
              );
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionReadState' });
          return;
        }
        if (actionId === 'session.fork') {
          fireAndForget((async () => {
            const res = await executeSessionForkAction({
              execute: executor.execute as any,
              sessionId: props.sessionId,
              context: { defaultSessionId: props.sessionId, surface: 'ui', placement: 'session_action_menu' } as any,
            });
            if (!res.ok) {
              Modal.alert(t('common.error'), String(res.error ?? t('errors.failedToForkSession')));
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionFork' });
          return;
        }
        if (actionId === 'session.handoff') {
          if (!handoffAvailability.available) {
            return;
          }
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
