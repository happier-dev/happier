import * as React from 'react';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

import { AgentCollectionList } from './collection/AgentCollectionList';
import { AgentSettingsHome } from './collection/AgentSettingsHome';
import { AgentAdministrationCatalogBoundary, useBoundaryAgentAdministrationCatalog } from './collection/AgentAdministrationCatalogBoundary';

/**
 * Beside the column the root is the Agents home (S30 §6.2); where the list is the page (a phone, a narrow pane) the root
 * is the column's own list. Explicit routes continue to own Agent details.
 */
export const AgentSettingsIndex = React.memo(function AgentSettingsIndex() {
    return <AgentAdministrationCatalogBoundary><AgentSettingsIndexBody /></AgentAdministrationCatalogBoundary>;
});

const AgentSettingsIndexBody = React.memo(function AgentSettingsIndexBody() {
    const view = useHappierCollectionIndexView();
    const catalog = useBoundaryAgentAdministrationCatalog();
    if (view === 'pending') return null;
    return view === 'land' ? <AgentSettingsHome catalog={catalog} /> : <AgentCollectionList variant="page" catalog={catalog} />;
});
