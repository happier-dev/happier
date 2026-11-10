import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { t } from '@/text';

/** The Session surfaces that draw their own header (the Session view and its cockpit surfaces). */
const SESSION_SURFACES_WITH_OWN_HEADER = new Set(['index', 'files', 'git', 'details', 'terminal']);

const SESSION_SURFACE_OPTIONS = {
    animation: 'none',
    headerShown: false,
} as const satisfies NativeStackNavigationOptions;

/** Page identities belong here before their body hydrates, for Expo and retained routes alike. */
export function createSessionPageScreenOptions(): Readonly<Record<string, NativeStackNavigationOptions>> {
    const titles = {
        info: t('sessionInfo.title'),
        log: t('sessionLog.title'),
        usage: t('usage.sessionUsage'),
        template: t('botTemplates.title'),
        file: t('common.fileViewer'),
        commit: t('common.commit'),
        'message/[messageId]': t('common.message'),
        sharing: t('session.collaboration.title'),
        runs: t('session.subagents.panel.title'),
        triggers: t('sessionInfo.title'),
        automations: t('sessionInfo.title'),
        'automations/new': t('sessionInfo.title'),
        'automations/when-turn-finishes': t('sessionInfo.title'),
    };
    const options: Record<string, NativeStackNavigationOptions> = Object.fromEntries(
        Object.entries(titles).map(([name, headerTitle]) => [name, { headerShown: true, headerTitle }]));
    // Session Info opens with its own identity block, which names the Session: the bar stays empty (an empty
    // string, so native-stack never falls back to the route name) and the screen keeps its name for assistive
    // tech and the window title.
    options.info = { headerShown: true, headerTitle: '', title: titles.info };
    return options;
}

/**
 * Options for the root stack's `session/[id]` screen. Its `_layout` is a Slot, so the stack sees
 * one screen for every Session route and the nested route decides. Before the nested route has
 * resolved, the Slot's first child is the Session view itself (`index`).
 */
export function buildSessionRouteScreenOptions(input: Readonly<{
    childRouteName: string | undefined;
}>): NativeStackNavigationOptions {
    const child = input.childRouteName ?? 'index';
    return SESSION_SURFACES_WITH_OWN_HEADER.has(child) ? SESSION_SURFACE_OPTIONS : createSessionPageScreenOptions()[child] ?? {};
}
