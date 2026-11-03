import { DaemonTerminalEnsureResponseSchema, type DaemonTerminalEnsureRequest,
    type DaemonTerminalEnsureResponse, type DaemonTerminalErrorCode } from '@happier-dev/protocol/daemon/terminal';
import { MACHINE_SERVICE_SHELL_OPERATION } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { withMachineServiceTarget } from '@/daemon/local/services/launch/machineServiceTarget';
import { consumeServiceShellTerminal } from '@/terminal/pty/serviceShell';
import type { TerminalPtyMachineCustody, TerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

type ShellRequest = Pick<DaemonTerminalEnsureRequest, 'terminalKey' | 'cols' | 'rows'> & Readonly<{
    launch: Extract<NonNullable<DaemonTerminalEnsureRequest['launch']>, { kind: 'service_shell' }>;
}>;

/** Existing terminal registration invokes this only after its incumbent
 * owner-person identity decision. Native selection remains service-owned.
 */
export async function openServiceShellTerminal(input: Readonly<{
    request: ShellRequest;
    actionId: 'machines.terminal.open' | 'machines.terminal.restart';
    custody: Omit<TerminalPtyMachineCustody, 'rootPath'>;
    context: RpcHandlerContext;
    terminalSessions: TerminalPtySessionManager;
    admissionDrain?: DaemonAdmissionDrain;
    operationRuntime: Pick<HostActionOperationRuntime, 'observeExecution'>;
}>): Promise<DaemonTerminalEnsureResponse> {
    const routing = { serverId: input.custody.serverId, machineId: input.custody.machineId };
    const result = await input.operationRuntime.observeExecution({
        actionId: input.actionId, input: { ...routing, ...input.request },
        operation: MACHINE_SERVICE_SHELL_OPERATION,
        rpcContext: input.context,
        ...(input.context.localActionContext?.actionRequestId
            ? { actionRequestId: input.context.localActionContext.actionRequestId }
            : input.context.transportRequestId ? { actionRequestId: input.context.transportRequestId } : {}),
        execute: async operation => {
            // The receiving host observer creates the native operation identity.
            // The declaration and this producer co-land; no caller token exists.
            const acceptance = operation.operationAcceptance;
            if (!acceptance) throw new Error('service_shell_operation_unavailable');
            const assertCurrent = async () => {
                // The registered RPC owner already admitted this caller. This
                // operation retains cancellation and native generation custody.
                operation.signal.throwIfAborted();
            };
            operation.operationOwnerUpdate.update({ cancellation: 'supported' });
            const uncertain = () => operation.operationOwnerUpdate.update({
                outcome: { ok: false, errorCode: 'indeterminate', error: 'indeterminate' },
                observation: { kind: 'outcome_uncertain', code: 'indeterminate' },
            });
            return await withMachineServiceTarget({ ...routing,
                request: { ...routing, serviceId: input.request.launch.serviceId,
                    expectedGeneration: input.request.launch.expectedGeneration },
                signal: operation.signal, assertCurrent,
            }, async handle => {
                if (!('withServiceShell' in handle) || !handle.withServiceShell) {
                    return { ok: false as const, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' };
                }
                const signal = AbortSignal.any([operation.signal, handle.retirementSignal]);
                const observed = await handle.withServiceShell({
                    operation: { operationId: acceptance.operationId, kind: input.actionId, signal: operation.signal },
                    signal,
                }, launch => consumeServiceShellTerminal({ terminalSessions: input.terminalSessions,
                    ...(input.admissionDrain ? { admissionDrain: input.admissionDrain } : {}),
                    custody: input.custody, terminalKey: input.request.terminalKey,
                    cols: input.request.cols, rows: input.request.rows, launch, signal,
                    onOutcomeUncertain: uncertain,
                    onRegistered(terminal) {
                        if (!terminal.ok) return;
                        acceptance.accept({ ...terminal, operation: { ...routing, operationId: acceptance.operationId } });
                    },
                }));
                if (!observed.terminal.ok) return observed.terminal;
                if (observed.kind !== 'client_exit' || observed.clientExit.kind !== 'exited') {
                    uncertain();
                    return { ok: false as const, errorCode: 'indeterminate', error: 'indeterminate' };
                }
                const result = { ...observed.terminal, sessionEnded: true, clientExit: observed.clientExit.exit };
                operation.operationOwnerUpdate.update({ outcome: { ok: true, result }, observation: null });
                return { ok: true as const, result };
            });
        },
    }).catch((error: unknown) => {
        const code = readRpcErrorCode(error) ?? (error instanceof Error && 'code' in error
            && typeof error.code === 'string' ? error.code : 'terminal_unavailable');
        const actionOperationId = error instanceof Error && 'actionOperationId' in error
            && typeof error.actionOperationId === 'string' ? error.actionOperationId : undefined;
        return { ok: false as const, errorCode: code, error: code,
            ...(code === 'effect_in_progress' && actionOperationId ? { details: { actionOperationId } } : {}) };
    });
    if (result.ok) return DaemonTerminalEnsureResponseSchema.parse(result.result);
    // The terminal wire keeps its existing typed envelope. Canonical domain
    // causes remain in error; recognized service codes are carried unchanged.
    const parsed = DaemonTerminalEnsureResponseSchema.safeParse({ ok: false,
        errorCode: result.errorCode, error: result.error, ...(result.details ? { details: result.details } : {}) });
    if (parsed.success) return parsed.data;
    return { ok: false, errorCode: 'terminal_invalid_request' satisfies DaemonTerminalErrorCode, error: result.errorCode };
}
