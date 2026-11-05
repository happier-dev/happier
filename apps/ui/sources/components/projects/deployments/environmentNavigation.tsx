import * as React from 'react';
import { resolveDeploymentEnvironmentDestinationV1, type DeploymentEnvironmentDestinationV1, type DeploymentEnvironmentSettingsSectionV1 } from '@happier-dev/deployments';
import { resolveDetailNavigationItems, type DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { selectPresentedDetailNavigationItem, usePresentedDetailNavigation } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { EnvironmentCockpitTabBar } from './EnvironmentNavigationViews';
import type { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

export const ENVIRONMENT_DESKTOP_NAVIGATION_ADDRESS = { pageKind: 'environment', device: 'desktop', section: 'pages' } as const;
export const ENVIRONMENT_PHONE_NAVIGATION_ADDRESS = { pageKind: 'environment', device: 'phone', section: 'items' } as const;
export type EnvironmentNavigationModel = Readonly<{
    scope: ServerAccountScope;
    environmentId: string;
    items: readonly DetailPageNavigationItem[];
    activeId: DeploymentEnvironmentDestinationV1['tab'];
    readColumn: (column: 'main' | 'side', section?: DeploymentEnvironmentSettingsSectionV1 | null) => ShellColumnActionOwner;
}>;
/** Selection and Settings-section links remain owned by the Environment route/draft controller. */
export function useEnvironmentNavigation(input: Readonly<{
    scope: ServerAccountScope; environmentId: string; destination: DeploymentEnvironmentDestinationV1;
    phone: boolean; presented: boolean; navigate: (destination: DeploymentEnvironmentDestinationV1) => void;
}>) {
    const locale = usePreferredLanguage();
    const items = React.useMemo(() => resolveDetailNavigationItems({ scope: 'environment' }), [locale]);
    const navigation = usePresentedDetailNavigation({ pageKind: 'environment', identity: input.environmentId,
        scope: input.scope, items, activeId: input.destination.tab, phone: input.phone, presented: input.presented,
        title: t('projects.deployments.review.environment'),
        selectPage: id => {
            if (id !== input.destination.tab) input.navigate(resolveDeploymentEnvironmentDestinationV1({ tab: id }));
        },
        phoneChrome: execute => {
            const props = { model, onSelect: (id: string) => selectPresentedDetailNavigationItem(execute, model, id) };
            return { node: <EnvironmentCockpitTabBar {...props} />, systemModel: { kind: 'environmentCockpit', props } };
        } });
    const latest = React.useRef(input);
    latest.current = input;
    const readColumn = React.useCallback((column: 'main' | 'side', section?: DeploymentEnvironmentSettingsSectionV1 | null): ShellColumnActionOwner => {
        const owner = navigation.readColumn(column);
        if (column !== 'main' || section === undefined) return owner;
        return { ...owner, selectTab: id => {
            const current = latest.current;
            if (id !== current.destination.tab || section !== current.destination.section) {
                current.navigate(resolveDeploymentEnvironmentDestinationV1({ tab: id, section }));
            }
        } };
    }, [navigation.readColumn]);
    const model = React.useMemo<EnvironmentNavigationModel>(() => ({ ...navigation.model, scope: input.scope,
        environmentId: input.environmentId, activeId: input.destination.tab, readColumn }),
    [navigation.model, input.scope, input.environmentId, input.destination.tab, readColumn]);
    return { model, placements: navigation.placements };
}

export function selectEnvironmentNavigationItem(execute: ReturnType<typeof useMountedScopeActionCommand>, model: EnvironmentNavigationModel, id: string, section?: DeploymentEnvironmentSettingsSectionV1 | null): void {
    void execute('shell.column.set', { column: 'main', visible: true, tab: id }, {
        kind: 'shell.column', column: 'main', read: () => model.readColumn('main', section),
    });
}
