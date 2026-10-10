import type { Href } from 'expo-router';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

import type {
    UsageCostMode,
    UsageDimension,
    UsageMetric,
} from '@/sync/api/account/usageAnalytics';
import { isUsagePeriod } from '@/sync/api/account/usagePeriods';
import { UsageQuerySchema } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageWidgetPageInitialFilters, UsageWidgetPageScope, UsageWidgetQueryOverrides } from './usageWidgetPageContext';

/** The route and page both project the same canonical input fields. */
export const UsageWidgetPageScopeSchema = UsageQuerySchema.pick({ period: true, agents: true, machines: true, projects: true, sources: true, session: true, costBasis: true });

export function parseUsageWidgetPageScope(value: unknown): UsageWidgetPageScope | null {
    const parsed = UsageWidgetPageScopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

type RouteParamValue = string | string[] | undefined;

export type UsageRouteSearchParams = Readonly<Record<string, RouteParamValue>>;
export type UsageRouteWritableParams = Readonly<Record<
    'period' | 'metric' | 'costMode' | 'focusDimension' | 'focusKey' | 'focusLabel' | 'scope' | 'layoutId' | 'queryOverrides',
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

/** Route transport for the existing non-context clauses, not another filter grammar. */
const UsageWidgetQueryOverridesSchema = UsageQuerySchema.omit({ period: true, agents: true, machines: true, projects: true,
    sources: true, session: true, costBasis: true, metric: true, breakdown: true });

function readSingleParam(value: RouteParamValue): string | null {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' && value[0].trim().length > 0 ? value[0] : null;
    }
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function resolveUsagePageInitialFilters(
    params: UsageRouteSearchParams,
): UsageWidgetPageInitialFilters {
    const periodValue = readSingleParam(params.period);
    const metricValue = readSingleParam(params.metric);
    const costModeValue = readSingleParam(params.costMode);
    const focusDimensionValue = readSingleParam(params.focusDimension);
    const focusKey = readSingleParam(params.focusKey);
    const focusLabel = readSingleParam(params.focusLabel);
    const scopeValue = readSingleParam(params.scope);
    const layoutId = readSingleParam(params.layoutId);
    const overridesValue = readSingleParam(params.queryOverrides);
    let queryOverrides: UsageWidgetQueryOverrides | undefined;
    if (overridesValue !== null) {
        try {
            const parsed = UsageWidgetQueryOverridesSchema.safeParse(JSON.parse(overridesValue));
            if (parsed.success) queryOverrides = parsed.data;
        } catch { /* Malformed canonical query clauses do not alter the admitted query. */ }
    }
    let scope = null;
    if (scopeValue !== null) {
        try { scope = parseUsageWidgetPageScope(JSON.parse(scopeValue)); } catch { /* Malformed route input has no admitted scope. */ }
    }

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
        ...(scope === null ? {} : { scope }),
        ...(layoutId === null ? {} : { layoutId }),
        ...(queryOverrides === undefined ? {} : { queryOverrides }),
    };
}

export function buildUsageSettingsRouteTarget(
    filters: Partial<UsageWidgetPageInitialFilters>,
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
    filters: Partial<UsageWidgetPageInitialFilters>,
): UsageRouteWritableParams {
    return {
        period: filters.period,
        metric: filters.metric,
        costMode: filters.costMode,
        focusDimension: filters.focus?.dimension,
        focusKey: filters.focus?.key,
        focusLabel: filters.focus?.label,
        scope: filters.scope === undefined ? undefined : JSON.stringify(filters.scope),
        layoutId: filters.layoutId,
        queryOverrides: filters.queryOverrides === undefined ? undefined : JSON.stringify(filters.queryOverrides),
    };
}
