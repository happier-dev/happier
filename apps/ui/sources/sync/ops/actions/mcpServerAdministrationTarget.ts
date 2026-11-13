import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, readSelectedMachineAdministrationTarget } from '@/sync/domains/machines/administration/selectionPreferences';
import { readMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';
import { resolveUiAccountActionFallbackMachineId } from './accountActionDeps';

/** MCP's one Administration admission path, shared by Actions and credential readers. */
export function resolveMcpServerAdministrationMachineId(
    scope: ServerAccountScope,
    options: Readonly<{ intent?: 'retry'; target?: ActionExecutorContext['externalActionTarget'] }> = {},
): string | null {
    if (options.target?.kind === 'machine') return options.target.machineId.trim() || null;
    const selectionKey = MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers;
    const selected = readSelectedMachineAdministrationTarget(storage.getState().settings.machineAdministrationTargetsLocalV1,
        selectionKey, readMachineAdministrationTargetObservation(scope, selectionKey));
    if (!selected) return resolveUiAccountActionFallbackMachineId(scope);
    const target = resolveFreshMachineAdministrationExecutionTarget(selected, { accountScope: scope, intent: options.intent });
    return target && areServerProfileIdentifiersEquivalent(target.profile.id, scope.serverId) ? target.machine.id : null;
}
