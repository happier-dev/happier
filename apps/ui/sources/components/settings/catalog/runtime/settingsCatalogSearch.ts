import Fuse, { type FuseResult, type IFuseOptions } from 'fuse.js';

import { t } from '@/text';
import type { SettingRef } from '../settingDeclarations';

type SearchText = Readonly<{
    title: string;
    subtitle: string;
    keywords: readonly string[];
    pathTokens: readonly string[];
}>;

export function readSettingRowSearchText(ref: SettingRef): Omit<SearchText, 'pathTokens'> {
    return {
        title: ref.title ?? String(t(ref.titleKey)),
        subtitle: ref.description ?? (ref.descriptionKey ? String(t(ref.descriptionKey)) : ''),
        keywords: (ref.keywordKeys ?? []).map(key => String(t(key))),
    };
}

const PAGE_OPTIONS: IFuseOptions<SearchText> = {
    includeMatches: true,
    ignoreLocation: true,
    // Recover a small typo in the title without accepting unrelated words.
    threshold: 0.2,
    keys: [
        { name: 'title', weight: 0.6 },
        { name: 'keywords', weight: 0.3 },
        { name: 'pathTokens', weight: 0.2 },
        { name: 'subtitle', weight: 0.1 },
    ],
};

const SETTING_OPTIONS: IFuseOptions<SearchText> = {
    ...PAGE_OPTIONS,
    keys: [
        { name: 'title', weight: 0.6 },
        { name: 'keywords', weight: 0.3 },
        { name: 'subtitle', weight: 0.1 },
        { name: 'pathTokens', weight: 0.05 },
    ],
};

export function createSettingsCatalogSearch<T extends SearchText>(
    docs: readonly T[],
    isSetting: (doc: T) => boolean = () => true,
) {
    const pages = new Fuse<T>(docs.filter(doc => !isSetting(doc)), PAGE_OPTIONS);
    const settings = new Fuse<T>(docs.filter(isSetting), SETTING_OPTIONS);
    return (query: string): ReadonlyArray<Readonly<{ item: T; matchText?: string }>> => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const contains = (value: string) => value.toLowerCase().includes(q);
        const project = ({ item, matches }: FuseResult<T>, allowTitleTypo = false) => {
            const visibleMatch = contains(item.title) || (isSetting(item) && item.pathTokens.some(contains));
            const keyword = item.keywords.find(contains);
            const descriptionMatch = item.subtitle.toLowerCase().indexOf(q);
            const matchText = visibleMatch ? undefined : keyword ?? (descriptionMatch < 0 ? undefined
                : `${descriptionMatch > 0 ? '…' : ''}${item.subtitle.slice(descriptionMatch)}`);
            if (!visibleMatch && !matchText && !(allowTitleTypo && matches?.some(match => match.key === 'title'))) return [];
            return [{ item, ...(matchText ? { matchText } : {}) }];
        };
        // Rank pages independently so a page name still returns the page itself.
        const matches = [...pages.search(q), ...settings.search(q)];
        const literal = matches.flatMap(result => project(result));
        return literal.length > 0 ? literal : matches.flatMap(result => project(result, true));
    };
}
