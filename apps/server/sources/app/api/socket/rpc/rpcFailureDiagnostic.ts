import { ActionFailureCauseV1Schema, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';

const diagnosticMethods = new Set<string>([
    ...Object.values(RPC_METHODS), ...Object.values(SESSION_RPC_METHODS),
    CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
]);

/** Project only content-free failure facts; never log scoped ids or response bodies. */
export function projectRpcFailureDiagnostic(method: string | null, response: unknown, phase: string, effectAttempted: boolean | null = null): Readonly<{
    method: string;
    errorCode: string;
    failureCause: ActionFailureCauseV1 | Readonly<{ phase: string }>;
    effectAttempted: boolean | null;
}> | null {
    if (!response || typeof response !== 'object' || Reflect.get(response, 'ok') !== false) return null;
    const localCause = ActionFailureCauseV1Schema.safeParse(readActionOutputDiagnostic(response)?.failureCause);
    const cause = ActionFailureCauseV1Schema.safeParse(Reflect.get(response, 'failureCause'));
    const responseEffectAttempted: unknown = Reflect.get(response, 'effectAttempted');
    const unscopedMethod = method?.slice(method.indexOf(':') + 1);
    return {
        method: unscopedMethod && diagnosticMethods.has(unscopedMethod) ? unscopedMethod : '<unregistered>',
        errorCode: readActionErrorCodeV1(response) ?? 'unclassified_error',
        failureCause: localCause.success ? localCause.data : { phase: cause.success ? cause.data.phase : phase },
        // A failed acknowledgement alone cannot prove whether the target acted.
        effectAttempted: typeof responseEffectAttempted === 'boolean' ? responseEffectAttempted : effectAttempted,
    };
}
