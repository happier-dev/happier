import * as React from 'react';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import type { PoolUsageFreshness as PoolUsageFreshnessValue } from './derivePoolUsage';

export function PoolUsageFreshness(props: Readonly<{
    freshness: PoolUsageFreshnessValue;
    serviceTitle: string;
}>): React.ReactElement | null {
    if (props.freshness.asOf === null) return null;
    return props.freshness.notAnswering
        ? <SurfaceFreshnessLine asOf={props.freshness.asOf}
            reason={t('connectedServicesPool.usageNotAnswering', { service: props.serviceTitle })} presentation="chip" />
        : <SurfaceAsOfLabel at={props.freshness.asOf} />;
}
