import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listActionSpecs } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { storage, useProfile, useSetting, useSettings } from '@/sync/domains/state/storage';
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
import { machineExternalSessionFollowPolicySet } from '@/sync/ops/machineExternalSessions';
import { useSessionHandoffSourceReachability } from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
  readExternalSessionFollowPolicy,
  updateMetadataWithExternalSessionFollowPolicy,
} from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { sync } from '@/sync/sync';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import {
  executeSessionAction,
} from '@/components/sessions/actions/sessionActionExecution';
import {
  createSessionActionTarget,
} from '@/components/sessions/actions/sessionActionContext';
import {
  createSessionActionDropdownItem,
} from '@/components/sessions/actions/sessionActionPresentation';
import {
  listVisibleSessionActionIds,
} from '@/components/sessions/actions/sessionActionAvailability';
import {
  SESSION_ACTION_ARCHIVE_ID,
  SESSION_ACTION_RENAME_ID,
  SESSION_ACTION_STOP_ID,
  resolveManualReadStateFromSessionActionId,
} from '@/components/sessions/actions/sessionActionIds';
import { buildSessionMetadataStabilitySignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { HappyError } from '@/utils/errors/errors';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
  createPluginSessionHeaderActionDropdownItems,
  resolvePluginSessionHeaderActionOpenSurface,
} from './pluginHeaderActions';

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
  pluginUiProjection?: PluginUiProjectionModel | null;
  pluginUiLocale?: string | null;
  onOpenPluginSurface?: (surfaceId: string) => void;
}>;

function readCurrentSessionForOpenMenu(sessionId: string, fallback: Session): Session {
  return storage.getState().sessions[sessionId] ?? fallback;
}

function showSessionHeaderActionError(error: unknown): void {
  if (error instanceof HappyError) {
    Modal.alert(t('common.error'), error.message);
    return;
  }
  Modal.alert(t('common.error'), t('errors.unknownError'));
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
  if (prev.pluginUiProjection !== next.pluginUiProjection) return true;
  if (prev.pluginUiLocale !== next.pluginUiLocale) return true;
  if (prev.onOpenPluginSurface !== next.onOpenPluginSurface) return true;
  if (prev.session.serverId !== next.session.serverId) return true;
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
  const profile = useProfile();
  const sessionReplayEnabled = useSetting('sessionReplayEnabled');
  const voice = useSetting('voice');
  const hasGlobalVoiceAgentConversation = useHasGlobalVoiceAgentConversation();
  const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
  const [open, setOpen] = React.useState(false);
  const session = React.useMemo(
    () => open ? readCurrentSessionForOpenMenu(props.sessionId, props.session) : props.session,
    [open, props.session, props.sessionId],
  );
  const preferredSessionServerId = usePreferredServerIdForSession(props.sessionId, session.serverId ?? null);
  const sessionServerId = React.useMemo(
    () => resolveSessionTargetServerId(props.sessionId, preferredSessionServerId ?? session.serverId ?? null),
    [preferredSessionServerId, session.serverId, props.sessionId],
  );
  const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
  const sessionActionTarget = React.useMemo(() => createSessionActionTarget({
    session,
    serverId: sessionServerId ?? null,
    currentUserId,
    isConnected: true,
  }), [currentUserId, session, sessionServerId]);
  const reachableMachineId = useSessionReachableMachineTarget(props.sessionId)?.machineId ?? null;
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
    serverId: sessionServerId,
    reachableMachineId,
    session,
    sessionHandoffFeatureEnabled: sessionHandoffEnabled,
    serverSnapshot,
    runtimeAvailability,
  });
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
  const externalSessionLink = readExternalSessionLink(session.metadata);
  const externalSessionFollowPolicy = readExternalSessionFollowPolicy(session.metadata);
  const externalSessionAgentId = React.useMemo(
    () => resolveAgentIdFromFlavor(
      typeof (session.metadata as Record<string, unknown> | null | undefined)?.flavor === 'string'
        ? String((session.metadata as Record<string, unknown>).flavor)
        : externalSessionLink?.providerId ?? null,
    ),
    [session.metadata, externalSessionLink?.providerId],
  );
  const supportsExternalSessionBackgroundFollow =
    externalSessionAgentId != null
      ? resolveAgentUiBehavior(externalSessionAgentId).externalSessions?.supportsBackgroundFollow === true
      : false;
  const actions = React.useMemo(() => {
    const actionItems: DropdownMenuItem[] = listActionSpecs()
      .filter((spec) => spec.surfaces.ui === true)
      .filter((spec) => isActionEnabledInState({ settings } as any, spec.id, { surface: 'ui', placement: 'session_action_menu' } as any))
      .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('session_action_menu' as any))
      .filter((spec) => spec.id !== 'session.fork' || canForkConversation({ session, replayEnabled: sessionReplayEnabled }) === true)
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

    if (externalSessionLink && supportsExternalSessionBackgroundFollow) {
      out.push({
        id: 'session.externalSession.backgroundFollow',
        title: t('session.actionMenu.backgroundFollow'),
        subtitle: externalSessionFollowPolicy === 'background_follow' ? t('common.enabled') : t('common.disabled'),
      });
    }

    if (Array.isArray(props.extraItems) && props.extraItems.length > 0) {
      out.push(...props.extraItems);
    }

    out.push(...createPluginSessionHeaderActionDropdownItems({
      projection: props.pluginUiProjection,
      iconColor: theme.colors.chrome.header.foreground,
      locale: props.pluginUiLocale,
    }));

    for (const actionId of listVisibleSessionActionIds({ target: sessionActionTarget, surface: 'sessionHeader' })) {
      const item = createSessionActionDropdownItem({
        actionId,
        iconColor: theme.colors.chrome.header.foreground,
      });
      if (item) out.push(item);
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
    sessionReplayEnabled,
    settings,
    showTeleportAction,
    handoffAvailability,
    externalSessionLink,
    externalSessionFollowPolicy,
    supportsExternalSessionBackgroundFollow,
    sessionActionTarget,
    props.pluginUiLocale,
    props.pluginUiProjection,
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
        const pluginSurfaceId = resolvePluginSessionHeaderActionOpenSurface({
          projection: props.pluginUiProjection,
          menuActionId: actionId,
        });
        if (pluginSurfaceId) {
          props.onOpenPluginSurface?.(pluginSurfaceId);
          return;
        }
        if (actionId === 'session.externalSession.backgroundFollow') {
          fireAndForget((async () => {
            if (!externalSessionLink) return;
            const nextPolicy = externalSessionFollowPolicy === 'background_follow' ? 'attached_only' : 'background_follow';
            const result = await machineExternalSessionFollowPolicySet({
              machineId: externalSessionLink.machineId,
              sessionId: props.sessionId,
              providerId: externalSessionLink.providerId,
              remoteSessionId: externalSessionLink.remoteSessionId,
              source: externalSessionLink.source,
              enabled: nextPolicy === 'background_follow',
            }, sessionServerId ? { serverId: sessionServerId } : undefined).catch(() => undefined);
            if (!result?.ok) {
              return;
            }
            sync.applySessionMetadataLocally(props.sessionId, (metadata) =>
              updateMetadataWithExternalSessionFollowPolicy(metadata, {
                policy: nextPolicy,
                updatedAtMs: result.updatedAtMs,
              }),
            );
          })(), { tag: 'SessionHeaderActionMenu.execute.externalSessionBackgroundFollow' });
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
        const manualReadState = resolveManualReadStateFromSessionActionId(actionId);
        const handledSessionActionIds = new Set(listVisibleSessionActionIds({
          target: sessionActionTarget,
          surface: 'sessionHeader',
        }));
        if (manualReadState || handledSessionActionIds.has(actionId as any)) {
          fireAndForget((async () => {
            try {
              if (actionId === SESSION_ACTION_RENAME_ID) {
                const newName = await Modal.prompt(
                  t('sessionInfo.renameSession'),
                  undefined,
                  {
                    defaultValue: session.metadata?.name ?? '',
                    placeholder: t('sessionInfo.renameSessionPlaceholder'),
                    confirmText: t('common.save'),
                    cancelText: t('common.cancel'),
                  },
                );
                if (!newName?.trim()) return;
                await executeSessionAction({
                  actionId: SESSION_ACTION_RENAME_ID,
                  target: sessionActionTarget,
                  input: { title: newName },
                });
                return;
              }
              if (actionId === SESSION_ACTION_STOP_ID || actionId === SESSION_ACTION_ARCHIVE_ID) {
                const confirmed = await Modal.confirm(
                  actionId === SESSION_ACTION_STOP_ID ? t('sessionInfo.stopSession') : t('sessionInfo.archiveSession'),
                  actionId === SESSION_ACTION_STOP_ID ? t('sessionInfo.stopSessionConfirm') : t('sessionInfo.archiveSessionConfirm'),
                  {
                    cancelText: t('common.cancel'),
                    confirmText: actionId === SESSION_ACTION_STOP_ID ? t('sessionInfo.stopSession') : t('sessionInfo.archiveSession'),
                    destructive: true,
                  },
                );
                if (!confirmed) return;
              }
              await executeSessionAction({
                actionId: actionId as any,
                target: sessionActionTarget,
              });
            } catch (error) {
              showSessionHeaderActionError(error);
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionAction' });
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
            <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.chrome.header.foreground} />
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
