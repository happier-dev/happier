import * as React from 'react';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import type { ProjectsListModel } from './useProjectsListModel';
import { describeProjectSourceRow } from './sources/projectSourceAddress';

/** Saved Sources the "+" offers, already split: yours, then each Team's (lab p-projects RULES 9). */
export type ProjectsAddMenuSources = Readonly<{
    yours: readonly ProjectSourceV1[];
    teams: ReadonlyArray<Readonly<{ title: string; sources: readonly ProjectSourceV1[] }>>;
    onOpen: (source: ProjectSourceV1) => void;
    onManage: () => void;
}>;

/**
 * Where a project comes from (plan 10 §2, lab p-projects TREE "+"): a folder on a machine, a clone,
 * your saved Sources, then each Team's Sources, and Manage sources. Team Sources live only here and
 * in Sources; they never fill the sidebar. Without saved Sources it is the folder flow alone: with one
 * machine the "+" goes straight to its folder browser.
 */
export const ProjectsAddMenu = React.memo(function ProjectsAddMenu(props: Readonly<{
    machines: ProjectsListModel['addFirstMachines'];
    onAdd: ProjectsListModel['addProjectToMachine'];
    /** Clone a repository: the Open flow without a subject chosen yet. */
    onClone?: (() => void) | null;
    sources?: ProjectsAddMenuSources | null;
    /** Replaces the "+" trigger (the primary button of the "no project open" page). */
    renderTrigger?: (open: () => void) => React.ReactNode;
    testID: string;
}>) {
    const [open, setOpen] = React.useState(false);
    const { machines, onAdd, onClone, sources } = props;
    const sourceById = React.useMemo(() => new Map([
        ...(sources?.yours ?? []),
        ...(sources?.teams ?? []).flatMap((team) => team.sources),
    ].map((source) => [source.id, source] as const)), [sources]);
    const machineItems = React.useMemo((): DropdownMenuItem[] => machines.map((machine) => ({
        id: `machine:${machine.id}`,
        testID: `${props.testID}:machine:${machine.id}`,
        title: getMachineDisplayName(machine) ?? machine.metadata?.host ?? machine.id,
    })), [machines, props.testID]);
    const full = Boolean(onClone || sources);
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => {
        if (!full) return machineItems;
        const folder: DropdownMenuItem = machines.length === 1
            ? { id: `machine:${machines[0]!.id}`, testID: `${props.testID}:folder`, title: t('projects.identity.addFolder'), icon: <Icon name="folder-open" size={16} /> }
            : { id: 'folder', testID: `${props.testID}:folder`, title: t('projects.identity.addFolder'), icon: <Icon name="folder-open" size={16} />, submenu: { items: machineItems } };
        const sourceItem = (category: string) => (source: ProjectSourceV1): DropdownMenuItem => ({
            id: `source:${source.id}`,
            testID: `${props.testID}:source:${source.id}`,
            title: source.name,
            subtitle: describeProjectSourceRow(source),
            category,
            icon: <Icon name="git-branch" size={16} />,
        });
        return [
            ...(machines.length > 0 ? [{ ...folder, category: 'add' }] : []),
            ...(onClone ? [{ id: 'clone', testID: `${props.testID}:clone`, title: t('projects.identity.addClone'), icon: <Icon name="download" size={16} />, category: 'add' }] : []),
            ...(sources?.yours ?? []).map(sourceItem(t('projects.identity.yourSources'))),
            ...(sources?.teams ?? []).flatMap((team) => team.sources.map(sourceItem(team.title))),
            ...(sources ? [{ id: 'manage', testID: `${props.testID}:manage`, title: t('projects.identity.manageSources'), icon: <Icon name="books" size={16} />, category: 'manage' }] : []),
        ];
    }, [full, machineItems, machines, onClone, props.testID, sources]);
    const select = React.useCallback((itemId: string) => {
        setOpen(false);
        if (itemId.startsWith('machine:')) { void onAdd(itemId.slice('machine:'.length)); return; }
        if (itemId === 'clone') { onClone?.(); return; }
        if (itemId === 'manage') { sources?.onManage(); return; }
        if (itemId.startsWith('source:')) {
            const source = sourceById.get(itemId.slice('source:'.length));
            if (source) sources?.onOpen(source);
        }
    }, [onAdd, onClone, sourceById, sources]);
    if (!full && machines.length === 0) return null;
    const soleMachine = !full && machines.length === 1 ? machines[0]! : null;
    const renderTrigger = (toggle: () => void) => {
        const press = soleMachine ? () => { void onAdd(soleMachine.id); } : toggle;
        return props.renderTrigger ? props.renderTrigger(press) : (
            <IconButton
                testID={props.testID}
                iconName="plus"
                accessibilityLabel={t('projects.actions.addProject')}
                tooltip={t('projects.actions.addProject')}
                variant="plain"
                hasPopup={soleMachine ? undefined : 'menu'}
                expanded={soleMachine ? undefined : open}
                onPress={press}
            />
        );
    };
    return (
        <DropdownMenu
            testID={`${props.testID}:menu`}
            open={open && soleMachine === null}
            onOpenChange={setOpen}
            items={items}
            onSelect={select}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={320}
            showCategoryTitles={full}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => renderTrigger(toggle)}
        />
    );
});
