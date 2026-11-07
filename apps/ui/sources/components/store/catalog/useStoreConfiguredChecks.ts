import * as React from 'react';
import { HealthCheckSourceConfigV1Schema, type HealthCheckSourceConfigV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import { readPluginEventAutomationPrivateDetail, type PluginEventAutomationStoredContentAccess } from '@/sync/domains/automations/pluginEventAutomationEditSeed';

/** Exact held configuration includes never-run subjects. Null is unknown, never evidence of no configured checks. */
export function useStoreConfiguredChecks(input: Readonly<{ definition: AutomationDefinition | null; triggerId: string;
    access: PluginEventAutomationStoredContentAccess }>): HealthCheckSourceConfigV1 | null {
    const { definition, triggerId } = input;
    const mode = input.access.mode;
    const material = input.access.mode === 'e2ee' ? input.access.material : undefined;
    return React.useMemo(() => {
        const detail = readPluginEventAutomationPrivateDetail(definition, triggerId,
            mode === 'plain' ? { mode } : { mode, material });
        if (detail?.trigger.eventRef.pluginId !== HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1) return null;
        const config = HealthCheckSourceConfigV1Schema.safeParse(detail.storedDefinition.sourceConfig);
        return config.success ? config.data : null;
    }, [definition, triggerId, mode, material]);
}
