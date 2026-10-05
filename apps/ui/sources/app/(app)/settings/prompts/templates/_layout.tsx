import * as React from 'react';

import { PromptCollectionLayout } from '@/components/settings/prompts/collection/PromptCollectionList';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';

/** `/settings/prompts/templates`: the collection beside the selected item's editor. */
const PromptTemplatesCollectionLayoutRoute = React.memo(function PromptTemplatesCollectionLayoutRoute() {
    return <PromptCollectionLayout kind="template" />;
});

export default createSettingsLayoutRoute(PromptTemplatesCollectionLayoutRoute, 'prompts/templates');
