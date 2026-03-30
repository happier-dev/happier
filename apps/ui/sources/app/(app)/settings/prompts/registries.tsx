import React from 'react';
import { PromptRegistriesScreen } from '@/components/settings/prompts/registries/PromptRegistriesScreen';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function PromptRegistriesRoute() {
    const enabled = useFeatureEnabled('prompts.skills.registries');

    if (!enabled) {
        return null;
    }

    return <PromptRegistriesScreen />;
});
