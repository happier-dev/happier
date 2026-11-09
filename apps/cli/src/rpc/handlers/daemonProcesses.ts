import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { MachineProcessesView } from '@/daemon/processes/view/createMachineProcessesView';
import { MachineProcessesListInputV1Schema, MachineProcessesAnswerV1Schema, MachineProcessesGetInputV1Schema,
    MachineProcessesGetResultV1Schema, MachineProcessesCheckInputV1Schema, MachineProcessesCheckResultV1Schema,
    MachineProcessesWatchInputV1Schema, MachineProcessesWatchResultV1Schema,
    MachineProcessesKillInputV1Schema, MachineProcessesStopInputV1Schema, MachineProcessesCleanUpInputV1Schema,
    MachineProcessesStartAgainInputV1Schema, MachineProcessesActionResultV1Schema, MachineProcessesCleanUpResultV1Schema,
    MachineProcessesStartAgainResultV1Schema, type MachineProcessesKillInputV1, type MachineProcessesStopInputV1,
    type MachineProcessesCleanUpInputV1, type MachineProcessesStartAgainInputV1, type MachineProcessesActionResultV1,
    type MachineProcessesCleanUpResultV1, type MachineProcessesStartAgainResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';

export type DaemonProcessActionRequester = Readonly<{ accountId: string; isCustodian: boolean }>;
export type DaemonProcessActionExecution = Readonly<{ signal?: AbortSignal;
    rpcContext?: RpcHandlerContext; actionContext?: ReturnType<typeof buildActionExecutorContextForRpc> }>;
export type DaemonProcessActions = Readonly<{
    executeKill(input: MachineProcessesKillInputV1, requester: DaemonProcessActionRequester, execution: DaemonProcessActionExecution): Promise<MachineProcessesActionResultV1>;
    executeStop(input: MachineProcessesStopInputV1, requester: DaemonProcessActionRequester, execution: DaemonProcessActionExecution): Promise<MachineProcessesActionResultV1>;
    cleanUp(input: MachineProcessesCleanUpInputV1, requester: DaemonProcessActionRequester, execution: DaemonProcessActionExecution): Promise<MachineProcessesCleanUpResultV1>;
    startAgain(input: MachineProcessesStartAgainInputV1, requester: DaemonProcessActionRequester, execution: DaemonProcessActionExecution): Promise<MachineProcessesStartAgainResultV1>;
}>;
export type DaemonProcessesRoutes = Readonly<{
    view: MachineProcessesView;
    target(): Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
    actions?: DaemonProcessActions;
    readEnvironment?(target: Readonly<{ serverId: string; environmentId: string }>, context: RpcHandlerContext): Promise<boolean>;
}>;

/** Action RPC admission owns approval. These endpoints consume its admitted identity and never add approval policy. */
export function registerDaemonProcessesRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonProcessesRoutes): void {
    const bindAdmission = (request: Readonly<{ machineId: string; serverId?: string }>, context?: RpcHandlerContext) => {
        const target = options.target();
        const deny = (predicate: RpcAdmissionPredicate) => { context?.reportAdmissionDenial?.(predicate); return false; };
        const matches = () => {
            const current = options.target(); const admission = context?.machineAdmission;
            if (!target || !current || current.serverId !== target.serverId) return deny('machine_home');
            if (!admission) return deny('machine_admission');
            if (context?.signal.aborted) return deny('request_cancelled');
            if (admission.actorAccountId.length === 0) return deny('machine_actor');
            if (admission.role !== 'use' && admission.role !== 'manage') return deny('machine_role');
            return doesMachineRpcTargetMatchAdmission(request, admission, current, context?.reportAdmissionDenial);
        };
        if (!matches()) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
        const assertLocal = async () => {
            if (!matches()) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
        };
        const identity = context!.machineAdmission!;
        return { accountId: identity.actorAccountId, custodianAccountId: identity.custodianAccountId, assertLocal,
            async canReadEnvironment(environment: Readonly<{ serverId: string; environmentId: string }>) {
                await assertLocal();
                if (!context) return false;
                const capturedRead = context.localActionContext?.processEnvironmentRead;
                const allowed = capturedRead ? await capturedRead(environment) : await options.readEnvironment?.(environment, context) ?? false;
                await assertLocal();
                return allowed;
            } };
    };
    // Each finite request consumes dispatcher admission; native effects keep
    // their exact identity/ownership checks and local cancellation below.
    rpc.registerHandler(RPC_METHODS.MACHINES_PROCESSES_LIST, async (raw: unknown, context) => {
        const input = MachineProcessesListInputV1Schema.parse(raw); const requester = bindAdmission(input, context);
        try { return MachineProcessesAnswerV1Schema.parse(await options.view.list(input, requester)); }
        finally { await requester.assertLocal(); }
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_PROCESSES_GET, async (raw: unknown, context) => {
        const input = MachineProcessesGetInputV1Schema.parse(raw); const requester = bindAdmission(input, context);
        try { return MachineProcessesGetResultV1Schema.parse(await options.view.get(input, requester)); }
        finally { await requester.assertLocal(); }
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_PROCESSES_CHECK, async (raw: unknown, context) => {
        const input = MachineProcessesCheckInputV1Schema.parse(raw); const requester = bindAdmission(input, context);
        try { return MachineProcessesCheckResultV1Schema.parse(await options.view.check(input, requester)); }
        finally { await requester.assertLocal(); }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PROCESSES_WATCH, async (raw: unknown, context) => {
        const input = MachineProcessesWatchInputV1Schema.parse(raw); const requester = bindAdmission(input, context);
        try { return MachineProcessesWatchResultV1Schema.parse(await options.view.watch(input, requester, context?.signal)); }
        finally { await requester.assertLocal(); }
    });
    if (!options.actions) return;
    const actions = options.actions;
    const execution = (input: Readonly<{ machineId: string; serverId?: string }>, context?: RpcHandlerContext): DaemonProcessActionExecution => ({
        signal: context?.signal, rpcContext: context,
        actionContext: buildActionExecutorContextForRpc({ ...context, serverId: input.serverId,
            externalActionTarget: { kind: 'machine', machineId: input.machineId } }),
    });
    const requester = (identity: ReturnType<typeof bindAdmission>): DaemonProcessActionRequester => ({
        accountId: identity.accountId, isCustodian: identity.accountId === identity.custodianAccountId,
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_PROCESSES_KILL, async (raw: unknown, context) => {
        const input = MachineProcessesKillInputV1Schema.parse(raw); const actor = bindAdmission(input, context);
        return MachineProcessesActionResultV1Schema.parse(await actions.executeKill(input, requester(actor), execution(input, context)));
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_PROCESSES_STOP, async (raw: unknown, context) => {
        const input = MachineProcessesStopInputV1Schema.parse(raw); const actor = bindAdmission(input, context);
        return MachineProcessesActionResultV1Schema.parse(await actions.executeStop(input, requester(actor), execution(input, context)));
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_PROCESSES_LEFT_BEHIND_CLEAN_UP, async (raw: unknown, context) => {
        const input = MachineProcessesCleanUpInputV1Schema.parse(raw); const actor = bindAdmission(input, context);
        return MachineProcessesCleanUpResultV1Schema.parse(await actions.cleanUp(input, requester(actor), execution(input, context)));
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_PROCESSES_START_AGAIN, async (raw: unknown, context) => {
        const input = MachineProcessesStartAgainInputV1Schema.parse(raw); const actor = bindAdmission(input, context);
        return MachineProcessesStartAgainResultV1Schema.parse(await actions.startAgain(input, requester(actor), execution(input, context)));
    });
}
