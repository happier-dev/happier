import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { ActionId } from '@happier-dev/protocol';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { VoiceConversationActionResultSchema, type VoiceConversationActionId, type VoiceConversationStatus } from '@happier-dev/protocol/actions/voiceConversationActionFamily';

import type { Command } from './types';
import type { KeyboardCommandId } from '@/keyboard';
import {
  isCompactAppDestinationVisible,
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
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
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
import { getSettingsPageDeclarations } from '@/components/settings/catalog/settingsPageDeclarations';
import { buildSettingHref, settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';

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

function readSessionLabel(session: any): Readonly<{ title: string; subtitle: string }> {
  const metadata = readSessionOwnerMetadataView(session);
  const legacyName = typeof metadata?.name === 'string' ? metadata.name.trim() : '';
  const title = readSessionDisplayTitleField(session).value
    ?? (legacyName || t('commandPalette.commands.sessionFallbackTitle', { id: String(session?.id ?? '').slice(0, 6) }));
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
  petControls?: PetCommandControls;
  nav: Readonly<{
    push: (path: string) => void;
    openNewSession: () => void;
    openNewWorkflow?: () => void;
    openWorkflowAgentAuthoring?: () => void;
    /** Reopens the canonical Search surface in its content source, retaining exact invocation scope. */
    openTextInFiles?: () => void;
    /** Opens the shared device-pairing panel while retaining the current page. */
    openHomePairingModal?: () => void | Promise<void>;
    /** Matches `useNavigateToSession`: the Home is passed when the producer holds it. */
    navigateToSession: (sessionId: string, opts?: Readonly<{ serverId?: string }>) => void;
  }>;
  actions: Readonly<{
    execute: (actionId: ActionId, parameters: unknown, ctx?: { defaultSessionId?: string | null }) => Promise<unknown>;
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
      if (!isCompactAppDestinationVisible(destination)) {
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
      action: () => nav.push('/settings/pets'),
    });
  }

  for (const sessionId of extractRecentSessionIds(sessionsById)) {
    const session = sessionsById[sessionId];
    const rowServerId = typeof session?.serverId === 'string' ? session.serverId.trim() : '';
    const label = readSessionLabel(session);
    cmds.push({
      id: `session-${sessionId}`,
      kind: 'recentSession',
      title: label.title,
      subtitle: label.subtitle,
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
        ...(subtitle ? { subtitle } : {}),
        icon: resolvePluginContributedActionIconName(action.icon),
        category: action.identity.pluginId,
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
  const actionSpecs = listActionSpecs().filter((spec) =>
    isActionEnabledInState(state as any, spec.id, { surface: 'ui_button', placement: 'command_palette' } as any),
  );
  const commandPaletteActionSpecs = actionSpecs.filter((spec) => (spec.placements ?? []).includes('command_palette'));
  const byId = new Map(commandPaletteActionSpecs.map((spec) => [spec.id, spec]));

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
          storage.getState().createSessionActionDraft(actionDraftAccountScope, { serverId, sessionId }, {
            actionId: entry.spec.id as any,
            input: buildExecutionRunActionDraftInputForUi({
              actionId: entry.spec.id as any,
              sessionId,
              defaultBackendTarget: resolveSessionActionDefaultTarget(defaultBackend),
              defaultBackendId: defaultBackend?.defaultBackendId ?? null,
              instructions: '',
            }),
          });
          nav.navigateToSession(sessionId, { serverId });
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
    const routes = new Map(flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).map(page => [page.id, page.route]));
    for (const page of getSettingsPageDeclarations(undefined, { voice: voiceSettingsParse(state.settings?.voice) })) {
      if (!page.pageId.startsWith('voice')) continue;
      for (const ref of Object.values(page.settings)) {
        if (ref.operation?.kind !== 'invoke' || !settingRendersOnHost(ref)) continue;
        const route = page.subpage?.route ?? routes.get(page.pageId);
        const href = route ? buildSettingHref(route, ref) : null;
        if (!href) continue;
        cmds.push({
          id: `setting-operation:${ref.anchor}`, title: ref.title ?? t(ref.titleKey), icon: 'gear',
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

  return cmds;
}
