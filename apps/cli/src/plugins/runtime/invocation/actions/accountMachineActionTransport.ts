import type { TargetedContributionManifestDeclaration } from '@happier-dev/cli-common/plugins/registration';
import { PluginError } from '@happier-dev/plugin-sdk';
import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { projectPluginActionFailureCode } from '@happier-dev/protocol/plugins/actions/invocation';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readActionSessionTargetOperands } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { normalizeSessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { callExactMachineRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveSessionInputTargetMachineId } from '@/session/services/sessionInputAdmissionIdentity';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import type { InvokeContributedAction } from '../services/actions';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginSourceCustody } from '../../sourceAuthority';
import { observeAccountMachineActionRead } from './accountMachineReadObservation';

type AccountMachineTransport = Readonly<{ credentials: StoredCredentials; serverUrl: string; machineId: string }>;

/** Declared and host-attached Session sources belong to that Session's Machine. */
export async function resolveAccountMachineSourceActionMachine(input: Omit<AccountMachineTransport, 'machineId'> & Readonly<{
    machineId?: string;
    /** An explicit host Machine or Execution Run takes precedence over Session-derived placement. */
    explicitMachineId?: string;
    /** Containing Session admitted by the host, never an authored entry operand. */
    defaultSessionId?: string;
    declaration: CanonicalPluginManifest['contributes']['actions'][number]['sessionTarget'];
    input: unknown;
    signal?: AbortSignal;
}>): Promise<Readonly<{ status: 'available'; machineId?: string }
    | { status: 'unavailable'; code: string; message: string; actionHandlerInvocation: 'notStarted' }>> {
    if (input.explicitMachineId) return { status: 'available', machineId: input.explicitMachineId };
    const value = input.input;
    const operands = input.declaration?.cardinality === 'one' && value && typeof value === 'object' && !Array.isArray(value)
        ? readActionSessionTargetOperands(value as Readonly<Record<string, unknown>>, input.declaration.field) : [];
    // Preserve an already selected Machine. Otherwise an entry Action can use
    // its containing Session without fabricating an authored Session operand.
    if (operands.length === 0 && (input.machineId || !input.defaultSessionId)) return { status: 'available', ...(input.machineId ? { machineId: input.machineId } : {}) };
    const target = operands.length === 0 ? input.defaultSessionId
        : operands.length === 1 ? normalizeSessionTargetV1(operands[0]!.value) : null;
    if (typeof target !== 'string') return { status: 'unavailable', code: 'session_target_unavailable',
        message: 'A concrete Session source target is required', actionHandlerInvocation: 'notStarted' };
    const transport = await runWithServerHttpBaseUrl(input.serverUrl, () => resolveSessionTransportContext({
        reason: 'session-action', credentials: input.credentials, idOrPrefix: target, exact: true,
        ...(input.signal ? { signal: input.signal } : {}),
    }));
    if (!transport.ok) return { status: 'unavailable', code: transport.code,
        message: 'The Session source target is unavailable', actionHandlerInvocation: 'notStarted' };
    const machineId = resolveSessionInputTargetMachineId({ rawSession: transport.rawSession,
        decryptedMetadata: tryDecryptSessionOwnerMetadataView({ credentials: input.credentials, rawSession: transport.rawSession,
            accountEncryptionMode: transport.accountEncryptionCurrentness.mode }) });
    if (!machineId) return { status: 'unavailable', code: 'plugin_action_execution_origin_unavailable',
        message: 'The Session source Machine is unavailable', actionHandlerInvocation: 'notStarted' };
    return { status: 'available', machineId };
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
        ...(input.request.requestId === undefined ? {} : { requestId: input.request.requestId }),
        qualifiedActionId: buildQualifiedPluginContributionKey(input.request.action), input: input.request.input,
        ...(input.request.requiredReadOnly || input.request.readObservation ? { requiredReadOnly: true } : {}),
        // Preserve the person's host-admitted UI press across the Machine hop.
        // This carries intent without raising the Account-automation authority ceiling.
        executionSurface: input.request.presentUserIntent === 'confirmed' ? 'ui'
            : input.request.originSurface === 'agent' ? 'agent' : input.request.originSurface === 'mcp' ? 'mcp' : 'cli',
        presentUserIntent: input.request.presentUserIntent,
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
            : { status: 'failed', code: result.code, message: result.message ?? result.code, data: new PluginError(result).data,
                ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
                ...(result.actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation: result.actionHandlerInvocation }) };
    } catch (error) {
        if (readMachineRpcRequestDisposition(error) === 'notSent') {
            // Disposition proves no dispatch, not why the RPC owner refused it.
            const cause = readRpcErrorCode(error)
                ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined);
            const code = projectPluginActionFailureCode(cause);
            return { status: 'unavailable', code, message: code,
                actionHandlerInvocation: 'notStarted' };
        }
        // The transport may have emitted the request. No fallback or automatic
        // replay can turn a missing acknowledgement into another provider effect.
        return { status: 'failed', code: 'plugin_action_outcome_unknown', message: 'The Machine Action outcome is unknown' };
    }
}
