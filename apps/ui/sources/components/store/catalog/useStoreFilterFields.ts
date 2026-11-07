import * as React from 'react';
import type { SettingsColumnFilterField } from '@/components/settings/shell/useSettingsColumnFilter';
import { useRegistrySources } from '@/registries/useRegistrySources';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { t } from '@/text';
import { storeEditorialGroupKey, type StoreColumnField } from './storeColumnAdapter';
import { storeKinds, type StoreKind } from './storeKinds';
import { useAppShellPluginUiProjection, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';

/** Labels for the shared condition owner, from the admitted sources and editorial facts. */
export function useStoreFilterFields(curation: RegistryCuration['curation'], presented: boolean): Readonly<Record<StoreColumnField, SettingsColumnFilterField>> {
    const sources = useRegistrySources(undefined, presented).sources;
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
            kind: { label: t('capabilities.store.search.kind'), valueLabel: value => {
                if (Object.hasOwn(storeKinds, value)) return t(`capabilities.store.kinds.${value as StoreKind}.title`);
                const contribution = contributedKinds?.[value];
                return contribution ? localize(contribution.pluginId, contribution.definition.title) : value;
            } },
            source: { label: t('capabilities.store.catalogLabel'), valueLabel: value => sources.find(source => source.id === value)?.title ?? value },
            category: { label: t('capabilities.store.search.category'), valueLabel: value => categories.get(value) ?? value },
            job: { label: t('capabilities.store.discover.jobsTitle'), valueLabel: value => jobs.get(value) ?? value },
        };
    }, [curation, sources, contributedKinds, localize]);
}
