import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

/** Invalid narrowing is recoverable view state; it never admits a broader native read. */
export function StoreDirectoryUnavailable(props: Readonly<{ view: 'search' | 'kind' | 'installed'; kind?: import('./StoreKindPage').StoreDirectoryKind | 'bot' }>) {
    const router = useRouter();
    const { project } = useStoreProjectScope();
  const machine = useStoreMachineScope();
    const clear = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.replace(buildPluginsHomeRoute('app', { view: props.view, kind: props.kind, project, machine })));
        if (result !== true) fireAndForget(result, { tag: 'StoreDirectoryUnavailable.clear' });
    }, [router, props.view, props.kind, project, machine]);
    return <ItemList pageColumn="wide"><PageContentColumn><EmptyState
        testID={props.view === 'installed' ? 'store.installed.invalid' : 'store.search.invalid'}
        layout="inline" iconName="magnifying-glass" title={t('capabilities.store.search.invalid')}
        primaryAction={{ label: t('capabilities.store.clear'), onPress: clear }}
    /></PageContentColumn></ItemList>;
}
