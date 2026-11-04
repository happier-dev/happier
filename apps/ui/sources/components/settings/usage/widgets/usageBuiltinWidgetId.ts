import { USAGE_BUILTIN_WIDGET_IDS_V1, type UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';

/** Membership belongs to the descriptor catalog, independently of rendered widget bodies. */
export function isUsageBuiltinWidgetId(id: string): id is UsageBuiltinWidgetIdV1 {
    return USAGE_BUILTIN_WIDGET_IDS_V1.some(candidate => candidate === id);
}
