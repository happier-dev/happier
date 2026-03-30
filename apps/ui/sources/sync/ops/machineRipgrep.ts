import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { z } from 'zod';

interface MachineRipgrepRequest {
    args: string[];
    cwd?: string;
}

export interface MachineRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

const MachineRipgrepResponseSchema = z.object({
    success: z.boolean(),
    exitCode: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    error: z.string().optional(),
}).passthrough();

function normalizeMachineRipgrepResponse(raw: unknown): MachineRipgrepResponse {
    const parsed = MachineRipgrepResponseSchema.safeParse(raw);
    if (!parsed.success) {
        return { success: false, error: 'Unsupported response from machine RPC' };
    }
    return parsed.data;
}

export async function machineRipgrep(
    machineId: string,
    args: readonly string[],
    cwd?: string,
    options?: Readonly<{ serverId?: string | null; timeoutMs?: number }>,
): Promise<MachineRipgrepResponse> {
    try {
        const payload: MachineRipgrepRequest = {
            args: Array.from(args),
            ...(typeof cwd === 'string' && cwd.trim() ? { cwd } : {}),
        };

        const response = await machineRpcWithServerScope<unknown, MachineRipgrepRequest>({
            machineId,
            method: 'ripgrep',
            payload,
            serverId: options?.serverId ?? null,
            timeoutMs: options?.timeoutMs,
        });

        return normalizeMachineRipgrepResponse(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
