import type { ActionId } from '@happier-dev/protocol';
import { listActionSpecs } from '@happier-dev/protocol';

import type { Command } from './types';
import type { KeyboardCommandId } from '@/keyboard';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { storage } from '@/sync/domains/state/storage';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { t } from '@/text';

function normalizeId(value: unknown): string {
  return String(value ?? '').trim();
}

function extractRecentSessionIds(sessionsById: Record<string, any>): string[] {
  const sessions = Object.values(sessionsById ?? {});
  sessions.sort((a: any, b: any) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0));
  return sessions
    .map((s: any) => normalizeId(s?.id))
    .filter(Boolean)
    .slice(0, 5);
}

function readSessionLabel(session: any): Readonly<{ title: string; subtitle: string }> {
  const name = typeof session?.metadata?.name === 'string' ? session.metadata.name.trim() : '';
  const title = name || t('commandPalette.commands.sessionFallbackTitle', { id: String(session?.id ?? '').slice(0, 6) });
  const path = typeof session?.metadata?.path === 'string' ? session.metadata.path.trim() : '';
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

export function buildCommandPaletteCommands(params: Readonly<{
  sessionsById: Record<string, any>;
  isDev: boolean;
  activeSessionId: string | null;
  features: Readonly<{
    executionRunsEnabled: boolean;
    voiceEnabled: boolean;
    memorySearchEnabled: boolean;
    petsCompanionEnabled?: boolean;
  }>;
  shortcutLabels?: Partial<Record<KeyboardCommandId, string>>;
  petControls?: PetCommandControls;
  nav: Readonly<{
    push: (path: string) => void;
    navigateToSession: (sessionId: string) => void;
  }>;
  auth: Readonly<{ logout: () => Promise<void> }>;
  actions: Readonly<{
    execute: (actionId: ActionId, parameters: unknown, ctx?: { defaultSessionId?: string | null }) => Promise<unknown>;
  }>;
  alert: (title: string, message: string) => void | Promise<void>;
}>): Command[] {
  const {
    sessionsById,
    isDev,
    activeSessionId,
    features,
    nav,
    auth,
    actions,
    alert,
  } = params;

  const cmds: Command[] = [
    {
      id: 'new-session',
      title: t('commandPalette.commands.newSessionTitle'),
      subtitle: t('commandPalette.commands.newSessionSubtitle'),
      icon: 'add-circle-outline',
      category: t('commandPalette.commands.sessionsCategory'),
      shortcut: params.shortcutLabels?.['session.new'],
      action: () => nav.push('/new'),
    },
    {
      id: 'sessions',
      title: t('commandPalette.commands.viewAllSessionsTitle'),
      subtitle: t('commandPalette.commands.viewAllSessionsSubtitle'),
      icon: 'chatbubbles-outline',
      category: t('commandPalette.commands.sessionsCategory'),
      action: () => nav.push('/'),
    },
    {
      id: 'settings',
      title: t('commandPalette.commands.settingsTitle'),
      subtitle: t('commandPalette.commands.settingsSubtitle'),
      icon: 'settings-outline',
      category: t('commandPalette.commands.navigationCategory'),
      shortcut: params.shortcutLabels?.['settings.open'],
      action: () => nav.push('/settings'),
    },
    {
      id: 'account',
      title: t('commandPalette.commands.accountTitle'),
      subtitle: t('commandPalette.commands.accountSubtitle'),
      icon: 'person-circle-outline',
      category: t('commandPalette.commands.navigationCategory'),
      action: () => nav.push('/settings/account'),
    },
    {
      id: 'connect',
      title: t('commandPalette.commands.connectTerminalTitle'),
      subtitle: t('commandPalette.commands.connectTerminalSubtitle'),
      icon: 'link-outline',
      category: t('commandPalette.commands.navigationCategory'),
      action: () => nav.push('/scan/terminal'),
    },
  ];

  if (features.memorySearchEnabled) {
    cmds.push({
      id: 'memory-search',
      title: t('commandPalette.commands.memorySearchTitle'),
      subtitle: t('commandPalette.commands.memorySearchSubtitle'),
      icon: 'search-outline',
      category: t('commandPalette.commands.navigationCategory'),
      action: () => nav.push('/search'),
    });
  }

  if (features.petsCompanionEnabled === true) {
    const petCategory = t('commandPalette.pets.category');
    const petControls = params.petControls;
    if (petControls && petControls.surface !== 'none') {
      cmds.push(
        {
          id: 'pet-wake',
          title: t('commandPalette.pets.wakeTitle'),
          subtitle: t('commandPalette.pets.wakeSubtitle'),
          icon: 'paw-outline',
          category: petCategory,
          action: () => petControls.wake(),
        },
        {
          id: 'pet-tuck',
          title: t('commandPalette.pets.tuckTitle'),
          subtitle: t('commandPalette.pets.tuckSubtitle'),
          icon: 'moon-outline',
          category: petCategory,
          action: () => petControls.tuck(),
        },
      );
      if (petControls.resetPosition) {
        cmds.push({
          id: 'pet-reset-position',
          title: t('commandPalette.pets.resetPositionTitle'),
          subtitle: t('commandPalette.pets.resetPositionSubtitle'),
          icon: 'locate-outline',
          category: petCategory,
          action: () => petControls.resetPosition?.(),
        });
      }
      cmds.push({
        id: 'pet-refresh-codex',
        title: t('commandPalette.pets.refreshCodexTitle'),
        subtitle: t('commandPalette.pets.refreshCodexSubtitle'),
        icon: 'refresh-outline',
        category: petCategory,
        action: () => petControls.refreshCodexPets(),
      });
    }
    cmds.push({
      id: 'ui.pet.choose',
      title: t('commandPalette.pets.chooseTitle'),
      subtitle: t('commandPalette.pets.chooseSubtitle'),
      icon: 'color-palette-outline',
      category: petCategory,
      action: () => nav.push('/settings/pets'),
    });
  }

  for (const sessionId of extractRecentSessionIds(sessionsById)) {
    const session = sessionsById[sessionId];
    const label = readSessionLabel(session);
    cmds.push({
      id: `session-${sessionId}`,
      title: label.title,
      subtitle: label.subtitle,
      icon: 'time-outline',
      category: t('commandPalette.commands.recentSessionsCategory'),
      action: () => nav.navigateToSession(sessionId),
    });
  }

  const state = storage.getState() as any;
  const actionSpecs = listActionSpecs().filter((spec) =>
    isActionEnabledInState(state as any, spec.id, { surface: 'ui_button', placement: 'command_palette' } as any),
  );
  const commandPaletteActionSpecs = actionSpecs.filter((spec) => (spec.placements ?? []).includes('command_palette'));
  const byId = new Map(commandPaletteActionSpecs.map((spec) => [spec.id, spec]));

  if (features.executionRunsEnabled) {
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
        title: entry.title,
        subtitle: t('commandPalette.commands.executionRunsSubtitle'),
        icon: 'code-slash-outline',
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

          storage.getState().createSessionActionDraft(sessionId, {
            actionId: entry.spec.id as any,
            input: buildExecutionRunActionDraftInputForUi({
              actionId: entry.spec.id as any,
              sessionId,
              defaultBackendTarget: defaultBackend?.backendTarget ?? null,
              defaultBackendId: defaultBackend?.defaultBackendId ?? null,
              instructions: '',
            }),
          });
          nav.navigateToSession(sessionId);
        },
      });
    }

    const list = byId.get('execution.run.list');
    if (list) {
      cmds.push({
        id: `action:${list.id}`,
        title: t('commandPalette.commands.openSessionRunsTitle'),
        subtitle: activeSessionId ? t('commandPalette.commands.runsForCurrentSessionSubtitle') : t('commandPalette.commands.runsAcrossMachinesSubtitle'),
        icon: 'list-outline',
        category: t('commandPalette.commands.runsCategory'),
        action: async () => {
          if (activeSessionId) {
            nav.push(`/session/${encodeURIComponent(activeSessionId)}/runs`);
            return;
          }
          nav.push('/runs');
        },
      });
    }
  }

  if (features.voiceEnabled) {
    const reset = byId.get('ui.voice_global.reset');
    if (reset) {
      cmds.push({
        id: `action:${reset.id}`,
        title: t('commandPalette.commands.resetVoiceAgentTitle'),
        subtitle: t('commandPalette.commands.voiceSubtitle'),
        icon: 'refresh-outline',
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
    subtitle: t('commandPalette.commands.signOutSubtitle'),
    icon: 'log-out-outline',
    category: t('commandPalette.commands.systemCategory'),
    action: async () => {
      await auth.logout();
    },
  });

  if (isDev) {
    cmds.push({
      id: 'dev-menu',
      title: t('commandPalette.commands.developerMenuTitle'),
      subtitle: t('commandPalette.commands.developerMenuSubtitle'),
      icon: 'code-slash-outline',
      category: t('commandPalette.commands.developerCategory'),
      action: () => nav.push('/dev'),
    });
  }

  return cmds;
}
