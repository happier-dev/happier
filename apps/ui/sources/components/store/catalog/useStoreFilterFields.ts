import * as React from 'react';
import type { SettingsColumnFilterField } from '@/components/settings/shell/useSettingsColumnFilter';
import { useRegistrySources } from '@/registries/useRegistrySources';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { t } from '@/text';
import { storeEditorialGroupKey, type StoreColumnField } from './storeColumnAdapter';
import { storeKinds, type StoreKind } from './storeKinds';
import { kindCopy } from './storeKindCopy';
import { useAppShellPluginUiProjection, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { usePluginThemeList } from '@/theme/profiles/usePluginThemeList';

/** Labels for the shared condition owner, from the admitted sources and editorial facts. */
export function useStoreFilterFields(curation: RegistryCuration['curation'], presented: boolean): Readonly<Record<StoreColumnField, SettingsColumnFilterField>> {
    const sources = useRegistrySources(undefined, presented).sources;
    const pluginThemes = usePluginThemeList(presented);
    const contributedKinds = useAppShellPluginUiProjection(value => value.pluginUiProjection?.storeKindsById);
    const localize = useProjectedPluginLocalizedTextResolver();
    return React.useMemo(() => {
        const categories = new Map<string, string>();
        const jobs = new Map<string, string>();
        for (const page of curation) {
            for (const category of page.discovery.categories) categories.set(storeEditorialGroupKey(page.sourceId, category.id), category.title);
            for (const job of page.discovery.jobs) jobs.set(storeEditorialGroupKey(page.sourceId, job.id), job.title);
        }
        return {
            kind: { label: t('capabilities.store.search.kind'), icon: 'squares-four' as const, valueLabel: value => {
                if (Object.hasOwn(storeKinds, value)) return kindCopy(value as StoreKind).title;
                const contribution = contributedKinds?.[value];
                return contribution ? localize(contribution.pluginId, contribution.definition.title) : value;
            } },
            source: { label: t('capabilities.store.catalogLabel'), icon: 'cloud' as const, valueLabel: value => sources.find(source => source.id === value)?.title
                ?? pluginThemes.find(theme => theme.pluginId === value)?.pluginName ?? value },
            category: { label: t('capabilities.store.search.category'), icon: 'stack' as const, valueLabel: value => categories.get(value) ?? value },
            job: { label: t('capabilities.store.discover.jobsTitle'), icon: 'list-checks' as const, valueLabel: value => jobs.get(value) ?? value },
        };
    }, [curation, sources, pluginThemes, contributedKinds, localize]);
}
