import type { ActionId } from '@happier-dev/protocol';
import { listActionSpecs } from '@happier-dev/protocol';

import type { Command } from './types';
import { storage } from '@/sync/domains/state/storage';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';

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
  const title = name || `Session ${String(session?.id ?? '').slice(0, 6)}`;
  const path = typeof session?.metadata?.path === 'string' ? session.metadata.path.trim() : '';
  const subtitle = path || 'Switch to session';
  return { title, subtitle };
}

async function requireSession(
  activeSessionId: string | null,
  alert: (title: string, message: string) => void | Promise<void>,
): Promise<string | null> {
  if (activeSessionId) return activeSessionId;
  await alert('Session required', 'Open a session first so this command can target it.');
  return null;
}

export function buildCommandPaletteCommands(params: Readonly<{
  sessionsById: Record<string, any>;
  isDev: boolean;
  activeSessionId: string | null;
  features: Readonly<{ executionRunsEnabled: boolean; voiceEnabled: boolean }>;
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
      title: 'New Session',
      subtitle: 'Start a new chat session',
      icon: 'add-circle-outline',
      category: 'Sessions',
      shortcut: '⌘N',
      action: () => nav.push('/new'),
    },
    {
      id: 'sessions',
      title: 'View All Sessions',
      subtitle: 'Browse your chat history',
      icon: 'chatbubbles-outline',
      category: 'Sessions',
      action: () => nav.push('/'),
    },
    {
      id: 'settings',
      title: 'Settings',
      subtitle: 'Configure your preferences',
      icon: 'settings-outline',
      category: 'Navigation',
      shortcut: '⌘,',
      action: () => nav.push('/settings'),
    },
    {
      id: 'account',
      title: 'Account',
      subtitle: 'Manage your account',
      icon: 'person-circle-outline',
      category: 'Navigation',
      action: () => nav.push('/settings/account'),
    },
    {
      id: 'connect',
      title: 'Connect Device',
      subtitle: 'Connect a new device via web',
      icon: 'link-outline',
      category: 'Navigation',
      action: () => nav.push('/terminal/connect'),
    },
  ];

  for (const sessionId of extractRecentSessionIds(sessionsById)) {
    const session = sessionsById[sessionId];
    const label = readSessionLabel(session);
    cmds.push({
      id: `session-${sessionId}`,
      title: label.title,
      subtitle: label.subtitle,
      icon: 'time-outline',
      category: 'Recent Sessions',
      action: () => nav.navigateToSession(sessionId),
    });
  }

  const actionSpecs = listActionSpecs().filter((spec) => isActionEnabledInState(storage.getState() as any, spec.id));
  const commandPaletteActionSpecs = actionSpecs.filter((spec) => (spec.placements ?? []).includes('command_palette'));
  const byId = new Map(commandPaletteActionSpecs.map((spec) => [spec.id, spec]));

  if (features.executionRunsEnabled) {
    const startReview = byId.get('review.start');
    const startPlan = byId.get('plan.start');
    const startDelegate = byId.get('delegate.start');
    for (const entry of [
      startReview ? { spec: startReview, title: 'Start review run', intent: 'review' as const } : null,
      startPlan ? { spec: startPlan, title: 'Start plan run', intent: 'plan' as const } : null,
      startDelegate ? { spec: startDelegate, title: 'Start delegation run', intent: 'delegate' as const } : null,
    ]) {
      if (!entry) continue;
      cmds.push({
        id: `action:${entry.spec.id}`,
        title: entry.title,
        subtitle: 'Execution runs',
        icon: 'code-slash-outline',
        category: 'Runs',
        action: async () => {
          const sessionId = await requireSession(activeSessionId, alert);
          if (!sessionId) return;
          const session = sessionsById?.[sessionId] ?? null;
          const agentId = normalizeId((session as any)?.metadata?.agent) || 'claude';
          if (entry.intent === 'review') {
            storage.getState().createSessionActionDraft(sessionId, {
              actionId: 'review.start',
              input: {
                sessionId,
                engineIds: [agentId],
                instructions: '',
                changeType: 'committed',
                base: { kind: 'none' },
              },
            });
          } else if (entry.intent === 'plan') {
            storage.getState().createSessionActionDraft(sessionId, {
              actionId: 'plan.start',
              input: { sessionId, backendIds: [agentId], instructions: '' },
            });
          } else {
            storage.getState().createSessionActionDraft(sessionId, {
              actionId: 'delegate.start',
              input: { sessionId, backendIds: [agentId], instructions: '' },
            });
          }
          nav.navigateToSession(sessionId);
        },
      });
    }

    const list = byId.get('execution.run.list');
    if (list) {
      cmds.push({
        id: `action:${list.id}`,
        title: 'Open session runs',
        subtitle: activeSessionId ? 'Runs for current session' : 'Runs across machines',
        icon: 'list-outline',
        category: 'Runs',
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
        title: 'Reset voice agent',
        subtitle: 'Voice',
        icon: 'refresh-outline',
        category: 'Voice',
        action: async () => {
          await actions.execute('ui.voice_global.reset', {}, { defaultSessionId: activeSessionId });
        },
      });
    }
  }

  cmds.push({
    id: 'sign-out',
    title: 'Sign Out',
    subtitle: 'Sign out of your account',
    icon: 'log-out-outline',
    category: 'System',
    action: async () => {
      await auth.logout();
    },
  });

  if (isDev) {
    cmds.push({
      id: 'dev-menu',
      title: 'Developer Menu',
      subtitle: 'Access developer tools',
      icon: 'code-slash-outline',
      category: 'Developer',
      action: () => nav.push('/dev'),
    });
  }

  return cmds;
}
