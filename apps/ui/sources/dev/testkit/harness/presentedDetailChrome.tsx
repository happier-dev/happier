import * as React from 'react';

import { usePresentedDetailNavigation } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { ProjectCockpitTabBar } from '@/components/navigation/mobile/chrome/bars/ProjectCockpitTabBar';
import { SessionCockpitTabBar } from '@/components/navigation/mobile/chrome/bars/SessionCockpitTabBar';
import { selectProjectCockpitItem, selectSessionCockpitSurface } from '@/components/navigation/mobile/chrome/cockpitSelection';
import type { ProjectPageCatalogModel } from '@/components/projects/navigation/useProjectPageCatalog';
import { normalizeProjectPage } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { resolveSessionCockpitPhoneItems } from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import { normalizeSessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';

/** Controlled domain input for host tests, through the real presented-detail adapter and phone presenter. */
export function PresentedSessionChromeFixture() {
    const registration = useSessionCockpitChromeRegistration();
    const scope = useActiveServerAccountScope(registration?.serverId ?? null);
    const phone = useDeviceType() === 'phone';
    const items = React.useMemo(() => resolveSessionCockpitPhoneItems(registration?.catalog ?? []).map((entry, phoneOrder) => ({
        id: entry.id, title: getRightSidebarTabLabel(entry.tab), icon: entry.tab.icon,
        disabledReason: entry.tab.disabledReason ?? null,
        navigation: entry.tab.navigation ?? { kind: 'companion' as const, companion: entry.id },
        phonePlacement: entry.phonePlacement,
        phoneOrder, defaultPlacement: entry.defaultPlacement,
    })), [registration?.catalog]);
    const select = (id: string) => {
        const surface = normalizeSessionMobileSurface(id);
        if (surface) registration?.switchSurface(surface);
    };
    const navigation: ReturnType<typeof usePresentedDetailNavigation> = usePresentedDetailNavigation({ pageKind: 'session', identity: registration?.sessionId ?? '',
        sessionId: registration?.sessionId, scope, items, activeId: registration?.activeSurface ?? 'chat',
        phone, presented: registration !== null, selectPage: select,
        companion: { activeId: registration?.activeSurface ?? null, select, close: () => registration?.switchSurface('chat') },
        columnState: column => ({ visible: items.some(item => item.id === registration?.activeSurface
            && (column === 'main' ? item.navigation.kind !== 'companion' : item.navigation.kind !== 'page')),
            activeTab: registration?.activeSurface,
            setVisible: visible => { if (!visible && column === 'side') registration?.switchSurface('chat'); } }),
        chromeRevision: `${registration?.serverId}:${registration?.terminalTabAvailable}:${registration?.openDetailsTabCount}`,
        phoneChrome: execute => {
            if (!registration) return null;
            const props = { ...registration, onSurfacePress: (surface: typeof registration.activeSurface) =>
                selectSessionCockpitSurface(execute, { catalog: registration.catalog, readColumn: navigation.readColumn }, surface) };
            return { node: <SessionCockpitTabBar {...props} />, systemModel: { kind: 'sessionCockpit', props } };
        } });
    return null;
}

export type ProjectChromeFixtureModel = Pick<ProjectPageCatalogModel,
    'pages' | 'activePageId' | 'target' | 'context' | 'projection' | 'authority' | 'items' | 'activeSurface'
    | 'terminalTabAvailable' | 'scopeId'> & Readonly<{ onSelect?: (column: 'main' | 'side', id: string) => void }>;

export function PresentedProjectChromeFixture({ catalog }: Readonly<{ catalog: ProjectChromeFixtureModel }>) {
    const phone = useDeviceType() === 'phone';
    const companions = React.useMemo(() => catalog.items.filter(item => item.companion), [catalog.items]);
    const navigation: ReturnType<typeof usePresentedDetailNavigation> = usePresentedDetailNavigation({ pageKind: 'project', identity: catalog.target.workspaceRefId,
        scope: catalog.authority?.scope ?? null, items: catalog.items, activeId: catalog.activePageId,
        phone, presented: true, selectPage: id => catalog.onSelect?.('main', id),
        companion: { items: companions, activeId: null,
            idForItem: item => item.navigation.kind === 'page' ? item.id : item.navigation.companion,
            select: id => catalog.onSelect?.('side', id), close: () => {} },
        chromeRevision: `${catalog.activeSurface}:${catalog.terminalTabAvailable}`,
        phoneChrome: execute => {
            const props = { workspaceRefId: catalog.target.workspaceRefId, pages: catalog.pages, items: catalog.items,
                countScope: catalog, activePageId: catalog.activePageId, activeSurface: catalog.activeSurface,
                activePage: normalizeProjectPage(catalog.activePageId) ?? 'overview',
                terminalTabAvailable: catalog.terminalTabAvailable, terminalsOpen: false,
                onPagePress: (id: string) => selectProjectCockpitItem(execute, { items: catalog.items, readColumn: navigation.readColumn }, id, 'main'),
                onSurfacePress: (id: string) => selectProjectCockpitItem(execute, { items: catalog.items, readColumn: navigation.readColumn }, id) };
            return { node: <ProjectCockpitTabBar {...props} />, systemModel: { kind: 'projectCockpit', props } };
        } });
    return null;
}
