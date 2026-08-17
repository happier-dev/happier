import * as React from 'react';
import type { PluginUiToneV1 } from '@happier-dev/protocol/plugins/ui';

import type { CompactAppDestination } from './compactAppDestinationCatalog';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';

const STATUS_VARIANT_BY_PLUGIN_TONE: Readonly<Record<PluginUiToneV1, StatusPillVariant>> = {
    neutral: 'neutral',
    info: 'info',
    success: 'success',
    warning: 'warning',
    danger: 'danger',
    accent: 'info',
};

/** One host presentation of static compact-destination badge metadata. */
export function CompactAppDestinationBadge(props: Readonly<{
    destination: CompactAppDestination;
    testID?: string;
}>): React.ReactElement | null {
    const badge = props.destination.kind === 'plugin' ? props.destination.badge : undefined;
    if (!badge) {
        return null;
    }
    return (
        <StatusPill
            testID={props.testID}
            variant={STATUS_VARIANT_BY_PLUGIN_TONE[badge.tone]}
            label={badge.label}
            hideDot
            labelNumberOfLines={1}
        />
    );
}
