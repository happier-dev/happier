import * as React from 'react';
import { resolveDeploymentEnvironmentDestinationV1, type DeploymentEnvironmentDestinationV1, type DeploymentEnvironmentSettingsSectionV1 } from '@happier-dev/deployments';
import { ENVIRONMENT_COMPANION_IDS, resolveDetailNavigationItems, type DetailPageNavigationItem, type EnvironmentCompanionId } from '@/components/appShell/rightSidebar/detailNavigationItems';
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
const NO_COMPANIONS: readonly EnvironmentCompanionId[] = Object.freeze([]);
function isEnvironmentCompanionId(id: string): id is EnvironmentCompanionId {
    return (ENVIRONMENT_COMPANION_IDS as readonly string[]).includes(id);
}

/**
 * Selection and Settings-section links remain owned by the Environment route/draft controller. The open companion is
 * transient page state: it opens and closes through the same side column every detail page uses, and the page draws
 * it with `DetailCompanionPane` (beside the page, or pushed on a phone).
 */
export function useEnvironmentNavigation(input: Readonly<{
    scope: ServerAccountScope; environmentId: string; destination: DeploymentEnvironmentDestinationV1;
    phone: boolean; presented: boolean; navigate: (destination: DeploymentEnvironmentDestinationV1) => void;
    /** The companions this Environment can show now; only these are offered. */
    companions?: readonly EnvironmentCompanionId[];
}>) {
    const locale = usePreferredLanguage();
    const offered = input.companions ?? NO_COMPANIONS;
    const offeredKey = offered.join(',');
    const items = React.useMemo(() => resolveDetailNavigationItems({ scope: 'environment', companions: offered }), [locale, offeredKey]);
    const [openCompanion, setOpenCompanion] = React.useState<Readonly<{ environmentId: string; id: EnvironmentCompanionId }> | null>(null);
    // A companion belongs to the Environment it was opened beside, and closes when that Environment stops offering it.
    const activeCompanion = openCompanion !== null && openCompanion.environmentId === input.environmentId
        && offered.includes(openCompanion.id) ? openCompanion.id : null;
    const environmentId = input.environmentId;
    const companion = React.useMemo(() => ({
        activeId: activeCompanion,
        open: (id: EnvironmentCompanionId) => setOpenCompanion({ environmentId, id }),
        close: () => setOpenCompanion(null),
    }), [activeCompanion, environmentId]);
    const latest = React.useRef(input);
    latest.current = input;
    const navigation = usePresentedDetailNavigation({ pageKind: 'environment', identity: input.environmentId,
        scope: input.scope, items, activeId: input.destination.tab, phone: input.phone, presented: input.presented,
        title: t('projects.deployments.review.environment'),
        selectPage: id => {
            const current = latest.current;
            if (id !== current.destination.tab) current.navigate(resolveDeploymentEnvironmentDestinationV1({ tab: id }));
        },
        companion: { activeId: activeCompanion, close: companion.close, select: id => {
            if (isEnvironmentCompanionId(id) && latest.current.companions?.includes(id)) companion.open(id);
        } },
        phoneChrome: execute => {
            const props = { model, onSelect: (id: string) => selectPresentedDetailNavigationItem(execute, model, id) };
            return { node: <EnvironmentCockpitTabBar {...props} />, systemModel: { kind: 'environmentCockpit', props } };
        } });
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
    return { model, placements: navigation.placements, companion };
}

export function selectEnvironmentNavigationItem(execute: ReturnType<typeof useMountedScopeActionCommand>, model: EnvironmentNavigationModel, id: string, section?: DeploymentEnvironmentSettingsSectionV1 | null): void {
    // A companion (the phone bar's More) opens beside the page through the side column, never as a page.
    const column = model.items.find(item => item.id === id)?.navigation.kind === 'companion' ? 'side' : 'main';
    void execute('shell.column.set', { column, visible: true, tab: id }, {
        kind: 'shell.column', column, read: () => model.readColumn(column, column === 'main' ? section : undefined),
    });
}
