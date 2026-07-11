import * as React from 'react';

import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import type { ManagedLocalServiceRow as ManagedLocalServiceStoreRow } from '@/sync/domains/local/services/managed/store';

import { resolveManagedStatusLabel } from '@/sync/domains/local/services/presentation';

const MANAGED_STATUS_VARIANTS: Readonly<Record<ManagedLocalServiceStoreRow['phase'], StatusPillVariant>> = {
    starting: 'info',
    detecting: 'info',
    running: 'success',
    unhealthy: 'warning',
    stopping: 'warning',
    stopped: 'neutral',
    failed: 'danger',
};

export function ManagedLocalServiceStatus(props: Readonly<{
    phase: ManagedLocalServiceStoreRow['phase'];
    testID: string;
}>): React.ReactElement {
    const label = resolveManagedStatusLabel(props.phase);
    return (
        <StatusPill
            testID={`${props.testID}-status-${props.phase}`}
            variant={MANAGED_STATUS_VARIANTS[props.phase]}
            label={label}
            isPulsing={props.phase === 'running' || props.phase === 'detecting'}
        />
    );
}
