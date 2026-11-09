import { machineCapabilitiesDescribe } from '@/sync/ops/capabilities';
import { readExecutionRunProtocolV2Support } from '@happier-dev/protocol/execution/runs/protocolSupport';

/**
 * Whether an exact machine can host a truly detached Execution Run.
 *
 * This is the one owner of that question for the UI. The `execution.run.*`
 * Action transport already asks it before it will dispatch a detached-scope
 * call; a surface that offers the detached runtime must ask the *same* owner
 * rather than carry a standing policy constant or invent a feature bit.
 */

export type DetachedExecutionRunSupport =
    | 'supported'
    | 'unsupported'
    /** No exact machine has been selected yet, so there is nothing to ask. */
    | 'machine_not_selected'
    /** The probe has not answered yet, or could not be reached. */
    | 'unknown';

/**
 * Asks the canonical machine-capability owner about one exact machine.
 *
 * Failure is reported as `unknown`, never as `unsupported`: an unreachable
 * probe is not evidence that the machine lacks the capability, and presenting
 * it as a refusal would be the same fabrication the truthful-availability rule
 * exists to prevent.
 */
export async function detectDetachedExecutionRunSupport(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    signal?: AbortSignal;
}>): Promise<DetachedExecutionRunSupport> {
    if (params.machineId === null || params.machineId.trim().length === 0) {
        return 'machine_not_selected';
    }
    try {
        const capability = await machineCapabilitiesDescribe(
            params.machineId,
            {
                ...(params.serverId ? { serverId: params.serverId } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            },
        );
        const support = readExecutionRunProtocolV2Support(capability, {
            detachedScope: true, startAndWait: true, exactInputResults: false,
            runScopedAgentBindings: false, secretReferenceOverlay: false,
        }, params.signal);
        return support.ok ? 'supported' : support.errorCode === 'execution_run_protocol_unsupported' ? 'unsupported' : 'unknown';
    } catch {
        return 'unknown';
    }
}
