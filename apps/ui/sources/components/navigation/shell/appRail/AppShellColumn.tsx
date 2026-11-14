import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PluginAppPageColumn } from '@/components/appShell/plugins/PluginAppPageColumn';
import { ProjectsColumn } from '@/components/projects/ProjectsColumn';
import { DiscussionsColumn } from '@/components/discussions/DiscussionsColumn';
import { WorkflowsColumn } from '@/components/workflows/column/WorkflowsColumn';
import { BoardsColumn } from '@/components/boards/BoardsColumn';
import { PluginsNavigationColumn } from '@/components/settings/plugins/PluginsNavigationColumn';
import { SettingsSidebar } from '@/components/settings/shell/SettingsSidebar';
import { MachinesColumn } from '@/components/machines/collection/MachinesColumn';
import { ServicesColumn } from '@/components/projects/deployments/ServicesColumn';
import { PopoverScope } from '@/components/ui/popover';

import type { BuiltinAppShellColumnId } from '@/components/appShell/destinations/compactAppDestinationCatalog';

import { MainView } from '../MainView';
import type { AppShellColumn as AppShellColumnModel } from './appRailModel';

/**
 * The column beside the page, owned by the open destination (lab `xrail-R1*`): the grouped session
 * list for Sessions, the Discussions you can read for Discussions, the projects for Projects, what needs you, runs and your library for Workflows,
 * Installed/Browse and the installed plugins for Plugins, and the settings
 * navigation for Settings (a Home's console stands its own sidebar beside it, inside the page), and the
 * machine list for the Machines page's rail door, and the Projects with their Environments for Services. Only
 * the open destination's column is mounted, so a closed one keeps no subscriptions.
 */
export const AppShellColumn = React.memo(function AppShellColumn(props: Readonly<{
    column: AppShellColumnModel;
    /** Laid over another destination's page by a peek, rather than standing beside its own page. */
    peeked?: boolean;
}>) {
    const styles = stylesheet;
    const popoverBoundaryRef = React.useRef<View>(null);
    const { column } = props;
    if (column.kind === 'none') return null;
    const Column = column.kind === 'builtin' ? BUILTIN_COLUMNS[column.id] : null;
    const id = column.kind === 'builtin' ? column.id : column.destinationId;
    return (
        <View testID={`app-shell-column:${id}`} ref={popoverBoundaryRef} style={styles.column}>
            <PopoverScope boundaryRef={popoverBoundaryRef}>
                {Column ? <Column /> : null}
                {column.kind === 'plugin' ? <PluginAppPageColumn destinationId={column.destinationId} peeked={props.peeked === true} /> : null}
            </PopoverScope>
        </View>
    );
});

/** Sessions: the column's own entries (Browse external sessions, plugin session views) and the list. */
const SessionsColumn = React.memo(function SessionsColumn() {
    return <MainView variant="sidebar" />;
});

/** The only built-in column table: a column id the catalog knows without an entry here is a type error. */
const BUILTIN_COLUMNS = {
    sessions: SessionsColumn,
    discussions: DiscussionsColumn,
    projects: ProjectsColumn,
    workflows: WorkflowsColumn,
    boards: BoardsColumn,
    plugins: PluginsNavigationColumn,
    settings: SettingsSidebar,
    machines: MachinesColumn,
    services: ServicesColumn,
} satisfies Record<BuiltinAppShellColumnId, React.ComponentType>;

const stylesheet = StyleSheet.create(() => ({
    column: {
        flex: 1,
        minHeight: 0,
        overflow: 'visible',
    },
}));
