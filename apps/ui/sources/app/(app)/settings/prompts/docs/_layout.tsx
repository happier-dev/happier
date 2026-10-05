import * as React from 'react';

import { PromptCollectionLayout } from '@/components/settings/prompts/collection/PromptCollectionList';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';

/** `/settings/prompts/docs`: the collection beside the selected item's editor. */
const PromptDocsCollectionLayoutRoute = React.memo(function PromptDocsCollectionLayoutRoute() {
    return <PromptCollectionLayout kind="doc" />;
});

export default createSettingsLayoutRoute(PromptDocsCollectionLayoutRoute, 'prompts/docs');
