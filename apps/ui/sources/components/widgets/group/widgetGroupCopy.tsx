import * as React from 'react';
import type { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { WidgetLayoutFragmentOriginV1, WidgetLayoutGroupV1, WidgetProjectAreaV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { runCopyWidgetGroupCommandV1 } from '@/components/widgets/definitions/widgetLayoutFragmentCommands';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

/** Where a group or widget can be copied: the Account's Home, its WorkBoards when offered, and each Project, never where it already is. */
export type WidgetGroupCopyDestination = Readonly<{ key: string; label: string; surface: WidgetSurfaceRefV1; area?: WidgetProjectAreaV1 }>;

export function resolveWidgetGroupCopyDestinations(input: Readonly<{
    current: WidgetSurfaceRefV1;
    projects: readonly Readonly<{ projectId: string; label: string }>[];
    /** A single widget can also be placed on a WorkBoard; a group's copy cannot. */
    boards?: readonly Readonly<{ boardId: string; label: string }>[];
    publicProfileEnabled?: boolean;
}>): WidgetGroupCopyDestination[] {
    const account = { serverId: input.current.serverId, accountId: input.current.accountId };
    const owner = input.current.owner;
    return [
        ...(owner.kind === 'home' ? [] : [{ key: 'home', label: t('common.home'), surface: { ...account, owner: { kind: 'home' as const } } }]),
        ...(input.boards ?? []).filter(board => !(owner.kind === 'workBoard' && owner.boardId === board.boardId)).map((board): WidgetGroupCopyDestination => ({
            key: `board:${board.boardId}`, label: board.label, surface: { ...account, owner: { kind: 'workBoard', boardId: board.boardId } },
        })),
        ...(input.publicProfileEnabled && !(owner.kind === 'corePage' && owner.pageId === 'public-profile' && owner.area === 'main')
            ? [{ key: 'public-profile', label: t('publicIdentity.profile.title'), surface: { ...account,
                owner: { kind: 'corePage' as const, pageId: 'public-profile', area: 'main', layoutId: 'minimal' } } }] : []),
        ...input.projects.filter(project => !(owner.kind === 'project' && owner.projectId === project.projectId)).map((project): WidgetGroupCopyDestination => ({
            key: `project:${project.projectId}`, label: project.label, area: 'main',
            surface: { ...account, owner: { kind: 'project', projectId: project.projectId } },
        })),
    ];
}

/** The Account's Projects on one server, once each, by their display name. */
export function listWidgetGroupProjects(refs: ReturnType<typeof useWorkspaceRefs>, serverId: string): readonly Readonly<{ projectId: string; label: string }>[] {
    const seen = new Map<string, string>();
    for (const ref of Array.isArray(refs) ? refs : []) {
        if (ref.serverId !== serverId) continue;
        const identity = projectWorkspaceRefV1(ref);
        if (!seen.has(identity.projectKey)) seen.set(identity.projectKey, resolveWorkspaceRefDisplayName(ref));
    }
    return [...seen].map(([projectId, label]) => ({ projectId, label }));
}

function useCopyProjects(serverId: string): readonly Readonly<{ projectId: string; label: string }>[] {
    const refs = useWorkspaceRefs();
    return React.useMemo(() => listWidgetGroupProjects(refs, serverId), [refs, serverId]);
}

/**
 * Where a group is being saved from, as the person sees it now (the saved group keeps it as a fact:
 * "saved from Home on Oct 8"). Home needs no name; a Project is named as the copy chooser names it.
 */
export function describeWidgetGroupOrigin(surface: WidgetSurfaceRefV1, refs: ReturnType<typeof useWorkspaceRefs>): WidgetLayoutFragmentOriginV1 | undefined {
    const owner = surface.owner;
    if (owner.kind === 'home') return { kind: 'home' };
    if (owner.kind === 'project') {
        const name = listWidgetGroupProjects(refs, surface.serverId).find(project => project.projectId === owner.projectId)?.label;
        return { kind: 'project', ...(name ? { name } : {}) };
    }
    return owner.kind === 'pluginArea' || owner.kind === 'corePage' ? { kind: owner.kind } : undefined;
}

/**
 * The one Add to… chooser (lab wgmenu M), for a group and for a single widget: the Account's other
 * places, each by its mark and name, anchored to the ⋯ it came from. Choosing does not close it on
 * its own; the caller either copies and closes (a group) or moves on to the copy's setup (a widget),
 * so the hand-off never races the menu's close.
 */
export function WidgetCopyDestinationMenu(props: Readonly<{
    destinations: readonly WidgetGroupCopyDestination[];
    anchorRef: React.RefObject<View | null>;
    onChoose: (destination: WidgetGroupCopyDestination) => void;
    onClose: () => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const { destinations, onChoose, onClose } = props;
    return (
        <DropdownMenu
            testID={props.testID}
            open
            closeOnSelect={false}
            onOpenChange={open => { if (!open) onClose(); }}
            popoverAnchorRef={props.anchorRef}
            // Anchored to a ⋯, so the menu takes its own width, names itself and is a sheet on a phone.
            matchTriggerWidth={false}
            showCategoryTitles
            popoverAccessibilityLabel={t('widgetFrame.groupAddTo')}
            items={destinations.map(destination => ({ id: destination.key, testID: `${props.testID}.${destination.key}`, title: destination.label,
                category: t('widgetFrame.groupAddTo'),
                icon: <Icon name={destination.surface.owner.kind === 'home' ? 'house' : 'folder'} size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }))}
            selectedId={null}
            onSelect={key => { const destination = destinations.find(entry => entry.key === key); if (destination) onChoose(destination); }}
        />
    );
}

/**
 * Add to… for a group (lab wgmenu M): the shared chooser; choosing a place adds a copy there as a
 * fragment (`widgets.group.add`). Nothing is linked: later changes to either group stay where they
 * are made. Mounted only while open, so a closed menu reads nothing.
 */
export function WidgetGroupCopyChooser(props: Readonly<{
    group: WidgetLayoutGroupV1;
    name: string;
    current: WidgetSurfaceRefV1;
    anchorRef: React.RefObject<View | null>;
    onClose: () => void;
    testID: string;
}>) {
    const projects = useCopyProjects(props.current.serverId);
    const publicProfile = useFeatureDecision('account.publicProfiles', { scopeKind: 'spawn', serverId: props.current.serverId });
    const publicProfileEnabled = publicProfile?.state === 'enabled';
    const destinations = React.useMemo(() => resolveWidgetGroupCopyDestinations({ current: props.current, projects, publicProfileEnabled }), [projects, props.current, publicProfileEnabled]);
    const { group, name, onClose } = props;
    const copy = React.useCallback((destination: WidgetGroupCopyDestination) => {
        onClose();
        void runCopyWidgetGroupCommandV1(group, destination.surface, destination.area ? { area: destination.area } : {}).then(outcome => {
            publishPresentationNotice({ key: `widget-group-copy:${group.id}`, severity: outcome.kind === 'refused' ? 'error' : 'info',
                message: outcome.kind === 'refused' ? t('widgetFrame.groupCopyFailed')
                    : outcome.kind === 'approvalPending' ? t('widgetAdd.areaApprovalPending')
                    : t('widgetFrame.groupCopied', { name, place: destination.label }) });
        });
    }, [group, name, onClose]);
    return <WidgetCopyDestinationMenu destinations={destinations} anchorRef={props.anchorRef} onChoose={copy} onClose={onClose} testID={props.testID} />;
}
