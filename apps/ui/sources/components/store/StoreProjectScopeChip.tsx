import * as React from 'react';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { usePresentedProjectPicker } from '@/components/projects/useProjectPickerOptions';
import { PROJECT_PICKER_THEME_SURFACE } from '@/components/projects/projectPickerThemeSurface';
import { storeProjectRouteParams } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { SelectionList, SelectionListFilterChip } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/** The chip's and its list's mounted commands: an agent opens it and chooses the scope as a person does. */
const STORE_PROJECT_COMMAND_SCOPE = 'store.projectScope';

/**
 * Header wiring only; the Project choices and chip/picker anatomy retain their existing owners. The one chip heads
 * Discover, Installed, every kind page, Search and Updates.
 */
export function StoreProjectScopeChip() {
    const { project, workspaceRef, setProject } = useStoreProjectScope();
    return <SelectionListFilterChip currentUiContextCommandScope={STORE_PROJECT_COMMAND_SCOPE} filter={{ id: 'store-project', testID: 'store.projectScope',
        label: t('storeInstalled.groupProject'),
        valueLabel: workspaceRef ? resolveWorkspaceRefDisplayName(workspaceRef) : t('capabilities.store.allProjects'),
        renderPopoverContent: ({ close }) => <StoreProjectPicker project={project} onClose={close} onSelect={next => { setProject(next); close(); }} />,
    }} />;
}

/**
 * Only the open picker projects the offered list; closed header chrome reads its selected row. Mounted only while the
 * chip's menu is open, it joins the Account's census once and says so until the census is confirmed.
 */
function StoreProjectPicker(props: Readonly<{ project: QualifiedProjectKeyV1 | null; onClose: () => void; onSelect: (project: QualifiedProjectKeyV1 | null) => void }>) {
    const { projects, status } = usePresentedProjectPicker(true);
    const options = projects.map(project => ({ id: storeProjectRouteParams(project).project!, label: project.label }));
    return <SelectionList
        themeSurface={PROJECT_PICKER_THEME_SURFACE}
        testID="store.projectPicker"
        currentUiContextCommandScope={`${STORE_PROJECT_COMMAND_SCOPE}.list`}
        currentUiContextForegroundOverlay
        listAccessibilityLabel={t('storeInstalled.groupProject')}
        {...(status === 'ready' ? {} : { contentState: (
            <SurfaceStateCard testID="store.projectPicker.status" size="line" kind={status === 'loading' ? 'loading' : 'unavailable'}
                title={t(status === 'loading' ? 'projects.identity.rowsLoadingTitle' : 'projects.identity.rowsUnavailableTitle')} />
        ) })}
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
