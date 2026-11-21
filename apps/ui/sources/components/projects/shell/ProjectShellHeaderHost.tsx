import { selectScmChangedFileCount } from '@/scm/scmStatusFiles';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { seedAndOpenProjectDraft } from '@/components/projects/activation/projectOpenDraftSeed';
import { ProjectAtmosphereLookChip, ProjectLookPopover } from '@/components/atmosphere/ProjectAtmosphereFrame';
import { ProjectHeaderActions, type ProjectHeaderActionsProps } from '@/components/projects/detail/ProjectHeaderActions';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { useNavigateToProjectOpen } from '@/components/projects/activation/projectOpenPresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useProjectNewSessionAction } from '@/components/projects/useProjectNewSessionAction';
import { type ProjectPageV1, type ProjectPageSelection } from '@/components/workspaceCockpit/project/projectCockpitState';
import { ProjectPageCatalogProvider, useOptionalProjectPageCatalog, useProjectPageCatalog } from '../navigation/useProjectPageCatalog';
import { ProjectPageChromeCounts } from '../navigation/ProjectPageChromeCounts';
import { resolveProjectNavigationCustomizer } from '../navigation/projectNavigationCustomizer';
import { resolveNavigationPlacements } from '@/sync/domains/settings/navigationPlacement';
import { useNavigationSurfacePlacement, useNavigationSurfacePlacementActionWriter } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { Modal } from '@/modal';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useWorkspaceRefs, useActiveMachineFacts } from '@/sync/domains/state/storage';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveProjectCheckoutWorkspaceRef, resolveWorkspaceRefById, sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import { t } from '@/text';
import { resolveMachineDisplayNameParts, resolveSettledMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { useProjectMachineDisplays } from '../useProjectMachineDisplays';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { useManagedMachineName } from '@/components/approvals/approvalReferenceReading';
import { describeManagedCheckoutPlace } from './projectCheckoutPlace';

import { resolveWorkspaceRefDisplayName } from '../resolveWorkspaceRefDisplayName';
import { useOpenProject } from '../useOpenProject';
import { useProjectRouteActions } from '../detail/useProjectRouteActions';
import { readProjectRouteCheckoutRootPath } from '../detail/projectRouteState';
import { useProjectSource } from '../sources/useProjectSources';
import { projectPageLabel } from '../navigation/projectPageDisplay';
import {
  ProjectCheckoutChip,
  ProjectShellHeader,
  type ProjectShellCheckout,
  type ProjectShellPage,
} from './ProjectShellHeader';

const OPEN_ELSEWHERE = '\u0000open-elsewhere';
const SOURCE_HEADER_PAGES: readonly ProjectShellPage[] = [];
const SOURCE_HEADER_MENU: readonly PageHeaderMenuAction[] = [];
const keepSourcePage = () => {};

/** A stored Project's header uses its exact admitted Source; it has no checkout or checkout-only destinations. */
export const ProjectSourceShellHeaderHost = React.memo(function ProjectSourceShellHeaderHost(props: Readonly<{
  serverId: string | null;
  sourceId: string | null;
  presented: boolean;
}>) {
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const { source } = useProjectSource(props.presented ? binding : null, props.sourceId);
  return <ProjectShellHeader projectName={source?.source.name ?? projectPageLabel('deployments')}
    checkout={null} pages={SOURCE_HEADER_PAGES} activePage="deployments" onSelectPage={keepSourcePage}
    onNewSession={null} menuActions={SOURCE_HEADER_MENU} />;
});

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

type ProjectShellScope = Readonly<{
  workspaceRef: WorkspaceRefV1;
  activeRootPath: string;
  activeWorktreeId?: string | null;
  selection?: ProjectPageSelection;
  onSelectRootPath: (path: string) => void;
  onSelectWorkspace?: (workspaceRef: WorkspaceRefV1) => void;
}>;

/**
 * The checkout chip's projection (desktop chip and phone row are one model): the machine and branch
 * the page follows, every exact checkout of this Project the viewer knows, and "Open this branch on
 * another machine" into 11's Open dialog. A choice routes through the existing owners only.
 */
export function useProjectShellCheckout(
  props: ProjectShellScope,
): Readonly<{
  checkout: ProjectShellCheckout;
  changeCount: number;
  branch: string | null;
}> {
  const { theme } = useUnistyles();
  const navigateToOpen = useNavigateToProjectOpen();
  const openProject = useOpenProject();
  const machines = useActiveMachineFacts();
  const refs = useWorkspaceRefs();
  // An attached workspace reads its branch from the workspace itself, through its controller (remote workspaces U1).
  const scope = React.useMemo(
    () => workspaceScopeFromProject(props.workspaceRef, props.activeRootPath),
    [props.activeRootPath, props.workspaceRef],
  );
  const managedRef = isManagedWorkspaceRefV2(props.workspaceRef) ? props.workspaceRef : null;
  const managedName = useManagedMachineName(managedRef ? props.workspaceRef.serverId : null, managedRef?.managedId ?? null);
  // Changes owns its measured read. Its header observes the same branch, worktrees and full counts.
  const changesPresented = props.selection?.kind === 'builtin' && props.selection.page === 'changes';
  const { snapshot } = useWorkspaceScmSnapshotController(scope, { refreshOnMount: props.selection?.kind !== 'plugin' && !changesPresented, detail: 'summary' });
  // The Projects tree's naming: a Machine whose name is still resolving has none yet, never its id or a placeholder.
  const machineDisplays = useProjectMachineDisplays(machines);
  const names = React.useMemo(() => ({
    settled: resolveSettledMachineDisplayNames(machineDisplays),
    parts: resolveMachineDisplayNameParts(machineDisplays),
  }), [machineDisplays]);
  const machineName = React.useCallback((machineId: string) => names.settled.get(machineId) ?? '', [names]);
  const machineNameParts = (names.settled.has(props.workspaceRef.machineId) ? names.parts.get(props.workspaceRef.machineId) : null)
    ?? RESOLVING_MACHINE_NAME;
  // Only a branch the checkout reported: a folder name is not a branch (an unread checkout shows its machine).
  const branch = snapshot?.branch.head ?? null;
  const worktrees = snapshot?.repo.worktrees;
  const { onSelectRootPath } = props;

  const choices = React.useMemo((): DropdownMenuItem[] => {
    const glyph = (name: 'git-branch' | 'desktop' | 'plus') => (
      <Icon
        name={name}
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
    );
    const local: DropdownMenuItem[] =
      worktrees && worktrees.length > 0
        ? worktrees.map((worktree) => ({
            id: `path:${worktree.path}`,
            title: worktree.branch ?? lastPathSegment(worktree.path),
            subtitle: worktree.path,
            category: t('projects.checkouts.thisMachine'),
            icon: glyph('git-branch'),
            checked: worktree.path === props.activeRootPath,
          }))
        : [
            {
              id: `path:${props.activeRootPath}`,
              title: branch ?? lastPathSegment(props.activeRootPath),
              subtitle: props.activeRootPath,
              category: t('projects.checkouts.thisMachine'),
              icon: glyph('git-branch'),
              checked: true,
            },
          ];
    const elsewhere: DropdownMenuItem[] = (Array.isArray(refs) ? refs : [])
      .filter(
        (ref) =>
          ref.id !== props.workspaceRef.id &&
          areServerProfileIdentifiersEquivalent(ref.serverId, props.workspaceRef.serverId) &&
          ref.machineId !== props.workspaceRef.machineId &&
          sameWorkspaceProject(ref, props.workspaceRef),
      )
      .map((ref) => ({
        id: `ref:${ref.id}`,
        title: ref.label ?? lastPathSegment(ref.rootPath),
        subtitle: `${machineName(ref.machineId)} · ${ref.rootPath}`,
        category: t('projects.checkouts.otherMachines'),
        icon: glyph('desktop'),
      }));
    return [
      ...local,
      ...elsewhere,
      {
        id: OPEN_ELSEWHERE,
        title: t('projects.checkouts.openElsewhere'),
        category: 'open',
        icon: glyph('plus'),
      },
    ];
  }, [
    branch,
    machineName,
    props.activeRootPath,
    props.workspaceRef,
    refs,
    theme.colors.text.secondary,
    worktrees,
  ]);

  const onSelect = React.useCallback(
    (id: string) => {
      if (id.startsWith('path:')) onSelectRootPath(id.slice('path:'.length));
      else if (id.startsWith('ref:')) {
        const workspaceRefId = id.slice('ref:'.length);
        const resolution = resolveWorkspaceRefById(refs, workspaceRefId, props.workspaceRef.serverId);
        if (resolution.kind !== 'resolved') return;
        const selectedRef = resolution.ref;
        if (props.onSelectWorkspace) props.onSelectWorkspace(selectedRef);
        else fireAndForget(openProject(workspaceRefId, { serverId: selectedRef.serverId }), { tag: 'ProjectHeader.openCheckout' });
      }
      else if (id === OPEN_ELSEWHERE) {
        // 11's Open dialog, seeded with this exact checkout and its ref; the person picks the Machine.
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, props.workspaceRef.serverId)) return;
        const actualRef = snapshot?.branch.head;
        const selected = resolveProjectCheckoutWorkspaceRef(refs, props.workspaceRef, props.activeRootPath);
        fireAndForget(seedAndOpenProjectDraft({ lifetime, selection: { serverId: lifetime.scope.serverId,
          ...(selected ? { source: { kind: 'workspace' as const, workspaceId: selected.id, checkout: workspaceAddressFromRefV2(selected) } }
            : { editing: { folderPath: props.activeRootPath } }),
          ...(actualRef ? { ref: actualRef } : {}) },
          navigate: navigateToOpen }), { tag: 'project.openElsewhere' });
      }
    },
    [
      branch,
      onSelectRootPath,
      openProject,
      props.workspaceRef,
      props.activeRootPath,
      snapshot?.branch.head,
      props.onSelectWorkspace,
      refs,
      navigateToOpen,
    ],
  );

  const place = managedRef
    ? describeManagedCheckoutPlace({ controllerMachineId: managedRef.controller.machineId,
        machineNameParts: (id) => (names.settled.has(id) ? names.parts.get(id) ?? null : null), managedName })
    : { machineName: machineName(props.workspaceRef.machineId), machineNameParts, machineIcon: 'desktop' as const };
  return {
    checkout: {
      ...place,
      branch,
      choices,
      onSelect,
    },
    changeCount: snapshot ? selectScmChangedFileCount(snapshot) : 0,
    branch,
  };
}

/**
 * The Project header bound to its page (12s1): the route owns the selected page and checkout; this
 * host projects them and routes each choice through the existing owners — page tabs through the
 * Project route, New session through 23's editable draft (never auto-Send).
 */
type ProjectShellHeaderHostProps = ProjectShellScope & Readonly<{
        page: ProjectPageV1;
        /** Defaults to the Project route's own page navigation. */
        onSelectPage?: (page: ProjectPageV1) => void;
        /** Context's body is Fork D's 65s2; the tab stays a destination either way (D44). */
        pages?: readonly ProjectPageV1[];
        menuActions?: readonly PageHeaderMenuAction[];
        /** The key the shown plugin tab lends its actions under (`projectPageActionsKey`). */
        pageActionsKey?: string;
      }>;

export const ProjectShellHeaderHost = React.memo(function ProjectShellHeaderHost(props: ProjectShellHeaderHostProps) {
    const catalog = useOptionalProjectPageCatalog();
    const sameScope = catalog?.target.workspaceRefId === props.workspaceRef.id
      && catalog.authority?.isCurrent() !== false
      && areServerProfileIdentifiersEquivalent(catalog.target.serverId, props.workspaceRef.serverId)
      && readProjectRouteCheckoutRootPath({ rawWorktreeId: catalog.target.rawWorktreeId ?? undefined,
        rawLegacyActiveRootPath: catalog.target.rawActiveRootPath ?? undefined,
        defaultRootPath: props.workspaceRef.rootPath }) === props.activeRootPath;
    return sameScope ? <ProjectShellHeaderContent {...props} />
      : <ProjectPageCatalogProvider workspaceRef={props.workspaceRef} activeRootPath={props.activeRootPath}
          activeWorktreeId={props.activeWorktreeId} selection={props.selection}><ProjectShellHeaderContent {...props} /></ProjectPageCatalogProvider>;
});

function ProjectShellHeaderContent(props: ProjectShellHeaderHostProps) {
    const catalog = useProjectPageCatalog();
    const { preferences } = useNavigationSurfacePlacement('projectTabBar');
    const writePlacement = useNavigationSurfacePlacementActionWriter('projectTabBar');
    const pages = React.useMemo(() => props.pages
      ? catalog.pages.filter(page => page.kind === 'plugin' || props.pages?.includes(page.selection.kind === 'builtin' ? page.selection.page : 'overview'))
      : catalog.pages, [catalog.pages, props.pages]);
    const placementItems = React.useMemo(() => pages.map(page => {
      const source = page.pluginPage ? catalog.projection?.installedPackagesById[page.pluginPage.pluginId]?.displayName : undefined;
      return source ? { ...page, menuTitle: t('navigationPlacement.tabMenuTitle', { title: page.title, source }) } : page;
    }), [pages, catalog.projection?.installedPackagesById]);
    const placements = React.useMemo(() => resolveNavigationPlacements(pages, preferences), [pages, preferences]);
    const newSession = useProjectNewSessionAction({ workspaceRef: props.workspaceRef,
      activeRootPath: props.activeRootPath, page: props.page });
    const executeNavigation = useMountedScopeActionCommand(catalog.authority?.scope ?? null);
    const selectPage = React.useCallback((id: string) => {
        void executeNavigation('shell.column.set', { column: 'main', visible: true, tab: id }, {
            kind: 'shell.column', column: 'main', read: () => catalog.readColumn('main'),
        });
    }, [catalog.readColumn, executeNavigation]);
    const { checkout, changeCount } = useProjectShellCheckout(props);
    const customize = React.useCallback(() => {
      fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ DetailNavigationCustomizer }) => {
        Modal.show({ component: DetailNavigationCustomizer,
          props: resolveProjectNavigationCustomizer({ items: catalog.items, device: 'desktop' }) });
      }), { tag: 'ProjectShellHeader.customize' });
    }, [catalog.items]);
    const menuActions = React.useMemo(() => [...(props.menuActions ?? []), {
      id: 'customize-project-tabs', title: t('navigationPlacement.customize'),
      testID: 'project-shell-header.customize', onSelect: customize,
    }], [props.menuActions, customize]);
    const orderedPageIds = React.useMemo(() => placements.ordered.map(page => page.id), [placements.ordered]);

    return (
      <>
        <ProjectPageChromeCounts pages={pages} context={catalog.context} projection={catalog.projection}
          authority={catalog.authority} preferences={preferences}>{countedPages => {
          const countedPlacements = resolveNavigationPlacements(countedPages, preferences);
          return <ProjectShellHeader
          projectName={resolveWorkspaceRefDisplayName(props.workspaceRef)}
          checkout={checkout}
          pages={countedPlacements.pinned}
          overflowPages={countedPlacements.overflow}
          orderedPageIds={orderedPageIds}
          activePage={catalog.activePageId}
          changeCount={changeCount}
          onCustomizeTabs={customize}
          placement={{ items: placementItems, preferences, scope: catalog.authority?.scope ?? null, onChange: writePlacement }}
          onSelectPage={selectPage}
          onNewSession={newSession.open}
          menuActions={menuActions}
          {...(props.pageActionsKey === undefined ? {} : { pageActionsKey: props.pageActionsKey })}
          look={<ProjectAtmosphereLookChip />}
        />;
        }}</ProjectPageChromeCounts>
      </>
    );
}

/**
 * A phone Project page's head line (owner P1 11-15; the head PRs & Issues ships): Back stays the bar's own, the
 * Machine chip and the route's launchers sit on its right, then ⋯ with the Project's Look. The name is the page's
 * large title under it, so the bar carries no title.
 */
export const ProjectPhoneHead = React.memo(function ProjectPhoneHead(
  props: ProjectShellScope & Readonly<{ launchers: ProjectHeaderActionsProps }>,
) {
  const { checkout } = useProjectShellCheckout(props);
  const { serverId, projectKey, id } = props.workspaceRef;
  const project = React.useMemo(() => ({ serverId, projectKey: projectKey ?? id }), [id, projectKey, serverId]);
  // The same Project-launched composer the wide header's New session opens (one launcher, one draft owner).
  const newSession = useProjectNewSessionAction({ workspaceRef: props.workspaceRef, activeRootPath: props.activeRootPath });
  return <ProjectPhoneHeadView checkout={checkout} project={project} launchers={props.launchers} onNewSession={newSession.open} />;
});

const PHONE_HEAD_CHIP_SLOT = { flexShrink: 1, minWidth: 0 } as const;
const RESOLVING_MACHINE_NAME = Object.freeze({ name: '', hint: null });

export function ProjectPhoneHeadView(props: Readonly<{
  checkout: ProjectShellCheckout;
  project: Readonly<{ serverId: string; projectKey: string }>;
  launchers: ProjectHeaderActionsProps;
  onNewSession?: () => void;
}>) {
  const lookAnchorRef = React.useRef<View | null>(null);
  const [lookOpen, setLookOpen] = React.useState(false);
  const closeLook = React.useCallback(() => setLookOpen(false), []);
  const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => [{
    id: 'look', title: t('settingsAppearance.glassControls.look'), testID: 'project-phone-head.look',
    onSelect: () => setLookOpen(true),
  }], []);
  return (
    <ProjectHeaderActions
      {...props.launchers}
      {...(props.onNewSession ? { onNewSession: props.onNewSession } : {})}
      // The bar's right side is capped; the chip gives up its width there (its name ellipsizes) and Back stays.
      // A pushed head carries no Activity: that stands on the destination heads' tab line (`PhoneMainTabLine`), so
      // the chip keeps the Machine's name (UI refinements decision 1, LABPARITY-ACCEPT-G4-1118).
      leading={<View style={PHONE_HEAD_CHIP_SLOT}>
        <ProjectCheckoutChip checkout={props.checkout} compact={false} testID="project-phone-checkout" />
      </View>}
      trailing={<View ref={lookAnchorRef} collapsable={false}>
        <PageHeaderMenu actions={menuActions} testID="project-phone-head.menu" />
        {lookOpen ? <ProjectLookPopover project={props.project} anchorRef={lookAnchorRef} onRequestClose={closeLook} /> : null}
      </View>}
    />
  );
}
