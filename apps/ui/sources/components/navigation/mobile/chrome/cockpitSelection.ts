import type { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import type { ProjectPageCatalogModel } from '@/components/projects/navigation/useProjectPageCatalog';
import type { SessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { selectPresentedDetailNavigationItem } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';

/**
 * The one phone selection path: the bottom bar, its More and the top page strip each run the same
 * `shell.column.set` against the mounted Session's column owners (a page on main, a tool on side).
 */
export function selectSessionCockpitSurface(
    execute: ReturnType<typeof useMountedScopeActionCommand>,
    registration: Pick<SessionCockpitChromeRegistration, 'catalog' | 'readColumn'>,
    surface: SessionMobileSurface,
): void {
    selectPresentedDetailNavigationItem(execute, { items: registration.catalog.map(entry => ({ id: entry.id,
        navigation: entry.tab.navigation ?? { kind: 'companion', companion: entry.id } })), readColumn: registration.readColumn }, surface);
}

/**
 * The one Project phone selection path: the bottom bar, its More and the top page strip each run the same
 * `shell.column.set` against the mounted Project's column owners (a page on main, a companion on side).
 */
export function selectProjectCockpitItem(
    execute: ReturnType<typeof useMountedScopeActionCommand>,
    catalog: Pick<ProjectPageCatalogModel, 'items' | 'readColumn'>,
    id: string,
    column?: 'main' | 'side',
): void {
    const item = column ? undefined : catalog.items.find(candidate => candidate.id === id);
    const companion = item?.navigation.kind === 'companion' ? item.navigation.companion : null;
    const target = column ?? (companion ? 'side' : 'main');
    void execute('shell.column.set', { column: target, visible: true, tab: companion ?? id }, {
        kind: 'shell.column', column: target, read: () => catalog.readColumn(target),
    });
}
