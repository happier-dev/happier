import * as React from 'react';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { useProjectPickerOptions } from '@/components/projects/useProjectPickerOptions';
import { storeProjectRouteParams } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { SelectionList, SelectionListFilterChip } from '@/components/ui/selectionList';
import { t } from '@/text';

/** Header wiring only; the Project choices and chip/picker anatomy retain their existing owners. */
export function StoreProjectScopeChip() {
    const { project, workspaceRef, setProject } = useStoreProjectScope();
    return <SelectionListFilterChip filter={{ id: 'store-project', testID: 'store.projectScope',
        label: t('storeInstalled.groupProject'),
        valueLabel: workspaceRef ? resolveWorkspaceRefDisplayName(workspaceRef) : t('capabilities.store.allProjects'),
        renderPopoverContent: ({ close }) => <StoreProjectPicker project={project} onClose={close} onSelect={next => { setProject(next); close(); }} />,
    }} />;
}

/** Only the open picker projects the offered list; closed header chrome reads its selected row. */
function StoreProjectPicker(props: Readonly<{ project: QualifiedProjectKeyV1 | null; onClose: () => void; onSelect: (project: QualifiedProjectKeyV1 | null) => void }>) {
    const projects = useProjectPickerOptions();
    const options = projects.map(project => ({ id: storeProjectRouteParams(project).project!, label: project.label }));
    return <SelectionList
        testID="store.projectPicker"
        listAccessibilityLabel={t('storeInstalled.groupProject')}
        onRequestClose={props.onClose}
        rootStep={{ id: 'store-projects', sections: [{ kind: 'static', id: 'projects', options: [
            { id: 'all', label: t('capabilities.store.allProjects') }, ...options,
        ] }] }}
        selectedOptionId={props.project ? storeProjectRouteParams(props.project).project : 'all'}
        onSelect={id => {
            if (id === 'all') props.onSelect(null);
            else {
                const index = options.findIndex(option => option.id === id);
                const project = projects[index];
                if (project) props.onSelect({ serverId: project.serverId, projectKey: project.projectKey });
            }
        }}
    />;
}
