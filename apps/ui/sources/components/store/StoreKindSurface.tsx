import * as React from 'react';
import { useAppShellPluginUiProjection, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import type { SurfaceStateSize } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';
import { storeDemandMatches } from './catalog/storeColumnAdapter';
import { listStoreKindContributions, storeKindSurfaceLoader } from './catalog/storeKindContributions';
import type { ContributedStoreKind } from './catalog/storeKindContributions';

export type StoreKindSurfaceInput =
    | Readonly<{ mode: 'browse' | 'search' | 'installed'; presented: boolean; query?: string; filters?: SettingsCollectionFilter }>
    | Readonly<{ mode: 'listing'; presented: boolean; selection: Readonly<{ sourceId: string; itemId: string; version?: string }>;
        pushed: boolean; size: SurfaceStateSize; onClose: () => void }>;

export function useContributedStoreKinds(filters?: SettingsCollectionFilter): readonly ContributedStoreKind[] {
    const entries = useAppShellPluginUiProjection(value => value.pluginUiProjection?.storeKindsById);
    return React.useMemo(() => selectContributedStoreKinds(listStoreKindContributions(entries ? { storeKindsById: entries } : null)
        .filter((kind): kind is ContributedStoreKind => 'pluginId' in kind), filters), [entries, filters]);
}

export function selectContributedStoreKinds(kinds: readonly ContributedStoreKind[], filters?: SettingsCollectionFilter) {
    return filters ? kinds.filter(kind => storeDemandMatches(filters, { kind: [kind.key], source: null })) : kinds;
}

/** The one Store-kind dispatch point: metadata first, code only for a presented kind. */
export function StoreKindSurface(props: StoreKindSurfaceInput & Readonly<{ kind: string }>): React.ReactElement | null {
    return <StoreKindSurfaceMount key={props.kind} {...props} />;
}

function StoreKindSurfaceMount(props: StoreKindSurfaceInput & Readonly<{ kind: string }>): React.ReactElement | null {
    const load = storeKindSurfaceLoader(props.kind);
    const KindSurface = React.useMemo(() => React.lazy(load), [load]);
    const hasPresented = React.useRef(false);
    if (props.presented) hasPresented.current = true;
    if (!hasPresented.current) return null;
    return <React.Suspense fallback={<SkeletonRows rows={5} accessibilityLabel={t('common.loading')} />}>
        <KindSurface kind={props.kind} input={props} />
    </React.Suspense>;
}

/** Search and Installed show each contributed kind through its same view and lifecycle owner. */
export function ContributedStoreKindSections(props: Readonly<{ kinds: readonly ContributedStoreKind[];
    mode: 'search' | 'installed'; presented: boolean; query?: string; filters?: SettingsCollectionFilter }>) {
    const localize = useProjectedPluginLocalizedTextResolver();
    return <>{props.kinds.map(kind => <ItemGroup key={kind.key} surface="none" title={localize(kind.pluginId, kind.definition.title)}>
        <StoreKindSurface kind={kind.key} mode={props.mode} presented={props.presented} query={props.query} filters={props.filters} />
    </ItemGroup>)}</>;
}
