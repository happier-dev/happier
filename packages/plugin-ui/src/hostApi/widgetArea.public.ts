import { useMemo } from 'react';
import type { PluginUiWidgetAreaOperationV1, PluginUiWidgetAreaRequestV1, PluginUiWidgetAreaResultV1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { usePluginHostApi } from './context.js';

/** Presentation consumes this port; it owns no catalog, input resolver or layout state. */
export type PluginUiWidgetAreaPortV1 = Readonly<{
    execute(operation: PluginUiWidgetAreaOperationV1, context?: PluginUiWidgetAreaRequestV1['context'], options?: PluginCancellationOptions): Promise<PluginUiWidgetAreaResultV1>;
}>;
export function useWidgetAreaPort(area: string): PluginUiWidgetAreaPortV1 {
    const host = usePluginHostApi();
    return useMemo<PluginUiWidgetAreaPortV1>(() => ({ execute: (operation, context, options) => host.widgetArea({ area, operation, ...(context === undefined ? {} : { context }) }, options) }), [host, area]);
}
