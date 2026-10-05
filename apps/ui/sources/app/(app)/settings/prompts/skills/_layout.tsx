import * as React from 'react';

import { PromptCollectionLayout } from '@/components/settings/prompts/collection/PromptCollectionList';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';

/** `/settings/prompts/skills`: the collection beside the selected item's editor. */
const PromptSkillsCollectionLayoutRoute = React.memo(function PromptSkillsCollectionLayoutRoute() {
    return <PromptCollectionLayout kind="bundle" />;
});

export default createSettingsLayoutRoute(PromptSkillsCollectionLayoutRoute, 'prompts/skills');
