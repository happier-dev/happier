import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resolveUiAccountActionFallbackMachineId } from './accountActionDeps';

/** MCP's one Administration admission path, shared by Actions and credential readers. */
export function resolveMcpServerAdministrationMachineId(
    scope: ServerAccountScope,
    options: Readonly<{ intent?: 'retry'; target?: ActionExecutorContext['externalActionTarget'] }> = {},
): string | null {
    if (options.target?.kind === 'machine') return options.target.machineId.trim() || null;
    const selected = storage.getState().settings.machineAdministrationTargetsLocalV1[MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers] ?? null;
    if (!selected) return resolveUiAccountActionFallbackMachineId(scope);
    const target = resolveFreshMachineAdministrationExecutionTarget(selected, { accountScope: scope, intent: options.intent });
    return target && areServerProfileIdentifiersEquivalent(target.profile.id, scope.serverId) ? target.machine.id : null;
}
