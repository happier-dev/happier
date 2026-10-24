import React from 'react';

import { CodeIntelligenceScreen } from '@/components/codeIntelligence/CodeIntelligenceScreen';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function CodeIntelligenceRoute() {
    const enabled = useFeatureEnabled('codeIntelligence');

    if (!enabled) {
        return null;
    }

    return <CodeIntelligenceScreen />;
});
