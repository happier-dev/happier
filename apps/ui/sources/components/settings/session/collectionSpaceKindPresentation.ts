import type { CollectionEntityKindV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { SERVICES_ROUTE } from '@/components/projects/deployments/deploymentNavigation';
import type { TranslationKeyNoParams } from '@/text';

type CollectionSpaceKindPresentation = Readonly<{
    /** The default space's name ("All workflows"). */
    defaultNameKey: TranslationKeyNoParams;
    /** Manage spaces page title ("Workflow spaces"). */
    manageTitleKey: TranslationKeyNoParams;
    /** The list the spaces narrow, and its title: where search opens the list's Filters. */
    listRoute: string;
    listTitleKey: TranslationKeyNoParams;
    settingsPageId: 'session' | 'settings';
}>;

/** What each saved-space list is called and where it lives; a new list kind fails to compile until it is named here. */
export const COLLECTION_SPACE_KIND_PRESENTATION = {
    sessionWork: { defaultNameKey: 'sessionsList.filtersMyWork', manageTitleKey: 'sessionsList.spacesManageSessions',
        listRoute: '/', listTitleKey: 'sessionsList.filtersTitle', settingsPageId: 'session' },
    review: { defaultNameKey: 'detailsSurface.review.title', manageTitleKey: 'sessionsList.spacesTitle',
        listRoute: '/reviews', listTitleKey: 'detailsSurface.review.title', settingsPageId: 'settings' },
    workflow: { defaultNameKey: 'sessionsList.spacesAllWorkflows', manageTitleKey: 'sessionsList.spacesManageWorkflows',
        listRoute: '/workflows', listTitleKey: 'workflows.title', settingsPageId: 'settings' },
    workflowRun: { defaultNameKey: 'workflows.destination.allRuns', manageTitleKey: 'workflows.destination.display.runSpaces',
        listRoute: '/workflows/runs', listTitleKey: 'workflows.destination.allRuns', settingsPageId: 'settings' },
    discussion: { defaultNameKey: 'sessionsList.spacesAllDiscussions', manageTitleKey: 'sessionsList.spacesManageDiscussions',
        listRoute: '/discussions', listTitleKey: 'session.collaboration.discussion.title', settingsPageId: 'settings' },
    deploymentEnvironment: { defaultNameKey: 'projects.deployments.services.allServices', manageTitleKey: 'sessionsList.spacesManageServices',
        listRoute: SERVICES_ROUTE, listTitleKey: 'projects.deployments.services.title', settingsPageId: 'settings' },
} as const satisfies Record<CollectionEntityKindV1, CollectionSpaceKindPresentation>;
