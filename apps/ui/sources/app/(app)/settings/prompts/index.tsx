import React from 'react';
import { PromptsSettingsHome } from '@/components/settings/prompts/PromptsSettingsHome';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function PromptsSettingsRoute() {
    const enabled = useFeatureEnabled('prompts.library');

    if (!enabled) {
        return null;
    }

    return <PromptsSettingsHome />;
});
