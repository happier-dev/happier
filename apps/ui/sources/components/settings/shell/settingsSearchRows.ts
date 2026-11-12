import { t } from '@/text';

import type { ResolvedSettingsPageNode, SettingsPageIconFactory, SettingsPageSearchResult } from '@/components/settings/catalog/types';

/**
 * The one row projection of a settings-search result, shared by every surface that lists settings
 * results (the settings rail, the phone Settings page and Search / ⌘K), so a page or a setting reads
 * the same everywhere: its title, matching words when needed, and where it lives ("Appearance › Terminal").
 */
export type SettingsSearchRow = Readonly<{
    kind: 'page' | 'setting';
    /** The page id, or the setting's anchor. */
    id: string;
    title: string;
    /** Matching words when needed, followed by the page/section path joined with " › ". */
    subtitle?: string;
    /** The matching words alone, for a surface that names the path as the row's group (Settings results). */
    matchText?: string;
    /** Where it lives ("Appearance › Background"), for a surface that groups rows by it. */
    pathLabel?: string;
    /** The mark of the page it opens (its own, else the nearest page above it that has one). */
    icon?: SettingsPageIconFactory;
    route: string;
}>;

type PageEntry = Readonly<{ title: string; path: readonly string[]; icon?: SettingsPageIconFactory }>;

export type SettingsSearchPageIndex = ReadonlyMap<string, PageEntry>;

const PATH_SEPARATOR = ' › ';

function readNodeTitle(node: ResolvedSettingsPageNode): string {
    return node.title ?? (node.titleKey ? String(t(node.titleKey)) : node.id);
}

/** Each page's title and the group names above it (the catalog root is not part of any path). */
export function indexSettingsSearchPages(tree: readonly ResolvedSettingsPageNode[]): SettingsSearchPageIndex {
    const out = new Map<string, PageEntry>();
    const visit = (nodes: readonly ResolvedSettingsPageNode[], path: readonly string[], depth: number, inheritedIcon?: SettingsPageIconFactory) => {
        for (const node of nodes) {
            const title = readNodeTitle(node);
            const icon = node.icon ?? inheritedIcon;
            out.set(node.id, { title, path, ...(icon ? { icon } : {}) });
            if (node.children) visit(node.children, depth === 0 ? [] : [...path, title], depth + 1, icon);
        }
    };
    visit(tree, [], 0);
    return out;
}

/**
 * Splits catalog results into page rows and setting rows, each in the catalog's ranking order.
 * Surfaces show pages first, then settings: the rail under two labels, Search in one group.
 */
export function buildSettingsSearchRows(
    results: readonly SettingsPageSearchResult[],
    pages: SettingsSearchPageIndex,
): Readonly<{ pageRows: readonly SettingsSearchRow[]; settingRows: readonly SettingsSearchRow[] }> {
    const pageRows: SettingsSearchRow[] = [];
    const settingRows: SettingsSearchRow[] = [];
    for (const result of results) {
        const page = pages.get(result.id);
        const icon = page?.icon;
        if (result.setting) {
            const pathLabel = result.setting.path.join(PATH_SEPARATOR);
            const subtitle = [result.matchText, pathLabel].filter(Boolean).join(' · ');
            settingRows.push({
                kind: 'setting',
                id: result.setting.anchor,
                title: result.setting.title,
                ...(subtitle ? { subtitle } : {}),
                ...(result.matchText ? { matchText: result.matchText } : {}),
                ...(pathLabel ? { pathLabel } : {}),
                ...(icon ? { icon } : {}),
                route: result.route,
            });
            continue;
        }
        const subtitle = [result.matchText, page?.path.join(PATH_SEPARATOR)].filter(Boolean).join(' · ');
        pageRows.push({
            kind: 'page',
            id: result.id,
            title: page?.title ?? String(result.id),
            ...(subtitle ? { subtitle } : {}),
            ...(icon ? { icon } : {}),
            route: result.route,
        });
    }
    return { pageRows, settingRows };
}
