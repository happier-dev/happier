import { readComputerInstallHint } from '../targets';
import { isActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { COMPUTER_PRESENT_USER_ACTION_IDS } from '@happier-dev/protocol/computer/v1';
import { isComputerRuntimeActionId } from '@happier-dev/protocol/actions/executor/computer';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';

import { executeComputerActionViaMachineRpc } from './machineRpc';
import { publishComputerActionAnswer } from '../computerControlClient';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type ComputerMachineRpc = (input: Readonly<{
    serverId?: string;
    /** Existing front-door Account admission, pinned by the scoped transport. */
    accountId?: string;
    machineId: string;
    /** The verified daemon owner confines this route to the invoking person's desktop. */
    ownDesktopOnly?: boolean;
    sessionId?: string;
    actionId: string;
    input: unknown;
    signal?: AbortSignal;
}>) => Promise<unknown>;

const PRESENT_USER_ACTION_IDS: ReadonlySet<string> = new Set(COMPUTER_PRESENT_USER_ACTION_IDS);

function refuse(code: string) {
    return { ok: false, errorCode: code, error: code } as const;
}

function readMachineId(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null;
    const machineId = (input as Readonly<{ machineId?: unknown }>).machineId;
    return typeof machineId === 'string' && machineId.trim() ? machineId.trim() : null;
}

/**
 * The front door has applied Actions settings. Person controls (choose, look, stop, hand back,
 * permission pane) use the named Machine's direct RPC, which stamps present-user authority.
 * Agent proposals use the Account Action transport, retaining their caller, Session context
 * and automation authority, including target reads while preparing an approval.
 */
export function createComputerRuntimeActionExecutor(input: Readonly<{
    executeOnMachine?: ComputerMachineRpc;
    executeAgentAction?: RuntimeActionExecute;
    resolveOwnDesktopOnly?: (target: Readonly<{ machineId: string; serverId?: string }>) => boolean;
    fallback: RuntimeActionExecute;
    /** The invoking Account owns publication, never the effect's returned acknowledgement. */
    accountLifetime?: ServerAccountScopeLifetime;
}>): RuntimeActionExecute {
    const executeOnMachine = input.executeOnMachine ?? executeComputerActionViaMachineRpc;
    return async (args) => {
        if (!isComputerRuntimeActionId(args.actionId)) return await input.fallback(args);
        if (args.context.authority !== 'present_user') {
            if (!input.executeAgentAction) return refuse('present_user_required');
            const machineId = readMachineId(args.input);
            if (!machineId) return refuse('invalid_parameters');
            return await input.executeAgentAction({ ...args, context: { ...args.context,
                externalActionTarget: { kind: 'machine', machineId } } });
        }
        if (!PRESENT_USER_ACTION_IDS.has(args.actionId)) {
            return refuse('present_user_required');
        }
        const sessionId = typeof args.context.defaultSessionId === 'string' ? args.context.defaultSessionId.trim() : '';
        const personId = args.context.runtimeAccountId ?? input.accountLifetime?.scope.accountId;
        if (!sessionId && !personId) return refuse('computer_session_required');
        const machineId = readMachineId(args.input);
        if (!machineId) return refuse('invalid_parameters');
        const result = await executeOnMachine({
            ...(args.context.serverId ? { serverId: args.context.serverId } : {}),
            ...(personId ? { accountId: personId } : {}),
            machineId,
            ...(input.resolveOwnDesktopOnly?.({ machineId, serverId: args.context.serverId ?? undefined })
                ? { ownDesktopOnly: true } : {}),
            ...(sessionId ? { sessionId } : {}),
            actionId: args.actionId,
            input: args.input,
            ...(args.context.signal ? { signal: args.context.signal } : {}),
        });
        if (!input.accountLifetime || input.accountLifetime.isCurrent()) {
            const sourceScope = sessionId ? { sessionId } : { source: { kind: 'machine-person' as const, personId: personId! } };
            publishComputerActionAnswer({ ...sourceScope, machineId, serverId: args.context.serverId ?? null }, args.actionId, result);
        }
        // Action failure projection preserves details, not native top-level metadata.
        const installHint = readComputerInstallHint(result);
        return isActionExecuteFailure(result) && installHint
            ? { ...result, details: { ...(result.details && typeof result.details === 'object' ? result.details : {}), installHint } }
            : result;
    };
}
