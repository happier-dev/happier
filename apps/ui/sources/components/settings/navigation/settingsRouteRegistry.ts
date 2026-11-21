import * as React from 'react';
import { ownChromeHeaderLeft } from '@/components/navigation/ownChromeHeaderItems';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { TranslationKeyNoParams } from '@/text';
import { DefaultBackButton } from '@/components/navigation/Header';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { LEGACY_PROMPT_STACKS_ROUTE, PROMPTS_CONTEXT_ROUTE } from '@/components/settings/prompts/context/promptsContextNavigation';
import { MACHINE_RETENTION_CATEGORIES_V1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { memoryDocumentHref } from '@/components/memory/memoryDocumentRoutes';
import { readMachineAddRoutePath } from '@/components/machines/add/machineAddPaths';
import { hasNewSessionPickerContinuation } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { useNavigationLeavesLargeTitle } from '@/components/ui/layout/navigationTitleChrome';

type Translate = (key: TranslationKeyNoParams) => string;

/** A result opened from the retained Settings-page search returns to that page on Back. */
export const SETTINGS_SEARCH_RETURN_QUERY_PARAM = 'settingsSearch';

/** A Settings page opened from another surface returns through the existing navigation history. */
export const SETTINGS_RETURN_QUERY_PARAM = 'settingsReturn';

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
type SettingsParentRouteParams = Readonly<{
    category?: string | string[];
    source?: string | string[];
    serverId?: string | string[];
    topic?: string | string[];
    fact?: string | string[];
    edit?: string | string[];
    path?: string | string[];
}>;

type SettingsParentRoutePresentation = Readonly<{ machineAddPushesWays: boolean }>;

export function resolveSettingsRouteParentHref(
    pathname: string | null | undefined,
    params?: SettingsParentRouteParams,
    presentation?: SettingsParentRoutePresentation,
): string | null {
    if (typeof pathname !== 'string') return null;
    const normalizedPathname = pathname.trim().replace(/\/+$/, '') || '/';
    if (normalizedPathname === '/settings') return null;
    if (!normalizedPathname.startsWith('/settings/')) return null;

    // A phone opens a fact (or its editor) within the document's query-state pages.
    // Keep the qualified document and topic when closing it; then close the topic to the index.
    const memoryDocument = /^\/settings\/prompts\/memory\/([^/]+)$/.exec(normalizedPathname);
    const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
    const topic = first(params?.topic);
    const hasFact = first(params?.fact) || first(params?.edit);
    if (memoryDocument && (hasFact || topic)) {
        return memoryDocumentHref({ artifactId: decodeURIComponent(memoryDocument[1]!) }, {
            serverId: first(params?.serverId),
            ...(hasFact && topic ? { topic } : {}),
        });
    }

    // Phone Defaults categories are pushed as query-state pages. Leaving one removes the
    // category first; leaving Defaults itself still returns to the Machines collection.
    const category = Array.isArray(params?.category) ? params.category[0] : params?.category;
    if (normalizedPathname === '/settings/machines/defaults'
        && (MACHINE_RETENTION_CATEGORIES_V1 as readonly string[]).includes(category ?? '')) {
        return normalizedPathname;
    }

    // A phone pushes the chosen way to add a machine as Add a machine's query state: Back returns to the ways first.
    if (presentation?.machineAddPushesWays && normalizedPathname === '/settings/machines/add'
        && readMachineAddRoutePath(params?.path)) return normalizedPathname;

    // A phone pushes an open plugin source as the Sources page's query state: Back closes it to the list first.
    if (normalizedPathname === '/settings/plugins/sources' && params?.source !== undefined) return normalizedPathname;

    // Custom ACP agents live in the Agents collection; `custom` alone is the new-agent draft, not
    // the parent of a saved agent, although it is a mounted route.
    if (/^\/settings\/agents\/custom(?:\/[^/]+)?$/.test(normalizedPathname)) return '/settings/agents';

    // A preset is a row of the Machines collection; `presets` alone only forwards to the Presets index.
    if (/^\/settings\/machines\/presets\/[^/]+$/.test(normalizedPathname)) return '/settings/machines';

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

/** Path-only projection for chrome visibility and title lookup; navigation retains query state. */
export function resolveSettingsRouteParentPathname(
    pathname: string | null | undefined,
    params?: SettingsParentRouteParams,
    presentation?: SettingsParentRoutePresentation,
): string | null {
    return resolveSettingsRouteParentHref(pathname, params, presentation)?.split('?')[0] ?? null;
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
export function useSettingsParentBack(tag: string, presentation?: SettingsParentRoutePresentation): Readonly<{ parentPathname: string | null; goToParent: () => void }> {
    const pathname = usePathname();
    const router = useRouter();
    const phoneSettings = useNavigationLeavesLargeTitle();
    const params = useLocalSearchParams<SettingsParentRouteParams & {
        settingsSearch?: string | string[];
        settingsReturn?: string | string[];
    }>();
    const searchOrigin = params[SETTINGS_SEARCH_RETURN_QUERY_PARAM];
    const returnToOrigin = params[SETTINGS_RETURN_QUERY_PARAM] === '1';
    const pickerContinuation = hasNewSessionPickerContinuation(params);
    const parentHref = searchOrigin === '1' ? '/settings' : resolveSettingsRouteParentHref(pathname, params,
        presentation ?? { machineAddPushesWays: phoneSettings });
    const parentPathname = parentHref?.split('?')[0] ?? null;
    const goToParent = React.useCallback(() => {
        if (!parentHref) return;
        const result = runGuardedNavigation(() => {
            if ((returnToOrigin || pickerContinuation) && router.canGoBack()) {
                router.back();
            } else {
                router.dismissTo(parentHref as never);
            }
        });
        if (result !== true) {
            fireAndForget(result, { tag });
        }
    }, [parentHref, returnToOrigin, pickerContinuation, router, tag]);
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
    /** Names the parent screen beside the arrow: the page's own large title is the only title. */
    parentLabel?: Translate;
}>): React.ReactElement | null {
    const pathname = usePathname();
    const { parentPathname, goToParent } = useSettingsParentBack('SettingsParentBackButton.back', { machineAddPushesWays: true });

    if (!shouldShowSettingsParentBackButton({ pathname, hideOnTopLevel })) {
        return null;
    }

    const parentTitleKey = parentLabel ? resolveSettingsRouteTitleKey(parentPathname) : null;
    // The one Back of a phone on every platform: Android and the web draw it in the app's bar, iPhone stands it
    // in the native bar as its own item (`unstable_headerLeftItems`, without the shared glass background).
    return React.createElement(DefaultBackButton, {
        accessibilityLabel,
        ...(tintColor ? { tintColor } : {}),
        onPress: goToParent,
        ...(parentLabel && parentTitleKey ? { label: parentLabel(parentTitleKey) } : {}),
    });
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
        // One rule for every subpage on a phone: the bar names the parent, the page names itself
        // (a large title, `app/(app)/settings/_layout`). The hub is not a subpage: it has no parent in Settings to name.
        const isHub = definition.name === 'index' && !definition.navigator;
        if (definition.titleKey) {
            options.headerTitle = isHub ? t(definition.titleKey) : '';
        }
        // The hub is a main screen (owner 11-10): its own title row (`SettingsPageSearch`) carries the title on the
        // left and the search beside it, so no bar is drawn above it.
        if (isHub) options.headerShown = false;
        if ((definition.name !== 'index' || definition.navigator) && options.headerShown !== false) {
            const accessibilityLabel = t('common.back');
            const renderBack = (tintColor: string | undefined) => React.createElement(SettingsParentBackButton, {
                accessibilityLabel,
                tintColor,
                hideOnTopLevel: false,
                parentLabel: t,
            });
            // The app's Back paints no iOS shared item glass (lab p5).
            Object.assign(options, ownChromeHeaderLeft(({ tintColor }) => renderBack(tintColor)));
        }
        return {
            name: definition.name,
            options,
        };
    });
}
