import { COMPUTER_PRESENT_USER_ACTION_IDS } from '@happier-dev/protocol/computer/v1';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';

import { executeComputerActionViaMachineRpc } from './machineRpc';
import { publishComputerActionAnswer } from '../computerControlClient';

export type ComputerMachineRpc = (input: Readonly<{
    serverId?: string;
    machineId: string;
    sessionId: string;
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
 * The person's computer controls as runtime Actions: the front door has already applied Actions
 * settings and the present-user floor; this leaf carries them to the machine the request names, for
 * the Session the person is in. Only the person's Actions travel here (choose, look, stop, hand back,
 * permission pane), and only with present-user authority, because the daemon route stamps that
 * authority itself. Agent computer Actions run in their Session's own dispatch, never from this client.
 */
export function createComputerRuntimeActionExecutor(input: Readonly<{
    executeOnMachine?: ComputerMachineRpc;
    fallback: RuntimeActionExecute;
}>): RuntimeActionExecute {
    const executeOnMachine = input.executeOnMachine ?? executeComputerActionViaMachineRpc;
    return async (args) => {
        if (!args.actionId.startsWith('computer.')) return await input.fallback(args);
        if (!PRESENT_USER_ACTION_IDS.has(args.actionId) || args.context.authority !== 'present_user') {
            return refuse('present_user_required');
        }
        const sessionId = typeof args.context.defaultSessionId === 'string' ? args.context.defaultSessionId.trim() : '';
        if (!sessionId) return refuse('computer_session_required');
        const machineId = readMachineId(args.input);
        if (!machineId) return refuse('invalid_parameters');
        const result = await executeOnMachine({
            ...(args.context.serverId ? { serverId: args.context.serverId } : {}),
            machineId,
            sessionId,
            actionId: args.actionId,
            input: args.input,
            ...(args.context.signal ? { signal: args.context.signal } : {}),
        });
        publishComputerActionAnswer({ sessionId, machineId, serverId: args.context.serverId ?? null }, args.actionId, result);
        return result;
    };
}
