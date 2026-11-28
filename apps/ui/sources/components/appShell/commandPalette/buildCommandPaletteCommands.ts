import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { detachedReviewStartSeed, type ExecutionRunLauncherDraftSeed } from '@/components/sessions/runs/launcher/prepareExecutionRunLauncherDraft';
import { ACTION_ID_FAMILIES_V1, REVIEW_START_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { listUiActionSpecsForPlacement } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildActionDraftInput } from '@/sync/domains/actions/buildActionDraftInput';
import { openCatalogAction } from '@/components/sessions/actions/openCatalogAction';
import { readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { VoiceConversationActionResultSchema, type VoiceConversationActionId, type VoiceConversationStatus } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';

import type { Command } from './types';
import type { SessionComposerModelFavorite } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { formatReasoningEffortTierLabel } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import type { AskHappierContext } from '@/sync/domains/pending/pendingSetupIntent.shared';
import type { KeyboardCommandId } from '@/keyboard';
import { defaultKeyboardCommands, sessionPanelKeyboardCommands } from '@/keyboard/commands';
import {
  isCompactAppDestinationVisible,
  isCompactAppDestinationInvokable,
  type CompactAppDestination,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { storage } from '@/sync/domains/state/storage';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import {
  resolveSessionActionDefaultBackend,
  resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { openPluginContributedAction } from '@/components/plugins/actions/openPluginContributedAction';
import {
  resolvePluginContributedActionIconName,
} from '@/components/plugins/actions/pluginContributedActionPresentation';
import type { PluginContributedActionController } from '@/components/plugins/actions/pluginContributedActionController';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { resolveSessionScmReviewComparisonLabel } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { readSettingsPagePresentation } from '@/components/settings/catalog/loadSettingsPagePresentation';
import { buildSettingHref, settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { desktopHostKind } from '@/utils/platform/desktopHost';

function normalizeId(value: unknown): string {
  return String(value ?? '').trim();
}

function extractRecentSessionIds(sessionsById: Record<string, any>): string[] {
  const sessions = Object.values(sessionsById ?? {}).filter(isUserFacingSession);
  sessions.sort((a: any, b: any) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0));
  return sessions
    .map((s: any) => normalizeId(s?.id))
    .filter(Boolean)
    .slice(0, 5);
}

export type CommandPaletteRecentSession = Readonly<{ sessionId: string; serverId: string; title: string; subtitle: string }>;

/** The Sessions the palette lists, and the only Session facts its rows show. */
export function selectCommandPaletteRecentSessions(sessionsById: Record<string, any>): readonly CommandPaletteRecentSession[] {
  return extractRecentSessionIds(sessionsById).map((sessionId) => {
    const session = sessionsById[sessionId];
    return {
      sessionId,
      serverId: typeof session?.serverId === 'string' ? session.serverId.trim() : '',
      ...readSessionLabel(session),
    };
  });
}

function readSessionLabel(session: any): Readonly<{ title: string; subtitle: string }> {
  const metadata = readSessionOwnerMetadataView(session);
  const title = getSessionName(session);
  const path = typeof metadata?.path === 'string' && readSessionDirectoryKind(metadata) !== 'managed' ? metadata.path.trim() : '';
  const subtitle = path || t('commandPalette.commands.sessionFallbackSubtitle');
  return { title, subtitle };
}

async function requireSession(
  activeSessionId: string | null,
  alert: (title: string, message: string) => void | Promise<void>,
): Promise<string | null> {
  if (activeSessionId) return activeSessionId;
  await alert(t('commandPalette.commands.sessionRequiredTitle'), t('commandPalette.commands.sessionRequiredBody'));
  return null;
}

export type PetCommandSurface = 'desktopOverlay' | 'appShell' | 'none';

export type PetCommandControls = Readonly<{
  surface: PetCommandSurface;
  wake: () => void | Promise<void>;
  tuck: () => void | Promise<void>;
  resetPosition?: () => void | Promise<void>;
  refreshCodexPets: () => void | Promise<void>;
}>;

export type PaneCommandControls = Readonly<{
  readColumn(column: 'navigation' | 'main' | 'side'): Readonly<{ present: boolean; visible: boolean; available: boolean; label?: string }> | null;
  toggleArrangement?: () => void;
  focusRegion?: (direction: 'next' | 'previous') => void;
}>;

/** The active File page's view, read through the `file.view.*` owner; toggling goes through `file.view.set`. */
export type FileViewCommandControls = Readonly<{
  readActive(): Readonly<{ blame: boolean; blameAvailable: boolean }> | null;
  toggleBlame: () => void;
}>;

/** Invokes the mounted keyboard owner, including commands with no assigned binding. */
export type KeyboardCommandControls = Readonly<{
  isAvailable(commandId: KeyboardCommandId): boolean;
  execute(commandId: KeyboardCommandId): boolean;
}>;

type BuildCommandPaletteCommandsBaseParams = Readonly<{
  sessionsById: Record<string, any>;
  isDev: boolean;
  activeSessionId: string | null;
  /** Exact Home authority for the active Session; missing scope fails closed. */
  activeSessionServerId?: string | null;
  features: Readonly<{
    executionRunsEnabled: boolean;
    voiceEnabled: boolean;
    petsCompanionEnabled?: boolean;
    workflowsEnabled?: boolean;
  }>;
  shortcutLabels?: Partial<Record<KeyboardCommandId, string>>;
  /** The focused transcript message's actions (the message cursor), read as the palette opens; listed first. */
  focusedMessageActions?: readonly Readonly<{ commandId: KeyboardCommandId; run: () => void }>[];
  sessionCommands?: readonly Command[];
  keyboardCommands?: KeyboardCommandControls;
  petControls?: PetCommandControls;
  paneControls?: PaneCommandControls;
  fileViewControls?: FileViewCommandControls;
  themeCommands?: () => Promise<readonly Command[]>;
  /** Present only while the active Session's composer offers its model picker (the composer decides). */
  sessionModelPicker?: Readonly<{ open: () => void }>;
  /** The active Session composer's favourite models (lab: "Use favorite model …" by name). */
  sessionModelFavorites?: readonly SessionComposerModelFavorite[];
  askHappierRelease?: AskHappierContext['release'];
  nav: Readonly<{
    push: (path: string) => void;
    openNewSession: () => void;
    openNewWindow?: () => void | Promise<void>;
    openNewWorkflow?: () => void;
    openWorkflowAgentAuthoring?: () => void;
    /** Reopens the canonical Search surface in its content source, retaining exact invocation scope. */
    openTextInFiles?: () => void;
    openReplaceInFiles?: () => void;
    openFiles?: () => void;
    openSymbols?: () => void;
    /** Opens the shared device-pairing panel while retaining the current page. */
    openHomePairingModal?: () => void | Promise<void>;
    /** Supplied only when the ordinary guide draft owner can open the requested context. */
    openAskHappier?: (context?: AskHappierContext) => void | Promise<void>;
    /** Matches `useNavigateToSession`: the Home is passed when the producer holds it. */
    openExecutionRunDraft?: (seed: ExecutionRunLauncherDraftSeed) => void | Promise<void>;
    navigateToSession: (sessionId: string, opts?: Readonly<{ serverId?: string }>) => void;
  }>;
  actions: Readonly<{
    execute: (actionId: ActionId, parameters: unknown, ctx?: { defaultSessionId?: string | null; surface?: 'ui' }) => Promise<unknown>;
  }>;
  alert: (title: string, message: string) => void | Promise<void>;
}>;

type CompactAppDestinationCommandParams =
  | Readonly<{
    compactAppDestinations?: undefined;
    onActivateCompactAppDestination?: undefined;
  }>
  | Readonly<{
    compactAppDestinations: readonly CompactAppDestination[];
    onActivateCompactAppDestination: (destination: CompactAppDestination) => void;
  }>;

/**
 * The palette consumes already-admitted Action descriptors from the shared
 * controller. It owns presentation only: currentness, availability, forms,
 * policy, and dispatch remain at that controller and its canonical dispatcher.
 */
type PluginActionPresentationCommandParams =
  | Readonly<{
    pluginActionPresentation?: undefined;
  }>
  | Readonly<{
    pluginActionPresentation: Readonly<{
      controller: PluginContributedActionController;
      scope: 'global' | 'session';
      signal?: AbortSignal;
    }>;
  }>;

function resolveCompactAppDestinationCommandSubtitle(
  destination: CompactAppDestination,
): string | undefined {
  if (destination.kind !== 'plugin') {
    return undefined;
  }
  const parts = [
    destination.badge?.label,
    destination.availability === 'unavailable'
      ? resolveReasonCopy({
        reasonCode: destination.unavailableReason,
        kind: 'pluginRuntime',
      }).message
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

export function buildCommandPaletteCommands(
  params: BuildCommandPaletteCommandsBaseParams
    & CompactAppDestinationCommandParams
    & PluginActionPresentationCommandParams,
): Command[] {
  const actionDraftAccountScope = storage.getState().profileScope ?? null;
  const {
    sessionsById,
    isDev,
    activeSessionId,
    activeSessionServerId,
    features,
    nav,
    actions,
    alert,
  } = params;

  const cmds: Command[] = [
    ...(params.focusedMessageActions ?? []).flatMap((action): Command[] => {
      const command = defaultKeyboardCommands.find(candidate => candidate.id === action.commandId);
      return command ? [{ id: action.commandId, emptyQuerySuggested: true, title: t(command.settingsTitleKey),
        category: t('settingsKeyboard.groupTranscript'), shortcut: params.shortcutLabels?.[action.commandId], action: action.run }] : [];
    }),
    {
      id: 'new-session',
      emptyQuerySuggested: true,
      title: t('commandPalette.commands.newSessionTitle'),
      icon: 'plus-circle',
      category: t('commandPalette.commands.actionsCategory'),
      shortcut: params.shortcutLabels?.['session.new'],
      action: nav.openNewSession,
    },
    {
      id: 'account',
      title: t('commandPalette.commands.accountTitle'),
      icon: 'user-circle',
      category: t('commandPalette.commands.navigationCategory'),
      action: () => nav.push('/settings/account'),
    },
    {
      id: 'connect',
      title: t('commandPalette.commands.connectTerminalTitle'),
      icon: 'link',
      category: t('commandPalette.commands.actionsCategory'),
      action: () => nav.push('/scan/terminal'),
    },
  ];

  // Opens the Session's own model picker from both the palette and its keyboard command.
  if (params.sessionModelPicker) cmds.push({
    id: 'session.model.choose', emptyQuerySuggested: true, shortcut: params.shortcutLabels?.['session.model.choose'],
    title: t('commandPalette.commands.chooseModelTitle'), subtitle: t('commandPalette.commands.chooseModelSubtitle'),
    icon: 'sparkle', category: t('commandPalette.commands.actionsCategory'), action: params.sessionModelPicker.open,
  });

  // Lab palette "favorites by name": one command per favourite, run as the picker's row runs (session.model.set).
  for (const favorite of params.sessionModelFavorites ?? []) cmds.push({
    id: `session.model.favorite:${favorite.key}`, actionSpecId: 'session.model.set',
    title: t('commandPalette.commands.useFavoriteModelTitle', { model: favorite.label }),
    subtitle: [
      favorite.reasoningEffort ? formatReasoningEffortTierLabel(favorite.reasoningEffort) : null,
      favorite.current ? t('commandPalette.commands.favoriteModelCurrent') : null,
      favorite.sourceLabel ? t('commandPalette.commands.favoriteModelVia', { source: favorite.sourceLabel }) : null,
      favorite.requiresRestart ? t('settingsProviders.errors.restartRequiredTitle') : null,
    ].filter(Boolean).join(' · ') || undefined,
    icon: 'sparkle', category: t('commandPalette.commands.actionsCategory'),
    action: async () => { await favorite.apply(); },
    invokeAction: favorite.invokeAction,
  });

  if (params.themeCommands) cmds.push({
    id: 'theme.change', title: t('themePalette.change'), icon: 'palette',
    category: t('commandPalette.commands.actionsCategory'), loadCommands: params.themeCommands,
    action: () => nav.push('/settings/appearance/themes'),
  });

  if (nav.openNewWindow) cmds.push({
    id: 'desktop.new-window', actionSpecId: 'desktop.windows.open',
    title: t('common.newWindow'), icon: 'squares-four',
    category: t('commandPalette.commands.actionsCategory'), action: nav.openNewWindow,
  });

  for (const id of [
    ...sessionPanelKeyboardCommands.map(command => command.id),
    'sessionList.source.toggle', 'permission.open', 'composer.attachFile', 'mode.cycle', 'permission.cycle',
  ] as const) {
    if (!params.keyboardCommands?.isAvailable(id)) continue;
    const command = defaultKeyboardCommands.find(command => command.id === id);
    if (!command?.settingsTitleKey) continue;
    cmds.push({ id, title: t(command.settingsTitleKey), category: t('commandPalette.commands.actionsCategory'),
      shortcut: params.shortcutLabels?.[id], action: () => { params.keyboardCommands?.execute(id); } });
  }

  for (const [column, id, titleKey] of [
    ['navigation', 'shell.column.toggle', 'settingsKeyboard.commands.shellColumnToggle'],
    ['main', 'panes.main.toggle', 'settingsKeyboard.commands.panesMainToggle'],
    ['side', 'panes.side.toggle', 'settingsKeyboard.commands.panesSideToggle'],
  ] as const) {
    const control = params.paneControls?.readColumn(column);
    if (!control?.present || !control.available) continue;
    cmds.push({ id, actionSpecId: 'shell.column.set', title: control.label ?? t(titleKey),
      category: t('settingsKeyboard.paneGroups.panes'), shortcut: params.shortcutLabels?.[id],
      action: async () => {
        const current = params.paneControls?.readColumn(column);
        if (!current?.present || !current.available) return;
        await actions.execute('shell.column.set', { column, visible: !current.visible }, { surface: 'ui' });
      },
    });
  }
  if (params.paneControls?.toggleArrangement) {
    cmds.push({ id: 'panes.arrangement.toggle', actionSpecId: 'settings.set',
      title: t('settingsKeyboard.commands.panesArrangementToggle'), category: t('settingsKeyboard.paneGroups.panes'),
      shortcut: params.shortcutLabels?.['panes.arrangement.toggle'], action: params.paneControls.toggleArrangement,
    });
  }
  if (params.paneControls?.focusRegion) {
    const focusRegion = params.paneControls.focusRegion;
    for (const [direction, id, titleKey] of [
      ['next', 'panes.region.next', 'settingsKeyboard.commands.panesRegionNext'],
      ['previous', 'panes.region.previous', 'settingsKeyboard.commands.panesRegionPrevious'],
    ] as const) cmds.push({ id, title: t(titleKey), category: t('settingsKeyboard.paneGroups.panes'),
      shortcut: params.shortcutLabels?.[id], action: () => focusRegion(direction) });
  }

  const fileView = params.fileViewControls?.readActive();
  if (fileView?.blameAvailable && params.fileViewControls) {
    cmds.push({ id: 'file.blame.toggle', actionSpecId: 'file.view.set',
      title: t(fileView.blame ? 'files.pane.menu.hideBlame' : 'files.pane.menu.showBlame'), icon: 'file',
      category: t('commandPalette.commands.actionsCategory'), shortcut: params.shortcutLabels?.['file.blame.toggle'],
      action: params.fileViewControls.toggleBlame });
  }

  if (nav.openAskHappier) {
    const openAskHappier = nav.openAskHappier;
    cmds.push({
      id: 'askHappier',
      title: t('bots.guide.offer'),
      subtitle: t('bots.guide.menuSubtitle'),
      icon: 'sparkle',
      mark: 'askHappier',
      category: t('commandPalette.commands.actionsCategory'),
      action: () => openAskHappier(),
    });
    if (params.askHappierRelease) {
      const release = Object.freeze({ ...params.askHappierRelease });
      cmds.push({
        id: 'askHappier.aboutUpdate',
        title: t('bots.guide.aboutUpdate'),
        subtitle: t('bots.guide.aboutUpdateSubtitle', { version: release.versionLabel }),
        icon: 'sparkle',
        mark: 'askHappier',
        category: t('commandPalette.commands.actionsCategory'),
        action: () => openAskHappier({ kind: 'release', release }),
      });
    }
  }

  if (nav.openTextInFiles) {
    cmds.push({
      id: 'search.textInFiles',
      title: t('universalSearch.content.textInFiles'),
      icon: 'file',
      category: t('commandPalette.commands.actionsCategory'),
      shortcut: params.shortcutLabels?.['search.textInFiles'],
      action: nav.openTextInFiles,
    });
  }
  if (nav.openReplaceInFiles) {
    cmds.push({
      id: 'search.replaceInFiles',
      title: t('settingsKeyboard.commands.searchReplaceInFiles'),
      icon: 'arrows-left-right',
      category: t('commandPalette.commands.actionsCategory'),
      shortcut: params.shortcutLabels?.['search.replaceInFiles'],
      action: nav.openReplaceInFiles,
    });
  }
  for (const [id, title, open] of [
    ['search.files', t('settingsKeyboard.commands.searchFiles'), nav.openFiles],
    ['search.symbols', t('settingsKeyboard.commands.searchSymbols'), nav.openSymbols],
  ] as const) {
    if (open) cmds.push({ id, title, icon: 'file', category: t('commandPalette.commands.actionsCategory'),
      shortcut: params.shortcutLabels?.[id], action: open });
  }

  if (nav.openHomePairingModal) {
    cmds.push({
      id: 'add-phone',
      title: t('settings.addYourPhone'),
      icon: 'device-mobile',
      category: t('commandPalette.commands.actionsCategory'),
      action: nav.openHomePairingModal,
    });
  }

  if (params.compactAppDestinations !== undefined) {
    for (const destination of params.compactAppDestinations) {
      if (!isCompactAppDestinationVisible(destination) || !isCompactAppDestinationInvokable(destination)) {
        continue;
      }
      const builtin = destination.kind === 'builtin' ? destination : null;
      cmds.push({
        id: `app-destination:${destination.id}`,
        ...(builtin?.suggested ? { emptyQuerySuggested: true } : {}),
        title: destination.title,
        subtitle: resolveCompactAppDestinationCommandSubtitle(destination),
        icon: destination.icon,
        category: t('commandPalette.commands.navigationCategory'),
        ...(builtin?.shortcut ? { shortcut: params.shortcutLabels?.[builtin.shortcut] } : {}),
        action: () => params.onActivateCompactAppDestination(destination),
      });
    }
  }

  if (features.workflowsEnabled === true) {
    if (nav.openNewWorkflow) cmds.push({ id: 'workflow.new', title: t('workflows.newWorkflow'), icon: 'plus',
      category: t('commandPalette.commands.actionsCategory'), shortcut: params.shortcutLabels?.['workflow.new'], action: nav.openNewWorkflow });
    if (nav.openWorkflowAgentAuthoring) cmds.push({ id: 'workflow.createWithAgent', title: t('workflows.authoring.create'), icon: 'sparkle',
      category: t('commandPalette.commands.actionsCategory'), shortcut: params.shortcutLabels?.['workflow.createWithAgent'], action: nav.openWorkflowAgentAuthoring });
  }

  if (features.petsCompanionEnabled === true) {
    const petCategory = t('commandPalette.pets.category');
    const petControls = params.petControls;
    if (petControls && petControls.surface !== 'none') {
      cmds.push(
        {
          id: 'pet-wake',
          title: t('commandPalette.pets.wakeTitle'),
          icon: 'paw-print',
          category: petCategory,
          action: () => petControls.wake(),
        },
        {
          id: 'pet-tuck',
          title: t('commandPalette.pets.tuckTitle'),
          icon: 'moon',
          category: petCategory,
          action: () => petControls.tuck(),
        },
      );
      if (petControls.resetPosition) {
        cmds.push({
          id: 'pet-reset-position',
          title: t('commandPalette.pets.resetPositionTitle'),
          icon: 'crosshair',
          category: petCategory,
          action: () => petControls.resetPosition?.(),
        });
      }
      cmds.push({
        id: 'pet-refresh-codex',
        title: t('commandPalette.pets.refreshCodexTitle'),
        icon: 'arrow-clockwise',
        category: petCategory,
        action: () => petControls.refreshCodexPets(),
      });
    }
    cmds.push({
      id: 'ui.pet.choose',
      title: t('commandPalette.pets.chooseTitle'),
      icon: 'palette',
      category: petCategory,
      action: async () => { await params.actions.execute('ui.pet.choose', {}, { surface: 'ui' }); },
    });
  }

  for (const { sessionId, serverId: rowServerId, title, subtitle } of selectCommandPaletteRecentSessions(sessionsById)) {
    cmds.push({
      id: `session-${sessionId}`,
      kind: 'recentSession',
      title,
      subtitle,
      icon: 'clock',
      category: t('commandPalette.commands.recentSessionsCategory'),
      // The recent row already names its Home; a bare id would re-resolve it and can
      // open a different Session with the same id on the active Home.
      action: () => nav.navigateToSession(sessionId, rowServerId ? { serverId: rowServerId } : undefined),
    });
  }

  const pluginActionPresentation = params.pluginActionPresentation;
  if (pluginActionPresentation) {
    for (const action of pluginActionPresentation.controller.list({
      placement: 'commandPalette',
      scope: pluginActionPresentation.scope,
    })) {
      // The plugin's own description; never its qualified id.
      const subtitle = typeof action.description === 'string' ? action.description.trim() : '';
      cmds.push({
        id: `plugin-action:${action.qualifiedActionId}`,
        actionSpecId: action.qualifiedActionId,
        title: action.title,
        shortcut: params.shortcutLabels?.[`action:${formatQualifiedPluginActionId(action.identity)}`],
        ...(subtitle ? { subtitle } : {}),
        icon: resolvePluginContributedActionIconName(action.icon),
        // Grouped under the plugin's display name; its id is never a heading.
        category: action.pluginTitle ?? t('commandPalette.commands.actionsCategory'),
        action: async () => {
          await openPluginContributedAction({
            controller: pluginActionPresentation.controller,
            action,
            ...(pluginActionPresentation.signal ? { signal: pluginActionPresentation.signal } : {}),
          });
        },
      });
    }
  }

  const state = storage.getState() as any;
  const commandPaletteActionSpecs = listUiActionSpecsForPlacement('command_palette').filter((spec) =>
    (features.voiceEnabled || !(ACTION_ID_FAMILIES_V1.voice_controls as readonly string[]).includes(spec.id))
    && (features.executionRunsEnabled || !isExecutionRunsFeatureAction(spec.id))
    && isActionEnabledInState(state, spec.id, { surface: 'ui', placement: 'command_palette' }),
  );
  const byId = new Map(commandPaletteActionSpecs.map((spec) => [spec.id, spec]));

  const notch = byId.get('desktop.notch.set');
  if (notch && desktopHostKind() === 'tauri') {
    cmds.push({
      id: `action:${notch.id}`, actionSpecId: notch.id,
      title: t('commandPalette.commands.openNotchTitle'), icon: 'square',
      category: t('commandPalette.commands.actionsCategory'),
      action: async () => { await actions.execute(notch.id, { state: 'pinned' }, { surface: 'ui' }); },
    });
  }

  if (features.executionRunsEnabled) {
    if (activeSessionId && activeSessionServerId) {
      for (const kind of ['session', 'workingTree'] as const) {
        const comparison = { kind };
        cmds.push({
          id: `walkthrough:${kind}`,
          title: `${t('turnChanges.card.walkThrough')} · ${resolveSessionScmReviewComparisonLabel(comparison)}`,
          icon: 'path',
          category: t('widgetGlances.changesTitle'),
          action: () => nav.push(buildSessionDetailsHref({
            sessionId: activeSessionId, serverId: activeSessionServerId,
            details: { kind: 'scmReview', comparison, view: 'walkthrough' },
          })),
        });
      }
    }
    const startReview = byId.get('review.start');
    const startPlan = byId.get('subagents.plan.start');
    const startDelegate = byId.get('subagents.delegate.start');
    for (const entry of [
      startReview ? { spec: startReview, title: t('commandPalette.commands.startReviewRunTitle'), intent: 'review' as const } : null,
      startPlan ? { spec: startPlan, title: t('commandPalette.commands.startPlanRunTitle'), intent: 'plan' as const } : null,
      startDelegate ? { spec: startDelegate, title: t('commandPalette.commands.startDelegationRunTitle'), intent: 'delegate' as const } : null,
    ]) {
      if (!entry) continue;
      cmds.push({
        id: `action:${entry.spec.id}`,
        actionSpecId: entry.spec.id,
        title: entry.title,
        icon: 'code',
        category: t('commandPalette.commands.runsCategory'),
        action: async () => {
          if (!activeSessionId && entry.spec.id === REVIEW_START_ACTION_ID_V1) {
            if (!actionDraftAccountScope) return;
            await nav.openExecutionRunDraft?.(detachedReviewStartSeed(actionDraftAccountScope));
            return;
          }
          const sessionId = await requireSession(activeSessionId, alert);
          if (!sessionId) return;
          const session = sessionsById?.[sessionId] ?? null;
          const defaultBackend = resolveSessionActionDefaultBackend({
            session,
            enabledAgentIds: getEnabledAgentIds({
              backendEnabledByTargetKey: storage.getState().settings?.backendEnabledByTargetKey,
            }),
          });

          const serverId = typeof session?.serverId === 'string' ? session.serverId.trim() : '';
          if (!actionDraftAccountScope || !serverId || actionDraftAccountScope.serverId !== serverId) return;
          await nav.openExecutionRunDraft?.({ scope: actionDraftAccountScope, sessionId,
            actionId: entry.spec.id as ActionId,
            input: buildExecutionRunActionDraftInputForUi({
              actionId: entry.spec.id as ActionId,
              sessionId,
              defaultBackendTarget: resolveSessionActionDefaultTarget(defaultBackend),
              defaultBackendId: defaultBackend?.defaultBackendId ?? null,
              instructions: '',
            }),
          });
        },
      });
    }

    const list = byId.get('execution.run.list');
    if (list) {
      cmds.push({
        id: `action:${list.id}`,
        actionSpecId: list.id,
        title: t('commandPalette.commands.openSessionRunsTitle'),
        subtitle: activeSessionId ? t('commandPalette.commands.runsForCurrentSessionSubtitle') : t('commandPalette.commands.runsAcrossMachinesSubtitle'),
        icon: 'list',
        category: t('commandPalette.commands.runsCategory'),
        action: async () => {
          if (activeSessionId) {
            const serverId = normalizeId(activeSessionServerId);
            if (!serverId) return;
            nav.push(buildScopedSessionRouteHref({
              sessionId: activeSessionId,
              serverId,
              suffix: '/runs',
            }));
            return;
          }
          nav.push('/runs');
        },
      });
    }
  }

  if (features.voiceEnabled) {
    // Resolve the actual attempt when invoked, not the Session displayed when the palette opened.
    const readVoice = async () => {
      const response = await actions.execute('ui.voice_global.get', {});
      if (!response || typeof response !== 'object' || !('result' in response)) return null;
      const parsed = VoiceConversationActionResultSchema.safeParse(response.result);
      return parsed.success ? parsed.data.voice : null;
    };
    const controls: ReadonlyArray<Readonly<{
      id: VoiceConversationActionId;
      title?: string;
      input?: (voice: VoiceConversationStatus) => Readonly<Record<string, unknown>>;
    }>> = [
      { id: 'ui.voice_global.get' },
      { id: 'ui.voice_global.start', title: t('voiceAssistant.startVoice') },
      { id: 'ui.voice_global.end', title: t('voiceAssistant.endVoice') },
      { id: 'ui.voice_global.set_muted', title: t('voiceSurface.a11y.mute'), input: () => ({ muted: true }) },
      { id: 'ui.voice_global.set_muted', title: t('voiceSurface.a11y.unmute'), input: () => ({ muted: false }) },
      { id: 'ui.voice_global.recover', title: t('voiceSurface.reconnect') },
      { id: 'ui.voice_global.dismiss', input: voice => ({ kind: voice.canDismissFailedAttempt ? 'failed' : 'ended' }) },
      { id: 'ui.voice_global.turn_control', title: t('common.send'), input: () => ({ control: 'commit_input' }) },
      { id: 'ui.voice_global.turn_control', title: t('voiceSurface.a11y.bargeIn'), input: () => ({ control: 'interrupt' }) },
      { id: 'ui.voice_global.turn_control', title: t('voiceSurface.a11y.cancelTurn'), input: () => ({ control: 'cancel' }) },
      { id: 'ui.voice_global.hold_begin' }, { id: 'ui.voice_global.hold_release' }, { id: 'ui.voice_global.hold_cancel' },
      { id: 'ui.voice_global.brief.request' }, { id: 'ui.voice_global.brief.retry' }, { id: 'ui.voice_global.brief.stop' },
    ];
    for (const [index, control] of controls.entries()) {
      const spec = byId.get(control.id);
      if (!spec) continue;
      cmds.push({
        id: `action:${control.id}:${index}`, actionSpecId: control.id,
        title: control.title ?? spec.title, icon: 'microphone', category: t('commandPalette.commands.voiceCategory'),
        action: async () => {
          if (control.id === 'ui.voice_global.start') {
            await actions.execute(control.id, { target: { kind: 'default' }, expectedAttempt: null });
            return;
          }
          const voice = await readVoice();
          if (!voice) return;
          if (control.id === 'ui.voice_global.get') {
            await alert(t('voiceAssistant.label'), t(resolveVoiceSurfaceStatusPresentation(resolveVoiceSurfaceState(voice)).labelKey));
          } else if (control.id.startsWith('ui.voice_global.brief.')) {
            await actions.execute(control.id, voice.attemptId ? { expectedAttemptId: voice.attemptId } : {});
          } else if (voice.attemptId) {
            await actions.execute(control.id, { expectedAttempt: voice.attemptId, ...control.input?.(voice) });
          }
        },
      });
    }
    // Parameterized model/artifact operations keep the same anchored selection UI.
    // Discovery is declaration-owned; opening that picker never reports operation completion.
    const pages = new Map(flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).map(page => [page.id, page]));
    const presentation = readSettingsPagePresentation();
    for (const page of presentation?.getSettingsPageDeclarations(undefined, { voice: voiceSettingsParse(state.settings?.voice) }) ?? []) {
      if (!page.pageId.startsWith('voice')) continue;
      for (const ref of Object.values(page.settings)) {
        if (ref.operation?.kind !== 'invoke' || !settingRendersOnHost(ref)) continue;
        const catalogPage = pages.get(page.pageId);
        const route = page.subpage?.route ?? catalogPage?.route;
        const href = route ? buildSettingHref(route, ref) : null;
        if (!href) continue;
        // Setting labels are local to their page. Search also needs the page and
        // speech direction to distinguish controls without losing their anchors.
        const operation = readBuiltInSettingDeclarationV1(ref.anchor)?.operation;
        const kind = operation?.owner === 'voiceSettingsOperation' ? operation.options?.[0] : undefined;
        const speechModels = kind?.startsWith('stt_') ? t('settingsVoice.local.models.sttGroupTitle')
          : kind?.startsWith('tts_') ? t('settingsVoice.local.models.ttsGroupTitle') : undefined;
        const controlTitle = ref.title ?? t(ref.titleKey);
        const operationTitle = kind === 'tts_preview'
          ? t('settingsVoice.realtimeProviders.catalog.preview', { voice: controlTitle })
          : controlTitle;
        const title = [operationTitle, catalogPage && t(catalogPage.titleKey), speechModels]
          .filter(Boolean).join(' · ');
        cmds.push({
          id: `setting-operation:${ref.anchor}`, title, icon: 'gear',
          category: t('commandPalette.commands.voiceCategory'), action: () => nav.push(href),
        });
      }
    }
    const reset = byId.get('ui.voice_global.reset');
    if (reset) {
      cmds.push({
        id: `action:${reset.id}`,
        actionSpecId: reset.id,
        title: t('commandPalette.commands.resetVoiceAgentTitle'),
        icon: 'arrow-clockwise',
        category: t('commandPalette.commands.voiceCategory'),
        action: async () => {
          await actions.execute('ui.voice_global.reset', {}, { defaultSessionId: activeSessionId });
        },
      });
    }
  }

  cmds.push({
    id: 'sign-out',
    title: t('commandPalette.commands.signOutTitle'),
    icon: 'sign-out',
    category: t('commandPalette.commands.systemCategory'),
    action: () => nav.push('/settings/account'),
  });

  if (isDev) {
    cmds.push({
      id: 'dev-menu',
      title: t('commandPalette.commands.developerMenuTitle'),
      icon: 'code',
      category: t('commandPalette.commands.developerCategory'),
      action: () => nav.push('/dev'),
    });
  }

  const session = activeSessionId ? sessionsById[activeSessionId] : null;
  const metadata = session ? readSessionOwnerMetadataView(session) : null;
  const context = {
    defaultSessionId: activeSessionId,
    defaultSessionMachineId: metadata?.machineId,
    defaultSessionRootPath: metadata?.path,
  };
  const contextCategory = session ? getSessionName(session) : undefined;
  const handled = new Set(cmds.map(command => command.actionSpecId).filter(Boolean));
  // The desktop opener decides Notch availability, including unsupported hosts.
  if (notch) handled.add(notch.id);
  for (const spec of commandPaletteActionSpecs) {
    if (handled.has(spec.id)) continue;
    const input = buildActionDraftInput({ actionId: spec.id, context });
    const parsed = spec.inputSchema.safeParse(input);
    const sessionScoped = spec.contextualDefaults?.sessionId === 'current_session'
      || spec.inputHints?.fields.some(field => field.path === 'sessionId');
    cmds.push({
      id: `action:${spec.id}`, actionSpecId: spec.id,
      // A spec's description is written for agents; the person reads and searches the title.
      title: spec.title,
      icon: 'lightning', category: t('commandPalette.commands.actionsCategory'),
      ...(sessionScoped && contextCategory ? { contextCategory } : {}),
      ...(parsed.success ? { invokeAction: caller => caller.executeOrdinaryChildAction!(spec.id, parsed.data) } : {}),
      action: () => openCatalogAction({ spec, context,
        pickerContext: { sessionId: activeSessionId, machineId: metadata?.machineId, serverId: activeSessionServerId },
        execute: async input => await actions.execute(spec.id, input, { defaultSessionId: activeSessionId, surface: 'ui' }) as ActionExecuteResult,
      }),
    });
  }
  const shortcutActions = new Set<string>();
  for (const command of cmds) {
    if (!command.actionSpecId) continue;
    const spec = byId.get(command.actionSpecId as ActionId);
    if (contextCategory && (spec?.contextualDefaults?.sessionId === 'current_session'
      || spec?.inputHints?.fields.some(field => field.path === 'sessionId'))) command.contextCategory = contextCategory;
    // Derived dispatch chooses the first bespoke variant when an Action has several controls.
    if (!shortcutActions.has(command.actionSpecId)) {
      command.shortcut = params.shortcutLabels?.[`action:${command.actionSpecId}` as KeyboardCommandId] ?? command.shortcut;
      shortcutActions.add(command.actionSpecId);
    }
  }
  if (contextCategory) cmds.push(...(params.sessionCommands ?? []).map(command => ({ ...command, contextCategory })));
  return cmds;
}
