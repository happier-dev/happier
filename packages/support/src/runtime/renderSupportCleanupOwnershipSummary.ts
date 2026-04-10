import { describeBackgroundServiceTargetMode, type HappierService } from '@happier-dev/cli-common/happierRuntime';

import type { SupportMaintenanceContext } from './collectSupportMaintenanceContext.js';

export type SupportCleanupOwnershipSummary = Readonly<{
    title: string;
    lines: readonly string[];
}>;

function formatServiceLine(service: HappierService): string {
    const parts = [
        service.label,
        service.targetMode ? describeBackgroundServiceTargetMode(service.targetMode) : null,
        service.running ? 'running' : service.installed ? 'installed' : 'missing',
        service.ring ?? null,
        service.publicServerUrl ?? service.serverUrl ?? null,
    ].filter((part): part is string => Boolean(String(part ?? '').trim()));
    return parts.join(' • ');
}

export function renderSupportCleanupOwnershipSummary(
    context: SupportMaintenanceContext,
): SupportCleanupOwnershipSummary | null {
    const daemonServices = (context.services ?? []).filter((service) => service.serviceType === 'daemon');
    if (daemonServices.length === 0) {
        return null;
    }

    const warningCodes = new Set(context.warnings.map((warning) => warning.code));
    const lines = daemonServices.map(formatServiceLine);
    if (warningCodes.has('DAEMON_STARTED_WITH_DIFFERENT_CLI')) {
        lines.unshift('The currently running relay owner may differ from the CLI that you invoked.');
    }

    return {
        title: daemonServices.length === 1 ? 'Current background service' : 'Current background services',
        lines,
    };
}
