import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetLayoutFragmentOriginV1, WidgetLayoutGroupV1, WidgetProjectAreaV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { runCopyWidgetGroupCommandV1 } from '@/components/widgets/definitions/widgetLayoutFragmentCommands';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** Where a group can be copied: the Account's Home and each of its Projects, never where it already is. */
export type WidgetGroupCopyDestination = Readonly<{ key: string; label: string; surface: WidgetSurfaceRefV1; area?: WidgetProjectAreaV1 }>;

export function resolveWidgetGroupCopyDestinations(input: Readonly<{
    current: WidgetSurfaceRefV1;
    projects: readonly Readonly<{ projectId: string; label: string }>[];
}>): WidgetGroupCopyDestination[] {
    const account = { serverId: input.current.serverId, accountId: input.current.accountId };
    const owner = input.current.owner;
    return [
        ...(owner.kind === 'home' ? [] : [{ key: 'home', label: t('common.home'), surface: { ...account, owner: { kind: 'home' as const } } }]),
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
 * Add to… for a group (lab wgmenu M): a chooser of the Account's other places (Home, each Project);
 * choosing one adds a copy there as a fragment (`widgets.group.add`). Nothing is linked: later changes
 * to either group stay where they are made. Mounted only while open, so a closed menu reads nothing.
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
    const destinations = React.useMemo(() => resolveWidgetGroupCopyDestinations({ current: props.current, projects }), [projects, props.current]);
    const { group, name, onClose } = props;
    const copy = React.useCallback((key: string) => {
        const destination = destinations.find(entry => entry.key === key);
        onClose();
        if (!destination) return;
        void runCopyWidgetGroupCommandV1(group, destination.surface, destination.area ? { area: destination.area } : {}).then(outcome => {
            publishPresentationNotice({ key: `widget-group-copy:${group.id}`, severity: outcome.kind === 'refused' ? 'error' : 'info',
                message: outcome.kind === 'refused' ? t('widgetFrame.groupCopyFailed')
                    : outcome.kind === 'approvalPending' ? t('widgetAdd.areaApprovalPending')
                    : t('widgetFrame.groupCopied', { name, place: destination.label }) });
        });
    }, [destinations, group, name, onClose]);
    return (
        <DropdownMenu
            testID={props.testID}
            open
            onOpenChange={open => { if (!open) onClose(); }}
            popoverAnchorRef={props.anchorRef}
            items={destinations.map(destination => ({ id: destination.key, testID: `${props.testID}.${destination.key}`, title: destination.label,
                category: t('widgetFrame.groupAddTo') }))}
            selectedId={null}
            onSelect={copy}
        />
    );
}
