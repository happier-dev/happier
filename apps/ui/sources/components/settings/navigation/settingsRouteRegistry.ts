import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { TranslationKeyNoParams } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

type Translate = (key: TranslationKeyNoParams) => string;

/** A result opened from the retained Settings-page search returns to that page on Back. */
export const SETTINGS_SEARCH_RETURN_QUERY_PARAM = 'settingsSearch';

export type SettingsStackScreenDefinition = Readonly<{
    name: string;
    options: NativeStackNavigationOptions;
}>;

import { listSettingsRouteNames, SETTINGS_ROUTE_CHROME_DEFINITIONS, type SettingsNestedNavigator } from './settingsRouteDefinitions';
export { listSettingsRouteNames, type SettingsNestedNavigator } from './settingsRouteDefinitions';

function matchRouteSegments(pattern: readonly string[], segments: readonly string[]): 'static' | 'dynamic' | null {
    if (pattern.length !== segments.length) return null;
    let dynamic = false;
    for (let i = 0; i < pattern.length; i += 1) {
        const part = pattern[i]!;
        if (part.startsWith('[') && part.endsWith(']')) {
            dynamic = true;
            continue;
        }
        if (part !== segments[i]) return null;
    }
    return dynamic ? 'dynamic' : 'static';
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
    let dynamicMatch: TranslationKeyNoParams | null = null;
    for (const definition of SETTINGS_ROUTE_CHROME_DEFINITIONS) {
        if (!definition.titleKey) continue;
        const nameSegments = (definition.navigator ? `${definition.navigator}/${definition.name}` : definition.name).split('/');
        const candidates = nameSegments[nameSegments.length - 1] === 'index'
            ? [nameSegments.slice(0, -1)]
            : [nameSegments];
        for (const candidate of candidates) {
            const match = matchRouteSegments(candidate, segments);
            if (match === 'static') return definition.titleKey;
            if (match === 'dynamic' && dynamicMatch === null) dynamicMatch = definition.titleKey;
        }
    }
    return dynamicMatch;
}

/**
 * The nested-navigator screen that renders `pathname` inside a collection (`/settings/<navigator>/…`),
 * from the same registry the navigator registers its screens from. A fully static route wins over a
 * dynamic sibling (`members/add` over `members/[membershipId]`).
 */
export function resolveSettingsNestedRouteName(
    navigator: SettingsNestedNavigator,
    pathname: string | null | undefined,
): string | null {
    if (typeof pathname !== 'string') return null;
    const normalized = pathname.trim().replace(/\/+$/, '') || '/';
    if (!normalized.startsWith('/settings/')) return null;
    // A navigator may sit under a dynamic segment (`home/[serverId]/people`): its root matches by pattern.
    const rootPattern = navigator.split('/');
    const pathSegments = normalized.slice('/settings/'.length).split('/');
    if (pathSegments.length < rootPattern.length
        || matchRouteSegments(rootPattern, pathSegments.slice(0, rootPattern.length)) === null) {
        return null;
    }
    const segments = pathSegments.slice(rootPattern.length);
    let dynamicMatch: string | null = null;
    for (const definition of SETTINGS_ROUTE_CHROME_DEFINITIONS) {
        if (definition.navigator !== navigator) continue;
        const nameSegments = definition.name.split('/');
        const candidate = nameSegments[nameSegments.length - 1] === 'index' ? nameSegments.slice(0, -1) : nameSegments;
        const match = matchRouteSegments(candidate, segments);
        if (match === 'static') return definition.name;
        if (match === 'dynamic' && dynamicMatch === null) dynamicMatch = definition.name;
    }
    return dynamicMatch;
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
export function resolveSettingsRouteParentPathname(pathname: string | null | undefined): string | null {
    if (typeof pathname !== 'string') return null;
    const normalizedPathname = pathname.trim().replace(/\/+$/, '') || '/';
    if (normalizedPathname === '/settings') return null;
    if (!normalizedPathname.startsWith('/settings/')) return null;

    // Custom ACP agents live in the Agents collection; `custom` alone is the new-agent draft, not
    // the parent of a saved agent, although it is a mounted route.
    if (/^\/settings\/agents\/custom(?:\/[^/]+)?$/.test(normalizedPathname)) return '/settings/agents';

    const segments = normalizedPathname.slice('/settings/'.length).split('/');
    for (let length = segments.length - 1; length > 0; length -= 1) {
        const ancestor = segments.slice(0, length);
        if (isMountedSettingsRoute(ancestor)) return `/settings/${ancestor.join('/')}`;
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
    const params = useLocalSearchParams<{ settingsSearch?: string | string[] }>();
    const searchOrigin = params[SETTINGS_SEARCH_RETURN_QUERY_PARAM];
    const parentPathname = searchOrigin === '1' ? '/settings' : resolveSettingsRouteParentPathname(pathname);
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
}: Readonly<{
    accessibilityLabel: string;
    tintColor?: string;
    hideOnTopLevel: boolean;
}>): React.ReactElement | null {
    const pathname = usePathname();
    const { goToParent } = useSettingsParentBack('SettingsParentBackButton.back');

    if (!shouldShowSettingsParentBackButton({ pathname, hideOnTopLevel })) {
        return null;
    }

    return React.createElement(Pressable, {
        accessibilityLabel,
        accessibilityRole: 'button',
        hitSlop: 8,
        onPress: goToParent,
        style: {
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: Platform.select({ ios: -8, default: 0 }) as number,
            paddingHorizontal: 8,
            paddingVertical: 6,
        },
    }, React.createElement(Ionicons, {
        color: tintColor,
        name: Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back',
        size: 28,
    }));
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
            });
        }
        return {
            name: definition.name,
            options,
        };
    });
}
