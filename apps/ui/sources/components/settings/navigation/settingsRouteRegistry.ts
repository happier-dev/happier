import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { TranslationKeyNoParams } from '@/text';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { DefaultBackButton } from '@/components/navigation/Header';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { LEGACY_PROMPT_STACKS_ROUTE, PROMPTS_CONTEXT_ROUTE } from '@/components/settings/prompts/context/promptsContextNavigation';
import { MACHINE_RETENTION_CATEGORIES_V1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';

type Translate = (key: TranslationKeyNoParams) => string;

/** A result opened from the retained Settings-page search returns to that page on Back. */
export const SETTINGS_SEARCH_RETURN_QUERY_PARAM = 'settingsSearch';

export type SettingsStackScreenDefinition = Readonly<{
    name: string;
    options: NativeStackNavigationOptions;
}>;

import { listSettingsRouteNames, SETTINGS_ROUTE_CHROME_DEFINITIONS, type SettingsNestedNavigator } from './settingsRouteDefinitions';
import { matchSettingsRouteSegments as matchRouteSegments } from './settingsRouteMatching';
export { resolveSettingsNestedRouteName } from './settingsRouteMatching';
export { listSettingsRouteNames, type SettingsNestedNavigator } from './settingsRouteDefinitions';

function routeStaticSegmentCount(pattern: readonly string[]): number {
    return pattern.filter((part) => !(part.startsWith('[') && part.endsWith(']'))).length;
}

/**
 * The title key of the settings route at `pathname`, from the same registry that titles the native
 * header, so an in-content page header and the navigation bar can never disagree. A fully static route
 * wins over a sibling with a dynamic segment (`prompts/docs/new` over `prompts/docs/[id]`); screens of
 * a nested navigator (Providers, Agents) resolve under `/settings/<navigator>`.
 */
export function resolveSettingsRouteTitleKey(pathname: string | null | undefined): TranslationKeyNoParams | null {
    if (typeof pathname !== 'string') return null;
    const normalized = pathname.trim().replace(/\/+$/, '') || '/';
    if (normalized !== '/settings' && !normalized.startsWith('/settings/')) return null;
    const segments = normalized === '/settings' ? [] : normalized.slice('/settings/'.length).split('/');
    let dynamicMatch: Readonly<{ titleKey: TranslationKeyNoParams; staticSegments: number }> | null = null;
    for (const definition of SETTINGS_ROUTE_CHROME_DEFINITIONS) {
        if (!definition.titleKey) continue;
        const nameSegments = (definition.navigator ? `${definition.navigator}/${definition.name}` : definition.name).split('/');
        const candidates = nameSegments[nameSegments.length - 1] === 'index'
            ? [nameSegments.slice(0, -1)]
            : [nameSegments];
        for (const candidate of candidates) {
            const match = matchRouteSegments(candidate, segments);
            if (match === 'static') return definition.titleKey;
            if (match === 'dynamic') {
                const staticSegments = routeStaticSegmentCount(candidate);
                if (dynamicMatch === null || staticSegments > dynamicMatch.staticSegments) {
                    dynamicMatch = { titleKey: definition.titleKey, staticSegments };
                }
            }
        }
    }
    return dynamicMatch?.titleKey ?? null;
}

/**
 * The URL patterns of every mounted settings route (`index` is its directory), from the registry the
 * stacks register their screens from. The registry test keeps it equal to `app/(app)/settings/**`.
 */
const MOUNTED_SETTINGS_ROUTE_PATTERNS: readonly (readonly string[])[] = listSettingsRouteNames().map((name) => {
    const segments = name.split('/');
    return segments[segments.length - 1] === 'index' ? segments.slice(0, -1) : segments;
});

/**
 * Whether a registered route names `segment` literally after `prefix` (`pools` under `machines`). The
 * router gives such a segment to its static directory, never to a dynamic sibling (`machines/[id]`).
 */
function isStaticSettingsSegment(prefix: readonly string[], segment: string): boolean {
    return MOUNTED_SETTINGS_ROUTE_PATTERNS.some((pattern) => pattern.length > prefix.length
        && pattern[prefix.length] === segment
        && matchRouteSegments(pattern.slice(0, prefix.length), prefix) !== null);
}

function isMountedSettingsRoute(segments: readonly string[]): boolean {
    return MOUNTED_SETTINGS_ROUTE_PATTERNS.some((pattern) => {
        if (pattern.length !== segments.length) return false;
        return pattern.every((part, index) => (part.startsWith('[') && part.endsWith(']')
            ? !isStaticSettingsSegment(segments.slice(0, index), segments[index]!)
            : part === segments[index]));
    });
}

/**
 * Where a settings screen's back affordance leads: the nearest ancestor path that is a mounted
 * route. Organizational segments with no screen of their own (a Team's Home segment, `pools`,
 * `github-apps`, a skill's `files`) are skipped, so back never lands on "Unmatched Route".
 */
export function resolveSettingsRouteParentPathname(
    pathname: string | null | undefined,
    params?: Readonly<{ category?: string | string[]; source?: string | string[] }>,
): string | null {
    if (typeof pathname !== 'string') return null;
    const normalizedPathname = pathname.trim().replace(/\/+$/, '') || '/';
    if (normalizedPathname === '/settings') return null;
    if (!normalizedPathname.startsWith('/settings/')) return null;

    // Phone Defaults categories are pushed as query-state pages. Leaving one removes the
    // category first; leaving Defaults itself still returns to the Machines collection.
    const category = Array.isArray(params?.category) ? params.category[0] : params?.category;
    if (normalizedPathname === '/settings/machines/defaults'
        && (MACHINE_RETENTION_CATEGORIES_V1 as readonly string[]).includes(category ?? '')) {
        return normalizedPathname;
    }

    // A phone pushes an open plugin source as the Sources page's query state: Back closes it to the list first.
    if (normalizedPathname === '/settings/plugins/sources' && params?.source !== undefined) return normalizedPathname;

    // Custom ACP agents live in the Agents collection; `custom` alone is the new-agent draft, not
    // the parent of a saved agent, although it is a mounted route.
    if (/^\/settings\/agents\/custom(?:\/[^/]+)?$/.test(normalizedPathname)) return '/settings/agents';

    const segments = normalizedPathname.slice('/settings/'.length).split('/');
    for (let length = segments.length - 1; length > 0; length -= 1) {
        const ancestor = segments.slice(0, length);
        const parentPathname = `/settings/${ancestor.join('/')}`;
        // Stacks is a redirect to Context, not a parent page. Context itself returns to
        // Prompts & Skills; its Voice/Profile children return to the retained Context page.
        if (parentPathname === LEGACY_PROMPT_STACKS_ROUTE) {
            if (normalizedPathname === PROMPTS_CONTEXT_ROUTE) continue;
            return PROMPTS_CONTEXT_ROUTE;
        }
        if (isMountedSettingsRoute(ancestor)) return parentPathname;
    }
    return '/settings';
}

/**
 * Whether the within-settings "back" arrow should be shown for the current route.
 *
 * - The settings index has no parent → never shows.
 * - In modal presentation (`hideOnTopLevel`), top-level categories (parent === '/settings')
 *   are reachable from the nav rail, so the redundant back arrow is hidden; only deeper
 *   sub-screens keep it.
 * - In full-screen (phone) presentation, every non-index screen keeps the back arrow.
 */
export function shouldShowSettingsParentBackButton(params: Readonly<{
    pathname: string | null | undefined;
    hideOnTopLevel: boolean;
}>): boolean {
    const parentPathname = resolveSettingsRouteParentPathname(params.pathname);
    if (!parentPathname) return false;
    if (params.hideOnTopLevel && parentPathname === '/settings') return false;
    return true;
}

/**
 * The settings back affordance's destination and action, shared by the phone header and the modal's
 * in-page control. Back returns to the parent screen that is already in the stack (with its state:
 * a search query, a scroll position); only when it is not there (a deep link) does the parent
 * replace the current screen. `navigate` would stack a second copy of the parent instead.
 */
export function useSettingsParentBack(tag: string): Readonly<{ parentPathname: string | null; goToParent: () => void }> {
    const pathname = usePathname();
    const router = useRouter();
    const params = useLocalSearchParams<{ settingsSearch?: string | string[]; category?: string | string[]; source?: string | string[] }>();
    const searchOrigin = params[SETTINGS_SEARCH_RETURN_QUERY_PARAM];
    const parentPathname = searchOrigin === '1' ? '/settings' : resolveSettingsRouteParentPathname(pathname, params);
    const goToParent = React.useCallback(() => {
        if (!parentPathname) return;
        const result = runGuardedNavigation(() => router.dismissTo(parentPathname as never));
        if (result !== true) {
            fireAndForget(result, { tag });
        }
    }, [parentPathname, router, tag]);
    return { parentPathname, goToParent };
}

function SettingsParentBackButton({
    accessibilityLabel,
    tintColor,
    hideOnTopLevel,
    parentLabel,
}: Readonly<{
    accessibilityLabel: string;
    tintColor?: string;
    hideOnTopLevel: boolean;
    /** Names the parent screen beside the arrow, for a page whose own large title is the only title. */
    parentLabel?: Translate;
}>): React.ReactElement | null {
    const pathname = usePathname();
    const { parentPathname, goToParent } = useSettingsParentBack('SettingsParentBackButton.back');

    if (!shouldShowSettingsParentBackButton({ pathname, hideOnTopLevel })) {
        return null;
    }

    const parentTitleKey = parentLabel ? resolveSettingsRouteTitleKey(parentPathname) : null;
    // Android and the web draw the app's own bar, with its one Back. iPhone's native bar keeps the system chevron.
    if (Platform.OS !== 'ios') {
        return React.createElement(DefaultBackButton, {
            accessibilityLabel,
            ...(tintColor ? { tintColor } : {}),
            onPress: goToParent,
            ...(parentLabel && parentTitleKey ? { label: parentLabel(parentTitleKey) } : {}),
        });
    }
    return React.createElement(Pressable, {
        accessibilityLabel,
        accessibilityRole: 'button',
        hitSlop: 8,
        onPress: goToParent,
        style: {
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            marginLeft: -8,
            paddingHorizontal: 8,
            paddingVertical: 6,
        },
    }, React.createElement(Ionicons, {
        color: tintColor,
        name: 'chevron-back',
        size: 28,
    }), parentLabel && parentTitleKey ? React.createElement(Text, {
        numberOfLines: 1,
        style: [Typography.default(), { color: tintColor, fontSize: 16, marginLeft: 4, flexShrink: 1 }],
    }, parentLabel(parentTitleKey)) : null);
}

export function getSettingsStackScreenDefinitions(
    t: Translate,
    config?: Readonly<{ isModalPresentation?: boolean; navigator?: SettingsNestedNavigator }>,
): readonly SettingsStackScreenDefinition[] {
    const isModalPresentation = config?.isModalPresentation ?? false;
    return SETTINGS_ROUTE_CHROME_DEFINITIONS.filter((definition) => definition.navigator === config?.navigator).map((definition) => {
        const options: NativeStackNavigationOptions = {
            headerBackTitle: t(definition.headerBackTitleKey ?? 'common.back'),
            headerShown: definition.headerShown ?? true,
        };
        if (isModalPresentation) {
            // In modal mode the navigator header is removed entirely; the close and (sub-screen)
            // back affordances are rendered as floating controls by SettingsShell instead.
            options.headerShown = false;
            return { name: definition.name, options };
        }
        if (definition.titleKey) {
            options.headerTitle = definition.headsItself ? '' : t(definition.titleKey);
        }
        if ((definition.name !== 'index' || definition.navigator) && options.headerShown !== false) {
            const accessibilityLabel = t('common.back');
            options.headerLeft = ({ tintColor }) => React.createElement(SettingsParentBackButton, {
                accessibilityLabel,
                tintColor,
                hideOnTopLevel: false,
                // A page that heads itself leaves the bar untitled, so its back names the parent.
                ...(definition.headsItself ? { parentLabel: t } : {}),
            });
        }
        return {
            name: definition.name,
            options,
        };
    });
}
