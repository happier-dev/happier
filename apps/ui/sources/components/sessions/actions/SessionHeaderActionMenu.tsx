import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listActionSpecs } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { storage, useProfile, useSetting, useSettings } from '@/sync/domains/state/storage';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
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
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';
import { runSessionHandoffPickerFlow } from '@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow';
import { resolveSessionHandoffSourceMachineId } from '@/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId';
import {
  resolveSessionHandoffUiAvailability,
} from '@/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
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
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import {
  readExternalSessionFollowPolicy,
  updateMetadataWithExternalSessionFollowPolicy,
} from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
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
  SESSION_ACTION_RESUME_ID,
  SESSION_ACTION_STOP_ID,
  resolveManualReadStateFromSessionActionId,
} from '@/components/sessions/actions/sessionActionIds';
import { buildSessionMetadataStabilitySignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { HappyError } from '@/utils/errors/errors';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import {
  PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX,
  dispatchPluginSessionHeaderAction,
  type PluginSessionHeaderActionPresentation,
} from './pluginHeaderActions';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
  SESSION_HEADER_ACTION_TAP_TARGET_PX,
  SESSION_HEADER_ICON_SIZE_PX,
} from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { supportsExternalSessionBackgroundFollow } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';

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
  /** Exact Session-scope authority; never reconstruct it from header state. */
  pluginUiScopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
  /** Existing Account-scope lifetime predicate for the rendered header authority. */
  pluginUiScopeIsCurrent?: (() => boolean) | null;
  onOpenPluginSurface?: PluginSurfaceOpenHandler;
  /** One normalized list from the Session header's responsive-policy owner. */
  pluginHeaderActions?: readonly PluginSessionHeaderActionPresentation[];
  /** The Session header's bounded direct/overflow policy, never plugin metadata. */
  pluginHeaderActionPlacement?: 'direct' | 'overflow';
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
  state: Pick<StorageState, 'sessions' | 'sessionListRenderables' | 'sessionListRowStateByServerId' | 'sessionMessages'>,
  sessionId: string,
  serverId: string | null,
): string {
  const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
  const session = state.sessions[sessionId];
  const scopedRenderable = normalizedServerId
    ? state.sessionListRowStateByServerId?.[normalizedServerId]?.[sessionId]
    : undefined;
  const renderable = scopedRenderable ?? state.sessionListRenderables[sessionId];
  const messages = state.sessionMessages[sessionId] as Readonly<{
    isLoaded?: unknown;
    messageIdsOldestFirst?: ReadonlyArray<unknown>;
    messagesVersion?: unknown;
    reducerVersion?: unknown;
    renderableAggregate?: unknown;
  }> | undefined;
  const readStateV1 = readLegacyReadStateMetadata(
    session ? readSessionOwnerMetadataView(session) : null,
  );

  return [
    signatureValue(session?.seq),
    signatureValue(session?.lastViewedSessionSeq),
    signatureValue(session?.latestReadyEventSeq),
    signatureValue(session?.latestTurnStatus),
    signatureValue(session?.accessLevel),
    signatureValue(readStateV1.sessionSeq),
    signatureValue(readStateV1.pendingActivityAt),
    signatureValue(renderable?.hasUnreadMessages),
    signatureValue(renderable?.seq),
    signatureValue(renderable?.lastViewedSessionSeq),
    signatureValue(renderable?.latestReadyEventSeq),
    signatureValue(messages?.isLoaded),
    signatureValue(messages?.messagesVersion),
    signatureValue(messages?.reducerVersion),
    signatureValue(messages?.messageIdsOldestFirst?.length),
    signatureValue(messages?.renderableAggregate ? 1 : 0),
  ].join('|');
}

function showSessionHeaderActionError(error: unknown): void {
  if (error instanceof HappyError) {
    Modal.alert(t('common.error'), error.message);
    return;
  }
  Modal.alert(t('common.error'), t('errors.unknownError'));
}

type WebActionMenuTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & Readonly<{
  'data-testid': string;
  style: React.CSSProperties;
}>;

function areSessionActionMenuMetadataSemanticallyEqual(
  prev: Session,
  next: Session,
): boolean {
  if (prev === next) return true;
  return (
    buildSessionMetadataStabilitySignature(prev.metadata)
      === buildSessionMetadataStabilitySignature(next.metadata)
    && buildSessionMetadataStabilitySignature(readSessionOwnerMetadataView(prev))
      === buildSessionMetadataStabilitySignature(readSessionOwnerMetadataView(next))
  );
}

function didSessionHeaderActionMenuPropsChange(
  prev: SessionHeaderActionMenuProps,
  next: SessionHeaderActionMenuProps,
): boolean {
  if (prev.sessionId !== next.sessionId) return true;
  if (prev.extraItems !== next.extraItems) return true;
  if (prev.onSelectExtraItem !== next.onSelectExtraItem) return true;
  if (prev.pluginUiProjection !== next.pluginUiProjection) return true;
  if (prev.pluginUiScopedLaunchFacts !== next.pluginUiScopedLaunchFacts) return true;
  if (prev.pluginUiScopeIsCurrent !== next.pluginUiScopeIsCurrent) return true;
  if (prev.onOpenPluginSurface !== next.onOpenPluginSurface) return true;
  if (prev.pluginHeaderActions !== next.pluginHeaderActions) return true;
  if (prev.pluginHeaderActionPlacement !== next.pluginHeaderActionPlacement) return true;
  if (prev.session.serverId !== next.session.serverId) return true;
  if (!areSessionActionMenuMetadataSemanticallyEqual(prev.session, next.session)) return true;
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
  const executionRunsEnabled = useFeatureEnabled('execution.runs');
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
  const readStateSignature = storage((state) =>
    buildSessionHeaderReadStateSignature(state, props.sessionId, sessionServerId ?? null),
  );
  const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
  const reachableMachineId = useSessionReachableMachineTarget(props.sessionId)?.machineId ?? null;
  const ownerMetadata = readSessionOwnerMetadataView(session);
  const resumeAgentId = resolveAgentIdFromSessionMetadata(ownerMetadata)
    ?? resolveAgentIdFromFlavor(ownerMetadata?.flavor ?? null);
  const { resumeCapabilityOptions } = useResumeCapabilityOptions({
    agentId: resumeAgentId,
    machineId: reachableMachineId,
    serverId: sessionServerId,
    settings,
    enabled: session.active !== true,
  });
  const sessionActionTarget = React.useMemo(() => createSessionActionTarget({
    session,
    serverId: sessionServerId ?? null,
    currentUserId,
    isConnected: true,
    resumeCapabilityOptions,
  }), [currentUserId, readStateSignature, resumeCapabilityOptions, session, sessionServerId]);
  const sourceMachineId = React.useMemo(
    () => resolveSessionHandoffSourceMachineId({
      reachableMachineId,
      sessionMetadata: ownerMetadata,
    }),
    [ownerMetadata, reachableMachineId],
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
      openSession: (childSessionId: string, options?: { serverId?: string | null }) => {
        router.push(buildScopedSessionRouteHref({
          sessionId: childSessionId,
          serverId: options?.serverId ?? sessionServerId,
        }) as any);
      },
    }),
    [router, sessionServerId],
  );
  const teleportAvailability = React.useMemo(
    () => getVoiceAgentSessionTeleportAvailability({ voice, sessionId: props.sessionId }),
    [props.sessionId, voice],
  );
  const showTeleportAction = teleportAvailability.ok && hasGlobalVoiceAgentConversation;
  const externalSessionLink = readExternalSessionLink(ownerMetadata);
  const externalSessionFollowPolicy = readExternalSessionFollowPolicy(ownerMetadata);
  const daemonMergedProjection = useDaemonMergedProjectionInputs({
    machineId: externalSessionLink?.machineId ?? null,
    serverId: sessionServerId,
    enabled: externalSessionLink !== null,
  });
  const supportsExternalSessionBackgroundFollowForLink = React.useMemo(() => {
    if (!externalSessionLink || daemonMergedProjection.phase !== 'ready') {
      return false;
    }
    return supportsExternalSessionBackgroundFollow({
      providerId: externalSessionLink.agentId,
      source: externalSessionLink.source,
      projection: daemonMergedProjection.inputs?.pluginProjectionV2,
    });
  }, [daemonMergedProjection.inputs?.pluginProjectionV2, daemonMergedProjection.phase, externalSessionLink]);
  const invokePluginHeaderAction = React.useCallback((menuActionId: string) => {
    // Both responsive controls re-resolve the selected descriptor against the
    // current projection through this one callback. The descriptor list never
    // gains execution authority merely by being rendered directly.
    fireAndForget((async () => {
      const outcome = await dispatchPluginSessionHeaderAction({
        projection: props.pluginUiProjection,
        menuActionId,
        scopedLaunchFacts: props.pluginUiScopedLaunchFacts,
        scopeIsCurrent: props.pluginUiScopeIsCurrent,
        sessionId: props.sessionId,
        openSurface: props.onOpenPluginSurface,
      });
      if (outcome && !outcome.ok) {
        Modal.alert(t('common.error'), t('pluginRuntime.unavailableGeneric'));
      }
    })(), { tag: 'SessionHeaderActionMenu.execute.pluginHeaderAction' });
  }, [
    props.onOpenPluginSurface,
    props.pluginUiScopedLaunchFacts,
    props.pluginUiScopeIsCurrent,
    props.pluginUiProjection,
    props.sessionId,
  ]);
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

    if (externalSessionLink && supportsExternalSessionBackgroundFollowForLink) {
      out.push({
        id: 'session.externalSession.backgroundFollow',
        title: t('session.actionMenu.backgroundFollow'),
        subtitle: externalSessionFollowPolicy === 'background_follow' ? t('common.enabled') : t('common.disabled'),
      });
    }

    if (Array.isArray(props.extraItems) && props.extraItems.length > 0) {
      out.push(...props.extraItems);
    }

    if (props.pluginHeaderActionPlacement === 'overflow') {
      out.push(...(props.pluginHeaderActions ?? []).map((action): DropdownMenuItem => ({
        id: action.menuActionId,
        title: action.title,
        icon: <Icon name={action.iconName} size={16} color={theme.colors.chrome.header.foreground} />,
        ...(action.enabled ? {} : { disabled: true }),
      })));
    }

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
    supportsExternalSessionBackgroundFollowForLink,
    sessionActionTarget,
    props.pluginHeaderActionPlacement,
    props.pluginHeaderActions,
    theme.colors.chrome.header.foreground,
  ]);

  const directPluginHeaderActions = props.pluginHeaderActionPlacement === 'direct'
    ? props.pluginHeaderActions ?? []
    : [];
  const headerInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
  const headerInteractiveHitSlop = headerInteractiveTargetSize > SESSION_HEADER_ACTION_TAP_TARGET_PX
    ? undefined
    : 15;

  if (actions.length === 0 && directPluginHeaderActions.length === 0) return null;

  return (
    <>
      {directPluginHeaderActions.map((action) => (
        <Pressable
          key={action.menuActionId}
          onPress={() => {
            if (action.enabled) {
              invokePluginHeaderAction(action.menuActionId);
            }
          }}
          disabled={!action.enabled}
          hitSlop={headerInteractiveHitSlop}
          testID={`session-header-plugin-action-${action.menuActionId}`}
          accessibilityRole="button"
          accessibilityLabel={action.title}
          accessibilityState={{ disabled: !action.enabled }}
          style={({ pressed }) => ({
            width: headerInteractiveTargetSize,
            height: headerInteractiveTargetSize,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: !action.enabled ? 0.45 : pressed ? 0.7 : 1,
          })}
        >
          <Icon
            name={action.iconName}
            size={SESSION_HEADER_ICON_SIZE_PX}
            color={theme.colors.chrome.header.foreground}
          />
        </Pressable>
      ))}
      {actions.length > 0 ? (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={actions}
      onSelect={(actionId) => {
        setOpen(false);
        if (props.onSelectExtraItem?.(actionId) === true) return;
        if (actionId.startsWith(PLUGIN_SESSION_HEADER_ACTION_MENU_PREFIX)) {
          invokePluginHeaderAction(actionId);
          return;
        }
        if (actionId === 'session.externalSession.backgroundFollow') {
          fireAndForget((async () => {
            if (!externalSessionLink) return;
            const nextPolicy = externalSessionFollowPolicy === 'background_follow' ? 'attached_only' : 'background_follow';
            const result = await machineExternalSessionFollowPolicySet({
              machineId: externalSessionLink.machineId,
              sessionId: props.sessionId,
              agentId: externalSessionLink.agentId,
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
                const currentSessionTitle = readSessionDisplayTitleField(session).value ?? ownerMetadata?.name ?? '';
                const newName = await Modal.prompt(
                  t('sessionInfo.renameSession'),
                  undefined,
                  {
                    defaultValue: currentSessionTitle,
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
                ...(actionId === SESSION_ACTION_RESUME_ID
                  ? {
                      context: {
                        operations: {
                          resumeSession: async (sessionId: string) => {
                            await emitSessionResumeRequest(sessionId);
                          },
                        },
                      },
                    }
                  : {}),
              });
            } catch (error) {
              showSessionHeaderActionError(error);
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionAction' });
          return;
        }
        if (actionId === 'session.fork') {
          // A launcher only. The header must not also run the old auto-strategy
          // path behind the modal: the user chooses Native, Replay or Configure
          // before any fork effect is issued.
          deferOnWeb(() => {
            openSessionForkStrategyFlow({
              sessionId: props.sessionId,
              forkSupportSource: session,
              serverId: sessionServerId ?? null,
              machineId: reachableMachineId ?? ownerMetadata?.machineId ?? null,
              forkPoint: { type: 'latest' },
              settings,
              replayEnabled: sessionReplayEnabled,
              executionRunsEnabled: executionRunsEnabled === true,
              navigateToSession: (childSessionId, options) => {
                router.push(buildScopedSessionRouteHref({
                  sessionId: childSessionId,
                  serverId: options?.serverId ?? sessionServerId,
                }) as any);
              },
              navigateToNewSession: (route) => {
                navigateWithBlurOnWeb(() => router.push(route as any));
              },
            });
          });
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
      trigger={({ toggle }) => {
        const label = t('session.actionMenu.openA11y');
        const icon = (
          <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="ellipsis-horizontal" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
          </View>
        );

        if (Platform.OS === 'web') {
          const webTriggerProps: WebActionMenuTriggerProps = {
            type: 'button',
            'data-testid': 'session-header-action-menu-trigger',
            role: 'button',
            'aria-label': label,
            onClick: (event) => {
              if (!event) return;
              event.stopPropagation();
              toggle();
            },
            style: {
              width: 44,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              margin: 0,
              border: 0,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              appearance: 'none',
              WebkitAppearance: 'none',
            },
          };
          return React.createElement(
            'button',
            webTriggerProps,
            icon,
          );
        }

        return (
          <Pressable
            onPress={toggle}
            hitSlop={headerInteractiveHitSlop}
            testID="session-header-action-menu-trigger"
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => ({
              width: headerInteractiveTargetSize,
              height: headerInteractiveTargetSize,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            {icon}
          </Pressable>
        );
      }}
      placement="bottom"
      variant="slim"
      rowKind="selectableRow"
      search={false}
      matchTriggerWidth={false}
      maxWidthCap={320}
    />
      ) : null}
    </>
  );
}

export const SessionHeaderActionMenu = React.memo(
  SessionHeaderActionMenuInner,
  (prev, next) => !didSessionHeaderActionMenuPropsChange(prev, next),
);
