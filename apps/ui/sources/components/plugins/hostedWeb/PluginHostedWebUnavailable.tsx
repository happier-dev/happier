import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export function PluginHostedWebUnavailable(): React.ReactElement {
    return (
        <SurfaceStateCard
            testID="plugin-hosted-web-unavailable"
            kind="unavailable"
            title={t('common.unavailable')}
            reason={t('pluginRuntime.unavailableGeneric')}
        />
    );
}
