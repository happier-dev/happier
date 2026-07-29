import type { Href } from 'expo-router';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

import type {
    UsageCostMode,
    UsageDimension,
    UsageFilterState,
    UsageMetric,
} from '@/sync/api/account/usageAnalytics';
import { isUsagePeriod } from '@/sync/api/account/usagePeriods';

type RouteParamValue = string | string[] | undefined;

export type UsageRouteSearchParams = Readonly<Record<string, RouteParamValue>>;
export type UsageRouteWritableParams = Readonly<Record<
    'period' | 'metric' | 'costMode' | 'focusDimension' | 'focusKey' | 'focusLabel',
    string | undefined
>>;

const VALID_METRICS = new Set<UsageMetric>(['tokens', 'cost']);
const VALID_COST_MODES = new Set<UsageCostMode>(['auto', 'reported', 'estimated']);
const VALID_DIMENSIONS = new Set<UsageDimension>([
    'agent',
    'model',
    'session',
    'project',
    'workspace',
    'backendMode',
    'source',
]);

function readSingleParam(value: RouteParamValue): string | null {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' && value[0].trim().length > 0 ? value[0] : null;
    }
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function resolveUsagePanelInitialFilters(
    params: UsageRouteSearchParams,
): UsageFilterState {
    const periodValue = readSingleParam(params.period);
    const metricValue = readSingleParam(params.metric);
    const costModeValue = readSingleParam(params.costMode);
    const focusDimensionValue = readSingleParam(params.focusDimension);
    const focusKey = readSingleParam(params.focusKey);
    const focusLabel = readSingleParam(params.focusLabel);

    const period = isUsagePeriod(periodValue)
        ? periodValue
        : '7days';
    const metric = VALID_METRICS.has(metricValue as UsageMetric)
        ? (metricValue as UsageMetric)
        : 'tokens';
    const costMode = VALID_COST_MODES.has(costModeValue as UsageCostMode)
        ? (costModeValue as UsageCostMode)
        : 'auto';

    const focus = VALID_DIMENSIONS.has(focusDimensionValue as UsageDimension)
        && typeof focusKey === 'string'
        && typeof focusLabel === 'string'
        ? {
            dimension: focusDimensionValue as UsageDimension,
            key: focusKey,
            label: focusLabel,
        }
        : null;

    return {
        period,
        metric,
        costMode,
        focus,
    };
}

export function buildUsageSettingsRouteTarget(
    filters: Partial<UsageFilterState>,
): Href {
    const writableParams = buildUsageRouteParams(filters);
    const params: Record<string, string> = {};

    for (const [key, value] of Object.entries(writableParams)) {
        if (typeof value === 'string' && value.length > 0) {
            params[key] = value;
        }
    }

    return {
        pathname: SETTINGS_ROUTES.usage,
        params,
    };
}

export function buildUsageRouteParams(
    filters: Partial<UsageFilterState>,
): UsageRouteWritableParams {
    return {
        period: filters.period,
        metric: filters.metric,
        costMode: filters.costMode,
        focusDimension: filters.focus?.dimension,
        focusKey: filters.focus?.key,
        focusLabel: filters.focus?.label,
    };
}
