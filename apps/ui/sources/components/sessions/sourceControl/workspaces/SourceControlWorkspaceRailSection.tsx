import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { createNewSessionDraftForLocation } from '@/components/sessions/new/navigation/createNewSessionDraftForLocation';
import { useActiveServerWorkspaces } from '@/hooks/server/useActiveServerWorkspaces';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { ensureWorkspaceLocationGraph } from '@/sync/domains/workspaces/ensureWorkspaceLocationGraph';
import { saveNewSessionDraft } from '@/sync/domains/state/persistence';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { saveWorkspace, saveWorkspaceCheckout, saveWorkspaceLocation } from '@/sync/ops/workspaces';
import {
    useMachine,
    useProjectForSession,
    useSession,
    useWorkspace,
    useWorkspaceCheckout,
    useWorkspaceCheckouts,
    useWorkspaceLocation,
} from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/sessionUtils';

type SourceControlWorkspaceRailSectionProps = Readonly<{
    sessionId: string;
    scmSnapshot: ScmWorkingSnapshot | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveWorktreeDisplayName(input: Readonly<{
    branch: string | null | undefined;
    path: string;
}>): string {
    const branch = normalizeNonEmptyString(input.branch);
    if (branch) return branch;
    const segments = input.path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? input.path;
}

export const SourceControlWorkspaceRailSection = React.memo(function SourceControlWorkspaceRailSection(
    props: SourceControlWorkspaceRailSectionProps,
) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { serverId } = useActiveServerWorkspaces();
    const session = useSession(props.sessionId);
    const project = useProjectForSession(props.sessionId);

    const workspaceContext = React.useMemo(
        () =>
            readSessionWorkspaceContext(
                {
                    sessions: {
                        [props.sessionId]: {
                            metadata: {
                                path: session?.metadata?.path ?? null,
                                workspaceId: (session?.metadata as { workspaceId?: string | null } | undefined)?.workspaceId ?? null,
                                workspaceLocationId:
                                    (session?.metadata as { workspaceLocationId?: string | null } | undefined)?.workspaceLocationId ?? null,
                                workspaceCheckoutId:
                                    (session?.metadata as { workspaceCheckoutId?: string | null } | undefined)?.workspaceCheckoutId ?? null,
                            },
                        },
                    },
                    getProjectForSession: (sessionId: string) => (sessionId === props.sessionId ? project : null),
                },
                props.sessionId,
            ),
        [project, props.sessionId, session?.metadata],
    );

    const workspace = useWorkspace(workspaceContext.workspaceId ?? '');
    const workspaceLocation = useWorkspaceLocation(workspaceContext.workspaceLocationId ?? '');
    const workspaceCheckout = useWorkspaceCheckout(workspaceContext.workspaceCheckoutId ?? '');
    const workspaceCheckouts = useWorkspaceCheckouts(workspaceContext.workspaceId ?? '');
    const machine = useMachine(workspaceLocation?.machineId ?? workspaceContext.projectMachineId ?? '');

    const repoRootPath = normalizeNonEmptyString(props.scmSnapshot?.repo.rootPath);
    const currentPath =
        workspaceLocation?.path ??
        workspaceContext.workspacePath ??
        normalizeNonEmptyString(session?.metadata?.path) ??
        repoRootPath;
    const selectedMachineId =
        normalizeNonEmptyString(workspaceLocation?.machineId) ??
        normalizeNonEmptyString((session?.metadata as { machineId?: string | null } | undefined)?.machineId) ??
        workspaceContext.projectMachineId;
    const hasWorkspaceIdentity = Boolean(
        workspaceContext.workspaceId || workspaceContext.workspaceLocationId || workspaceContext.workspaceCheckoutId,
    );
    const canCreateWorkspace = Boolean(props.scmSnapshot?.repo.isRepo && currentPath && selectedMachineId);

    const handleOpenWorkspace = React.useCallback(() => {
        if (!workspace?.id) return;
        router.push(`/(app)/settings/workspaces/${workspace.id}` as any);
    }, [router, workspace?.id]);

    const handleCreateWorkspace = React.useCallback(async () => {
        if (!currentPath || !selectedMachineId) return;
        const ensured = await ensureWorkspaceLocationGraph({
            selectedMachineId,
            selectedPath: currentPath,
            serverId,
            saveWorkspace,
            saveWorkspaceLocation,
        });
        if (!ensured.workspaceId) return;
        router.push(`/(app)/settings/workspaces/${ensured.workspaceId}` as any);
    }, [currentPath, router, selectedMachineId, serverId]);

    if (!hasWorkspaceIdentity && !canCreateWorkspace) return null;

    const machineLabel = getMachineDisplayName(machine) ?? workspaceLocation?.machineId ?? workspaceContext.projectMachineId ?? undefined;
    const currentPathLabel = currentPath
        ? formatPathRelativeToHome(currentPath, session?.metadata?.homeDir)
        : t('status.unknown');
    const siblingCheckouts = workspaceCheckouts.filter((checkout) => checkout.id !== workspaceCheckout?.id);
    const linkedCheckoutPaths = new Set(workspaceCheckouts.map((checkout) => checkout.path));
    const unlinkedWorktrees = (props.scmSnapshot?.repo.worktrees ?? [])
        .filter((worktree) => !worktree.isCurrent)
        .filter((worktree) => !linkedCheckoutPaths.has(worktree.path));

    const handleAdoptWorktree = React.useCallback(async (worktree: Readonly<{
        path: string;
        branch: string | null;
    }>) => {
        if (!workspace?.id || !workspaceLocation?.id) return;
        await saveWorkspaceCheckout({
            workspaceId: workspace.id,
            workspaceLocationId: workspaceLocation.id,
            kind: 'git_worktree',
            path: worktree.path,
            displayName: resolveWorktreeDisplayName(worktree),
        }, { serverId });
    }, [serverId, workspace?.id, workspaceLocation?.id]);

    const handleCreateSessionFromWorktree = React.useCallback((worktreePath: string) => {
        if (!selectedMachineId) return;
        saveNewSessionDraft(
            createNewSessionDraftForLocation({
                machineId: selectedMachineId,
                path: worktreePath,
            }),
        );
        router.push('/new' as any);
    }, [router, selectedMachineId]);

    const handleCreateSessionFromCheckout = React.useCallback((checkoutPath: string) => {
        if (!selectedMachineId) return;
        saveNewSessionDraft(
            createNewSessionDraftForLocation({
                machineId: selectedMachineId,
                path: checkoutPath,
            }),
        );
        router.push('/new' as any);
    }, [router, selectedMachineId]);

    if (!hasWorkspaceIdentity) {
        return (
            <ItemGroup title={t('sessionInfo.workspaceTitle')}>
                <Item
                    testID="source-control-workspace-rail-create-workspace"
                    title={t('sourceControlWorkspace.createTitle')}
                    subtitle={t('sourceControlWorkspace.createSubtitle')}
                    detail={currentPathLabel}
                    icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.green} />}
                    onPress={handleCreateWorkspace}
                />
            </ItemGroup>
        );
    }

    return (
        <>
            <ItemGroup title={t('sessionInfo.workspaceTitle')}>
                <Item
                    testID="source-control-workspace-rail-workspace"
                    title={t('sessionInfo.workspaceLabel')}
                    subtitle={workspace?.displayName ?? workspaceContext.workspaceId ?? t('status.unknown')}
                    icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.accent.green} />}
                    onPress={workspace?.id ? handleOpenWorkspace : undefined}
                    showChevron={Boolean(workspace?.id)}
                />
                <Item
                    testID="source-control-workspace-rail-location"
                    title={t('sessionInfo.locationLabel')}
                    subtitle={currentPathLabel}
                    detail={machineLabel}
                    icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.indigo} />}
                    showChevron={false}
                />
                <Item
                    testID="source-control-workspace-rail-current-checkout"
                    title={t('sessionInfo.checkoutLabel')}
                    subtitle={workspaceCheckout?.displayName ?? workspaceContext.workspaceCheckoutId ?? t('status.unknown')}
                    detail={workspaceCheckout?.scm?.git?.branch ?? undefined}
                    icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.accent.purple} />}
                    onPress={workspaceCheckout?.path ? () => handleCreateSessionFromCheckout(workspaceCheckout.path) : undefined}
                />
            </ItemGroup>
            {siblingCheckouts.length > 0 ? (
                <ItemGroup title={t('sourceControlWorkspace.otherCheckoutsTitle')}>
                    {siblingCheckouts.map((checkout) => (
                        <Item
                            key={checkout.id}
                            testID={`source-control-workspace-rail-sibling-checkout-${checkout.id}`}
                            title={checkout.displayName}
                            subtitle={checkout.scm?.git?.branch ?? checkout.path}
                            detail={checkout.kind}
                            icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => handleCreateSessionFromCheckout(checkout.path)}
                        />
                    ))}
                </ItemGroup>
            ) : null}
            {workspace?.id && workspaceLocation?.id && unlinkedWorktrees.length > 0 ? (
                <ItemGroup title={t('sourceControlWorkspace.unlinkedWorktreesTitle')}>
                    {unlinkedWorktrees.map((worktree) => (
                        <React.Fragment key={worktree.path}>
                            <Item
                                testID={`source-control-workspace-rail-create-session-worktree-${worktree.path}`}
                                title={t('sourceControlWorkspace.createSessionInWorktreeTitle')}
                                subtitle={resolveWorktreeDisplayName(worktree)}
                                detail={formatPathRelativeToHome(worktree.path, session?.metadata?.homeDir)}
                                icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accent.green} />}
                                onPress={() => handleCreateSessionFromWorktree(worktree.path)}
                            />
                            <Item
                                testID={`source-control-workspace-rail-adopt-worktree-${worktree.path}`}
                                title={t('sourceControlWorkspace.adoptWorktreeTitle')}
                                subtitle={resolveWorktreeDisplayName(worktree)}
                                detail={formatPathRelativeToHome(worktree.path, session?.metadata?.homeDir)}
                                icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.accent.orange} />}
                                onPress={() => handleAdoptWorktree(worktree)}
                            />
                        </React.Fragment>
                    ))}
                </ItemGroup>
            ) : null}
        </>
    );
});

export default SourceControlWorkspaceRailSection;
