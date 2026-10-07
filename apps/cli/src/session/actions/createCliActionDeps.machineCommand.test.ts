import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler } from '@/api/rpc/types';
import { registerBashHandler } from '@/rpc/handlers/bash';
import { createCliActionDeps } from './createCliActionDeps';

function createLocalCommandDeps() {
    const handlers = new Map<string, RpcHandler>();
    registerBashHandler({ registerHandler: (method, handler) => handlers.set(method, handler) }, process.cwd());
    return createCliActionDeps({
        token: 'unused-local-token', sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: {
            machineId: 'run-machine',
            invoke: async (method, request, options) => {
                const handler = handlers.get(method);
                if (!handler) throw new Error(`Missing machine handler: ${method}`);
                return handler(request, { signal: options?.signal ?? new AbortController().signal });
            },
        },
    });
}

describe('CLI command Action host', () => {
    it.skipIf(process.platform === 'win32')('uses the existing local machine exec owner in the selected workspace with env-only values', async () => {
        const deps = createLocalCommandDeps();
        const directory = await realpath(tmpdir());
        const value = '$(printf injected); "quoted" & literal';
        await expect(deps.machineCommandRun!({ command: 'printf "%s" "$HB_COMMAND_VALUE"; printf "%s" "$PWD" >&2', env: { HB_COMMAND_VALUE: value } }, {
            surface: 'cli', authority: 'present_user', serverId: 'home',
            externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory } },
        })).resolves.toEqual({ exitCode: 0, stdout: value, stderr: directory });
    });

    it.skipIf(process.platform === 'win32')('retains a command failure and its output as Action failure details', async () => {
        const deps = createLocalCommandDeps();
        await expect(deps.machineCommandRun!({ command: 'printf partial; printf refused >&2; exit 7' }, {
            surface: 'cli', authority: 'present_user', serverId: 'home',
            externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory: process.cwd() } },
        })).resolves.toMatchObject({ ok: false, errorCode: 'command_failed', details: { exitCode: 7, stdout: 'partial', stderr: 'refused' } });
    });

    it('refuses an incomplete or mismatched machine workspace before running anything', async () => {
        const deps = createLocalCommandDeps();
        await expect(deps.machineCommandRun!({ command: 'unused' }, { surface: 'cli', authority: 'present_user' }))
            .resolves.toMatchObject({ ok: false, errorCode: 'command_target_required' });
        await expect(deps.machineCommandRun!({ command: 'unused' }, { surface: 'cli', authority: 'present_user',
            externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'other', directory: process.cwd() } },
        })).resolves.toMatchObject({ ok: false, errorCode: 'command_target_required' });
        await expect(deps.machineCommandRun!({ command: 'unused' }, { surface: 'cli', authority: 'present_user', serverId: 'other',
            externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory: process.cwd() } },
        })).resolves.toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    });

    it('refuses an unauthenticated foreign machine rather than executing on the local machine', async () => {
        const deps = createLocalCommandDeps();
        await expect(deps.machineCommandRun!({ command: 'unused' }, { surface: 'cli', authority: 'present_user', serverId: 'home',
            externalActionTarget: { kind: 'machine', machineId: 'other', project: { machineId: 'other', directory: process.cwd() } },
        })).resolves.toMatchObject({ ok: false, errorCode: 'command_transport_unavailable' });
    });

    it('uses the existing machine RPC lifetime without a subordinate acknowledgement deadline', async () => {
        // The remote machine transport is a network boundary; local command tests above keep its internal exec owner real.
        const machineRpc = await import('@/session/transport/rpc/machineRpc');
        const rpc = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ success: true, exitCode: 0, stdout: 'finished', stderr: '' });
        try {
            const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
            const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null });
            const signal = new AbortController().signal;
            await expect(deps.machineCommandRun!({ command: 'fixed command', env: { VALUE: 'data' } }, { surface: 'cli', authority: 'present_user', serverId: 'home', signal,
                externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory: '/workspace' } },
            })).resolves.toEqual({ exitCode: 0, stdout: 'finished', stderr: '' });
            expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'run-machine', method: RPC_METHODS.BASH,
                request: { command: 'fixed command', env: { VALUE: 'data' }, cwd: '/workspace', cwdMode: 'explicit', timeout: 0 }, timeoutMs: null, signal }));
            rpc.mockResolvedValueOnce({ success: false, exitCode: 0, stdout: 'partial', stderr: '', error: 'Command timed out' });
            await expect(deps.machineCommandRun!({ command: 'fixed command' }, { surface: 'cli', authority: 'present_user', serverId: 'home',
                externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory: '/workspace' } },
            })).resolves.toMatchObject({ ok: false, errorCode: 'command_failed', details: { exitCode: 0, stdout: 'partial', stderr: '' } });
            rpc.mockResolvedValueOnce({ success: true, exitCode: 0, stdout: '', stderr: '' });
            await expect(deps.machineCommandRun!({ command: 'fixed command' }, { surface: 'cli', authority: 'present_user', serverId: 'home',
                externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory: '/workspace' } },
            })).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '' });
            rpc.mockResolvedValueOnce({ success: false, error: 'Path is not authorized' });
            await expect(deps.machineCommandRun!({ command: 'fixed command' }, { surface: 'cli', authority: 'present_user', serverId: 'home',
                externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory: '/workspace' } },
            })).resolves.toMatchObject({ ok: false, errorCode: 'command_failed', details: { exitCode: -1, stdout: '', stderr: '' } });
        } finally {
            rpc.mockRestore();
        }
    });

    it.each([null,
        { success: true, exitCode: 0, stdout: 17, stderr: '' },
        { success: true, exitCode: 0, stdout: null, stderr: '' },
        { success: true, exitCode: 0, stdout: '', stderr: null },
        { success: true, exitCode: 0, stdout: '' },
        { success: true, exitCode: 0 },
    ])(
        'keeps a malformed post-execution response uncertain (%j)', async (response) => {
            // The RPC can answer malformed data after executing the command; uncertainty belongs to the existing Action failure owner.
            const machineRpc = await import('@/session/transport/rpc/machineRpc');
            const rpc = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue(response);
            try {
                const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
                const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null });
                await expect(deps.machineCommandRun!({ command: 'already executed' }, { surface: 'cli', authority: 'present_user', serverId: 'home',
                    externalActionTarget: { kind: 'machine', machineId: 'run-machine', project: { machineId: 'run-machine', directory: '/workspace' } },
                })).resolves.toMatchObject({ ok: false, errorCode: 'action_failed' });
            } finally {
                rpc.mockRestore();
            }
        },
    );
});
