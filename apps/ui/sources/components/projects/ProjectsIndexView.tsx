import * as React from 'react';
import { View } from 'react-native';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useDeviceType } from '@/utils/platform/responsive';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { t } from '@/text';

import { ProjectsAddMenu } from './ProjectsAddMenu';
import { useOpenNewApp } from './starters/newAppPresentation';
import { ProjectOpenResolutionCard, useProjectRowsRetry } from './ProjectOpenResolution';
import { ProjectsListView } from './ProjectsListView';
import { useProjectsListModel } from './useProjectsListModel';

/**
 * `/projects`. Beside the Projects column the column is the list, so the page says no project is open
 * and offers to add one (a rail and its detail never both show the full state). Without the column —
 * collapsed, or on a phone — the page is the list.
 */
export const ProjectsIndexView = React.memo(function ProjectsIndexView() {
    const columnVisible = useAppShellColumn().columnVisible;
    // A retained workspace tab stays mounted for an instant return, but its demand ends while it is not
    // presented: the page's live Projects model suspends until the tab is shown again.
    const presented = useLayoutPresentationActive();
    const phone = useDeviceType() === 'phone';
    const safeAreaTop = useChromeSafeAreaInsets().top;
    return <RetainedPanelSurface isActive={presented} hiddenMode="activity">
        {columnVisible ? <ProjectsNoneOpen /> : phone ? (
            // A phone's /projects is the Projects tab: its main-screen head opens on the Home line (owner 11-11).
            <View style={{ flex: 1, paddingTop: safeAreaTop }}>
                <ProjectsListView />
            </View>
        ) : <ProjectsListView />}
    </RetainedPanelSurface>;
});

const ProjectsNoneOpen = React.memo(function ProjectsNoneOpen() {
    const model = useProjectsListModel();
    // The same "+" as the column: a folder, a clone, your Sources, each Team's, Manage (plan 10 §2).
    const { addSources, cloneRepository } = model;
    const openNewApp = useOpenNewApp(cloneRepository);
    // A saved Source leads only while it is all there is; once Projects exist the page says what its
    // copy says ("choose one from the list, or add one") and its one action is the same "+".
    const firstSaved = model.hasAnyProjects || model.deployOnlyCount > 0 ? null : model.saved?.items[0] ?? null;
    const hasContent = model.hasAnyProjects || model.deployOnlyCount > 0 || Boolean(model.saved?.items.length);
    const rowsRetry = useProjectRowsRetry();
    if (model.rowsUnconfirmed) {
        return (
            <View testID="projects-none-open" style={{ flex: 1, justifyContent: 'center' }}>
                <ProjectOpenResolutionCard testID="projects-none-open:rows" page issue={model.rowsUnconfirmed}
                    onChoose={() => {}} onRetry={rowsRetry} />
            </View>
        );
    }
    return (
        <View testID="projects-none-open" style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
                layout="page"
                scene="noProjects"
                title={hasContent ? t('projects.noneOpenTitle') : t('projects.emptyTitle')}
                subtitle={hasContent ? t('projects.noneOpenDescription') : t('projects.emptyDescription')}
                action={(
                    <>
                    {firstSaved ? <RoundButton testID="projects-none-open:open-source" size="normal"
                        title={`${t('common.open')} ${firstSaved.title}`}
                        action={async () => { model.saved?.onOpen(firstSaved.key); }} /> : null}
                    {!firstSaved ? <ProjectsAddMenu
                        testID="projects-none-open:add"
                        machines={model.addFirstMachines}
                        onAdd={model.addProjectToMachine}
                        onClone={cloneRepository}
                        onNewApp={openNewApp}
                        sources={addSources}
                        fromSessions={model.fromSessions}
                        // The page's one primary action, drawn as the empty state draws it.
                        renderTrigger={firstSaved ? undefined : (open) => (
                            <RoundButton
                                testID="projects-none-open:add-button"
                                size="normal"
                                title={t('projects.actions.addProject')}
                                accessibilityLabel={t('projects.actions.addProject')}
                                action={async () => { open(); }}
                            />
                        )}
                    /> : null}
                    </>
                )}
            />
        </View>
    );
});
