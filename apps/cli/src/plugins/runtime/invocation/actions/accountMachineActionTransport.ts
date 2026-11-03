import { PluginError } from '@happier-dev/plugin-sdk';
import type { TargetedContributionManifestDeclaration } from '@happier-dev/cli-common/plugins/registration';
import { DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginUiTargetedContributionsReadResponseSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { callExactMachineRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import type { StoredCredentials } from '@/persistence';
import type { InvokeContributedAction } from '../services/actions';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginSourceCustody } from '../../sourceAuthority';
import { observeAccountMachineActionRead } from './accountMachineReadObservation';

type AccountMachineTransport = Readonly<{ credentials: StoredCredentials; serverUrl: string; machineId: string }>;

/** Reads the existing Machine projection without inventing an Account mount there. */
export async function readAccountMachineSourceDeclarations(input: AccountMachineTransport & Readonly<{
    targetPluginId: string; signal?: AbortSignal;
}>): Promise<readonly TargetedContributionManifestDeclaration[]> {
    const request = DaemonPluginUiTargetedContributionsReadRequestSchema.parse({ machineId: input.machineId,
        pluginId: input.targetPluginId, readMode: 'sourceDeclarations' });
    const result = DaemonPluginUiTargetedContributionsReadResponseSchema.parse(await callExactMachineRpc({
        credentials: input.credentials, serverUrl: input.serverUrl, machineId: input.machineId,
        method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ, request,
        requireCurrentMachine: true, timeoutMs: null, ...(input.signal ? { signal: input.signal } : {}),
    }));
    if (result.status !== 'sourceDeclarations' || result.pluginId !== input.targetPluginId) {
        throw new PluginError({ code: result.status === 'unavailable' ? result.code : 'plugin_targeted_contributions_unavailable',
            message: 'Current Machine source declarations are unavailable' });
    }
    return result.sourceDeclarations;
}

/** Transports to the incumbent final Action owner; it never evaluates Machine code locally. */
export async function invokeAccountMachineSourceAction(input: AccountMachineTransport & Readonly<{
    request: Parameters<InvokeContributedAction>[0];
    callerManifest: CanonicalPluginManifest;
    callerSourceCustody: PluginSourceCustody;
    source: TargetedContributionManifestDeclaration;
}>): ReturnType<InvokeContributedAction> {
    const caller = input.request.caller;
    const contributionLocalId = caller.contribution?.id;
    if (!contributionLocalId || !caller.occurrenceId) return { status: 'unavailable',
        code: 'plugin_action_caller_unavailable', message: 'Current Account caller is unavailable', actionHandlerInvocation: 'notStarted' };
    await input.request.beforeHandlerInvocation?.();
    const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({ machineId: input.machineId,
        qualifiedActionId: buildQualifiedPluginContributionKey(input.request.action), input: input.request.input,
        ...(input.request.requiredReadOnly || input.request.readObservation ? { requiredReadOnly: true } : {}),
        executionSurface: input.request.originSurface === 'agent' ? 'agent' : input.request.originSurface === 'mcp' ? 'mcp' : 'cli',
        expectedContributorOccurrenceId: input.source.occurrenceId,
        ...(input.request.sessionId ? { sessionId: input.request.sessionId } : {}),
        invocation: { kind: 'clientPluginAction', clientActionBinding: {
            pluginId: input.callerManifest.id, pluginVersion: input.callerManifest.version,
            contributionLocalId, occurrenceId: caller.occurrenceId, sourceCustody: input.callerSourceCustody,
        } },
    });
    if (input.request.readObservation) return await observeAccountMachineActionRead({ credentials: input.credentials,
        serverUrl: input.serverUrl, machineId: input.machineId, targetPluginId: input.request.action.pluginId,
        request, signal: input.request.signal, observation: input.request.readObservation });
    try {
        const result = DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await callExactMachineRpc({
            credentials: input.credentials, serverUrl: input.serverUrl, machineId: input.machineId,
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, request,
            authorityCeiling: 'account_automation', requireCurrentMachine: true, timeoutMs: null,
            waitForResultOnCancel: true, signal: input.request.signal,
        }));
        return result.ok ? { status: 'executed', value: result.result }
            : { status: 'failed', code: result.code, message: result.message ?? result.code,
                ...(result.retryable === undefined ? {} : { retryable: result.retryable }) };
    } catch (error) {
        if (readMachineRpcRequestDisposition(error) === 'notSent') return {
            status: 'unavailable', code: 'plugin_action_execution_origin_unavailable',
            message: 'The selected Machine is unavailable', actionHandlerInvocation: 'notStarted',
        };
        // The transport may have emitted the request. No fallback or automatic
        // replay can turn a missing acknowledgement into another provider effect.
        return { status: 'failed', code: 'plugin_action_outcome_unknown', message: 'The Machine Action outcome is unknown' };
    }
}
