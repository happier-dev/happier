import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { seedAndOpenProjectDraft } from '@/components/projects/activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from '@/components/projects/activation/projectOpenPresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import {
  PROJECT_PAGES,
  type ProjectPageV1,
} from '@/components/workspaceCockpit/project/projectCockpitState';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useAllMachines, useWorkspaceRefs } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefById, resolveWorkspaceRefByScope, sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import { resolveWorkspaceRefDisplayName } from '../resolveWorkspaceRefDisplayName';
import { useOpenProject } from '../useOpenProject';
import { useProjectRouteActions } from '../detail/useProjectRouteActions';
import {
  ProjectCheckoutChip,
  ProjectShellHeader,
  type ProjectShellCheckout,
  type ProjectShellPage,
} from './ProjectShellHeader';

const OPEN_ELSEWHERE = '\u0000open-elsewhere';

function lastPathSegment(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

type ProjectShellScope = Readonly<{
  workspaceRef: WorkspaceRefV1;
  activeRootPath: string;
  activeWorktreeId?: string | null;
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
  branch: string;
}> {
  const { theme } = useUnistyles();
  const navigateToOpen = useNavigateToProjectOpen();
  const openProject = useOpenProject();
  const machines = useAllMachines();
  const refs = useWorkspaceRefs();
  const scope = React.useMemo(
    () => ({
      serverId: props.workspaceRef.serverId,
      machineId: props.workspaceRef.machineId,
      rootPath: props.activeRootPath,
    }),
    [
      props.activeRootPath,
      props.workspaceRef.machineId,
      props.workspaceRef.serverId,
    ],
  );
  const { snapshot } = useWorkspaceScmSnapshotController(scope);
  const machineName = React.useCallback(
    (machineId: string) => {
      const machine =
        machines.find((candidate) => candidate.id === machineId) ?? null;
      return getMachineDisplayName(machine) ?? machineId;
    },
    [machines],
  );
  const branch = snapshot?.branch.head ?? lastPathSegment(props.activeRootPath);
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
              title: branch,
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
        else openProject(workspaceRefId, { serverId: selectedRef.serverId });
      }
      else if (id === OPEN_ELSEWHERE) {
        // 11's Open dialog, seeded with this exact checkout and its ref; the person picks the Machine.
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, props.workspaceRef.serverId)) return;
        const actualRef = snapshot?.branch.head;
        const selected = resolveWorkspaceRefByScope(refs, { serverId: props.workspaceRef.serverId,
          machineId: props.workspaceRef.machineId, rootPath: props.activeRootPath });
        fireAndForget(seedAndOpenProjectDraft({ lifetime, selection: { serverId: lifetime.scope.serverId,
          ...(selected.kind === 'resolved' ? { source: { kind: 'workspace' as const, workspaceId: selected.ref.id },
            editing: { checkout: { serverId: selected.ref.serverId, workspaceId: selected.ref.id,
              machineId: selected.ref.machineId, rootPath: selected.ref.rootPath } } } : { editing: { folderPath: props.activeRootPath } }),
          ...(actualRef ? { ref: actualRef } : {}) },
          navigate: navigateToOpen }), { tag: 'project.openElsewhere' });
      }
    },
    [
      branch,
      onSelectRootPath,
      openProject,
      props.workspaceRef.id,
      props.workspaceRef.serverId,
      props.workspaceRef.machineId,
      props.activeRootPath,
      snapshot?.branch.head,
      props.onSelectWorkspace,
      refs,
      navigateToOpen,
    ],
  );

  return {
    checkout: {
      machineName: machineName(props.workspaceRef.machineId),
      machineIcon: 'desktop',
      branch,
      choices,
      onSelect,
    },
    changeCount: snapshot?.entries.length ?? 0,
    branch,
  };
}

/**
 * The Project header bound to its page (12s1): the route owns the selected page and checkout; this
 * host projects them and routes each choice through the existing owners — page tabs through the
 * Project route, New session through 23's editable draft (never auto-Send).
 */
export const ProjectShellHeaderHost = React.memo(
  function ProjectShellHeaderHost(
    props: ProjectShellScope &
      Readonly<{
        page: ProjectPageV1;
        /** Defaults to the Project route's own page navigation. */
        onSelectPage?: (page: ProjectPageV1) => void;
        /** Context's body is Fork D's 65s2; the tab stays a destination either way (D44). */
        pages?: readonly ProjectPageV1[];
        menuActions?: readonly PageHeaderMenuAction[];
      }>,
  ) {
    const router = useRouter();
    const { navigateToSegment } = useProjectRouteActions({
      workspaceRef: props.workspaceRef,
      activeRootPath: props.activeRootPath,
      activeWorktreeId: props.activeWorktreeId,
    });
    const { onSelectPage } = props;
    const selectPage = React.useCallback(
      (page: ProjectPageV1) => {
        if (onSelectPage) onSelectPage(page);
        else navigateToSegment({ segment: page });
      },
      [navigateToSegment, onSelectPage],
    );
    const { checkout, changeCount } = useProjectShellCheckout(props);
    const pages = React.useMemo(
      (): readonly ProjectShellPage[] =>
        (props.pages ?? PROJECT_PAGES).map((page) =>
          page === 'changes' && changeCount > 0
            ? { id: page, count: String(changeCount) }
            : { id: page },
        ),
      [changeCount, props.pages],
    );

    const onNewSession = React.useCallback(() => {
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime) return;
      seedAndOpenNewSession({
        seed: {
          placement: {
            kind: 'exactTarget',
            serverId: props.workspaceRef.serverId,
            machineId: props.workspaceRef.machineId,
            directory: props.activeRootPath,
          },
        },
        scope: lifetime.scope,
        isCurrent: lifetime.isCurrent,
        navigateToNewSession: ({ draftId }) =>
          router.push({
            pathname: '/new',
            params: buildNewSessionLaunchRouteParams({ draftId }),
          }),
      });
    }, [
      props.activeRootPath,
      props.workspaceRef.machineId,
      props.workspaceRef.serverId,
      router,
    ]);

    return (
      <ProjectShellHeader
        projectName={resolveWorkspaceRefDisplayName(props.workspaceRef)}
        checkout={checkout}
        pages={pages}
        activePage={props.page}
        onSelectPage={selectPage}
        onNewSession={onNewSession}
        menuActions={props.menuActions ?? []}
      />
    );
  },
);

/** Phones (lab `p-overview` HOMEp): the checkout as one full-width row under the navigation bar. */
export const ProjectPhoneCheckoutRow = React.memo(
  function ProjectPhoneCheckoutRow(props: ProjectShellScope) {
    const { checkout } = useProjectShellCheckout(props);
    return (
      <ProjectCheckoutChip
        checkout={checkout}
        compact={false}
        presentation="row"
        testID="project-phone-checkout"
      />
    );
  },
);
