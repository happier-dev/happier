import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol';
import { HappyError } from '@/utils/errors/errors';
import type { UsageQueryParams } from './apiUsage';

export function buildUsageFocusFilters(focus?: UsageQueryParams['focus']): UsageAnalyticsQueryRequest['filters'] | undefined {
    if (!focus) {
        return undefined;
    }

    switch (focus.dimension) {
        case 'agent':
            return { agentIds: [focus.key] };
        case 'model':
            return { modelIds: [focus.key] };
        case 'session':
            return { sessionIds: [focus.key] };
        case 'project':
            return { projectKeys: [focus.key] };
        case 'machine':
            return { machineIds: [focus.key] };
        case 'workspace':
            return { workspaceIds: [focus.key] };
        case 'backendMode':
            return { backendModes: [focus.key] };
        case 'source':
            return { sources: [focus.key] };
        default:
            throw new HappyError('Unsupported usage filter', false, { kind: 'config', code: 'usage_filter_unsupported' });
    }
}
