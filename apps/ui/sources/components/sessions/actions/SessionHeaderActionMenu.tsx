import * as React from 'react';
import { Pressable, View } from 'react-native';
import { listActionSpecs } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { storage, useSetting, useSettings } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
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
import { useSessionHandoffSourceReachability } from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { completeSessionForkNavigation } from '@/components/sessions/transcript/forkContext/completeSessionForkNavigation';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import { listVisibleSessionActionIds } from '@/components/sessions/actions/sessionActionAvailability';
import { createSessionActionDropdownItem } from '@/components/sessions/actions/sessionActionPresentation';
import {
  resolveManualReadStateFromSessionActionId,
  SESSION_ACTION_ARCHIVE_ID,
  SESSION_ACTION_MARK_READ_ID,
  SESSION_ACTION_MARK_UNREAD_ID,
  SESSION_ACTION_RENAME_ID,
  SESSION_ACTION_RESUME_ID,
  SESSION_ACTION_STOP_ID,
  SESSION_ACTION_UNARCHIVE_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { buildSessionMetadataStabilitySignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';

type SessionHeaderActionMenuProps = Readonly<{
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
}>;

function readCurrentSessionForOpenMenu(sessionId: string, fallback: Session): Session {
  return storage.getState().sessions[sessionId] ?? fallback;
}

function signatureValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return '';
}

function readLegacyReadStateMetadata(metadata: unknown): Readonly<{
  sessionSeq: unknown;
  pendingActivityAt: unknown;
}> {
  if (!metadata || typeof metadata !== 'object') {
    return { sessionSeq: null, pendingActivityAt: null };
  }
  const readStateV1 = (metadata as { readStateV1?: unknown }).readStateV1;
  if (!readStateV1 || typeof readStateV1 !== 'object') {
    return { sessionSeq: null, pendingActivityAt: null };
  }
  return {
    sessionSeq: (readStateV1 as { sessionSeq?: unknown }).sessionSeq,
    pendingActivityAt: (readStateV1 as { pendingActivityAt?: unknown }).pendingActivityAt,
  };
}

function buildSessionHeaderReadStateSignature(
  state: Pick<StorageState, 'sessions' | 'sessionListRenderables' | 'sessionMessages'>,
  sessionId: string,
): string {
  const session = state.sessions[sessionId];
  const renderable = state.sessionListRenderables[sessionId];
  const messages = state.sessionMessages[sessionId] as Readonly<{
    messageIdsOldestFirst?: ReadonlyArray<unknown>;
    messagesVersion?: unknown;
    reducerVersion?: unknown;
    latestReadyEventSeq?: unknown;
    latestReadyEventAt?: unknown;
  }> | undefined;
  const readStateV1 = readLegacyReadStateMetadata(session?.metadata);

  return [
    signatureValue(session?.seq),
    signatureValue(session?.lastViewedSessionSeq),
    signatureValue(session?.latestReadyEventSeq),
    signatureValue((session as { latestMessageSeq?: unknown } | undefined)?.latestMessageSeq),
    signatureValue(session?.latestTurnStatus),
    signatureValue(session?.accessLevel),
    signatureValue(readStateV1.sessionSeq),
    signatureValue(readStateV1.pendingActivityAt),
    signatureValue(renderable?.hasUnreadMessages),
    signatureValue(renderable?.seq),
    signatureValue(renderable?.lastViewedSessionSeq),
    signatureValue(messages?.messagesVersion),
    signatureValue(messages?.reducerVersion),
    signatureValue(messages?.latestReadyEventSeq),
    signatureValue(messages?.latestReadyEventAt),
    signatureValue(messages?.messageIdsOldestFirst?.length),
  ].join('|');
}

function areSessionActionMenuMetadataSemanticallyEqual(
  prev: Session['metadata'],
  next: Session['metadata'],
): boolean {
  if (prev === next) return true;
  return buildSessionMetadataStabilitySignature(prev) === buildSessionMetadataStabilitySignature(next);
}

function didSessionHeaderActionMenuPropsChange(
  prev: SessionHeaderActionMenuProps,
  next: SessionHeaderActionMenuProps,
): boolean {
  if (prev.sessionId !== next.sessionId) return true;
  if (prev.extraItems !== next.extraItems) return true;
  if (prev.onSelectExtraItem !== next.onSelectExtraItem) return true;
  if (!areSessionActionMenuMetadataSemanticallyEqual(prev.session.metadata, next.session.metadata)) return true;
  if (prev.session.active !== next.session.active) return true;
  if (prev.session.owner !== next.session.owner) return true;
  if (prev.session.archivedAt !== next.session.archivedAt) return true;
  if (prev.session.accessLevel !== next.session.accessLevel) return true;
  return (prev.session.seq > 0) !== (next.session.seq > 0);
}

function SessionHeaderActionMenuInner(props: SessionHeaderActionMenuProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const enabledAgentIds = useEnabledAgentIds();
  const settings = useSettings();
  const sessionReplayEnabled = useSetting('sessionReplayEnabled');
  const voice = useSetting('voice');
  const hasGlobalVoiceAgentConversation = useHasGlobalVoiceAgentConversation();
  const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
  const sessionServerId = usePreferredServerIdForSession(props.sessionId);
  const readStateSignature = storage((state) =>
    buildSessionHeaderReadStateSignature(state, props.sessionId),
  );
  const [open, setOpen] = React.useState(false);
  const session = React.useMemo(
    () => open ? readCurrentSessionForOpenMenu(props.sessionId, props.session) : props.session,
    [open, props.session, props.sessionId],
  );
  const sessionActionTarget = React.useMemo(
    () => createSessionActionTarget({
      session,
      serverId: sessionServerId ?? null,
      currentUserId: !session.accessLevel && typeof session.owner === 'string' ? session.owner : null,
      isConnected: session.active === true,
      isPinned: false,
      resumeCapabilityOptions: { accountSettings: settings },
    }),
    [readStateSignature, session, sessionServerId, settings],
  );
  const reachableMachineId = useSessionMachineTarget(props.sessionId)?.machineId ?? null;
  const sourceMachineId = React.useMemo(
    () => resolveSessionHandoffSourceMachineId({
      reachableMachineId,
      sessionMetadata: session.metadata as any,
    }),
    [session.metadata, reachableMachineId],
  );
  const serverSnapshot = useServerFeaturesSnapshotForServerId(sessionServerId, { enabled: Boolean(sessionServerId) });
  const runtimeAvailability = useSessionHandoffSourceReachability({
    serverId: sessionServerId,
    sourceMachineId,
  });
  const handoffAvailability = resolveSessionHandoffUiAvailability({
    sessionId: props.sessionId,
    session,
    sessionHandoffFeatureEnabled: sessionHandoffEnabled,
    serverSnapshot,
    runtimeAvailability,
  });
  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
      openSession: (childSessionId: string) => completeSessionForkNavigation({
        childSessionId,
        parentSessionId: props.sessionId,
        navigate: (targetSessionId) => router.push((`/session/${targetSessionId}`) as any),
      }),
    }),
    [props.sessionId, router],
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
      .filter((spec) => spec.id !== 'session.fork' || canForkConversation({ session, replayEnabled: sessionReplayEnabled }) === true)
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

    const existingActionIds = new Set(out.map((item) => item.id));
    for (const actionId of listVisibleSessionActionIds({
      target: sessionActionTarget,
      surface: 'sessionHeader',
    })) {
      if (existingActionIds.has(actionId)) continue;
      const actionItem = createSessionActionDropdownItem({
        actionId,
        iconColor: theme.colors.chrome.header.foreground,
      });
      if (actionItem) {
        out.push(actionItem);
        existingActionIds.add(actionId);
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
    session,
    sessionActionTarget,
    sessionHandoffEnabled,
    sessionReplayEnabled,
    settings,
    showTeleportAction,
    handoffAvailability.available,
    theme.colors.chrome.header.foreground,
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
        const manualReadState = resolveManualReadStateFromSessionActionId(actionId);
        if (manualReadState) {
          const sessionActionId = manualReadState === 'read'
            ? SESSION_ACTION_MARK_READ_ID
            : SESSION_ACTION_MARK_UNREAD_ID;
          fireAndForget((async () => {
            try {
              await executeSessionAction({
                actionId: sessionActionId,
                target: sessionActionTarget,
              });
            } catch (error) {
              Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t(
                  manualReadState === 'read'
                    ? 'sessionInfo.failedToMarkSessionRead'
                    : 'sessionInfo.failedToMarkSessionUnread',
                ),
              );
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionReadState' });
          return;
        }
        if (actionId === SESSION_ACTION_RENAME_ID) {
          fireAndForget((async () => {
            const title = await Modal.prompt(
              t('sessionInfo.renameSession'),
              t('sessionInfo.renameSessionSubtitle'),
              {
                defaultValue: getSessionName(session),
                placeholder: t('sessionInfo.renameSessionPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
              },
            );
            if (!title?.trim()) return;
            try {
              await executeSessionAction({
                actionId: SESSION_ACTION_RENAME_ID,
                target: sessionActionTarget,
                input: { title },
              });
            } catch (error) {
              Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('sessionInfo.failedToRenameSession'),
              );
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionRename' });
          return;
        }
        if (actionId === SESSION_ACTION_RESUME_ID) {
          fireAndForget(executeSessionAction({
            actionId: SESSION_ACTION_RESUME_ID,
            target: sessionActionTarget,
            context: {
              operations: {
                resumeSession: async (sessionId) => {
                  await emitSessionResumeRequest(sessionId);
                },
              },
            },
          }), {
            tag: 'SessionHeaderActionMenu.execute.sessionResume',
            onError: () => {
              Modal.alert(t('common.error'), t('session.resumeFailed'));
            },
          });
          return;
        }
        if (actionId === SESSION_ACTION_STOP_ID || actionId === SESSION_ACTION_ARCHIVE_ID) {
          fireAndForget((async () => {
            const isArchive = actionId === SESSION_ACTION_ARCHIVE_ID;
            const confirmed = await Modal.confirm(
              isArchive ? t('sessionInfo.archiveSession') : t('sessionInfo.stopSession'),
              isArchive ? t('sessionInfo.archiveSessionConfirm') : t('sessionInfo.stopSessionConfirm'),
              {
                cancelText: t('common.cancel'),
                confirmText: isArchive ? t('sessionInfo.archiveSession') : t('sessionInfo.stopSession'),
                destructive: true,
              },
            );
            if (!confirmed) return;
            try {
              await executeSessionAction({
                actionId: isArchive ? SESSION_ACTION_ARCHIVE_ID : SESSION_ACTION_STOP_ID,
                target: sessionActionTarget,
              });
            } catch (error) {
              Modal.alert(
                t('common.error'),
                error instanceof Error
                  ? error.message
                  : isArchive
                    ? t('sessionInfo.failedToArchiveSession')
                    : t('sessionInfo.failedToStopSession'),
              );
            }
          })(), { tag: `SessionHeaderActionMenu.execute.${actionId}` });
          return;
        }
        if (actionId === SESSION_ACTION_UNARCHIVE_ID) {
          fireAndForget((async () => {
            try {
              await executeSessionAction({
                actionId: SESSION_ACTION_UNARCHIVE_ID,
                target: sessionActionTarget,
              });
            } catch (error) {
              Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('sessionInfo.failedToUnarchiveSession'),
              );
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionUnarchive' });
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
          session,
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
            <Icon name="dots-three" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
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

export const SessionHeaderActionMenu = React.memo(
  SessionHeaderActionMenuInner,
  (prev, next) => !didSessionHeaderActionMenuPropsChange(prev, next),
);
