import { DaemonPluginStructuredMessageActionExecuteRequestSchema, type DaemonPluginStructuredMessageActionExecuteRequest } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import type { PluginActionInvocationSurfaceV2 } from '@happier-dev/plugin-sdk/actions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type MachinePluginActionExecuteOptions = Readonly<Omit<DaemonPluginStructuredMessageActionExecuteRequest, 'machineId' | 'executionSurface'> & {
    executionSurface: PluginActionInvocationSurfaceV2;
    serverId?: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime | null;
    isCurrent?: () => boolean;
}>;

/** Execution and observation borrow the same captured Account/Home authority. */
export function isMachinePluginActionScopeCurrent(opts: MachinePluginActionExecuteOptions): boolean {
    return opts.accountLifetime === undefined || (opts.accountLifetime?.isCurrent() === true
        && (!opts.serverId || areServerProfileIdentifiersEquivalent(opts.serverId, opts.accountLifetime.scope.serverId)));
}

/** One strict wire projection for daemon Action execution and dependency observation. */
export function buildMachinePluginActionExecuteRequest(machineId: string, opts: MachinePluginActionExecuteOptions): DaemonPluginStructuredMessageActionExecuteRequest {
    return DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
        machineId,
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        expectedContributorOccurrenceId: opts.expectedContributorOccurrenceId,
        qualifiedActionId: opts.qualifiedActionId,
        ...(opts.requiredReadOnly ? { requiredReadOnly: true } : {}),
        ...(opts.input === undefined ? {} : { input: opts.input }),
        ...(opts.selectedActionInputCarrier === undefined
            ? {}
            : { selectedActionInputCarrier: opts.selectedActionInputCarrier }),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.messageActionReference ? { messageActionReference: opts.messageActionReference } : {}),
        ...(opts.resolveClientMessageContext ? { resolveClientMessageContext: true } : {}),
        executionSurface: opts.executionSurface,
        ...(opts.invocation ? { invocation: opts.invocation } : {}),
        ...(opts.presentUserIntent ? { presentUserIntent: opts.presentUserIntent } : {}),
    });
}
