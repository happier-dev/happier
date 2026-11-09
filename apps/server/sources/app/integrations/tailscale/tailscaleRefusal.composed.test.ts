import type { ExecFileOptions } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

import { logger } from '@/utils/logging/log';
import { inferTailscaleServePublicServerUrl } from './tailscaleServePublicUrlInference';
import { inferTailscaleFunnelPublicServerUrl } from './tailscaleFunnelPublicUrlInference';

const native = vi.hoisted(() => ({ calls: [] as string[][] }));

// Replace only the native process; discovery, classification and URL inference stay real.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFile(command: string, args: string[], _options: ExecFileOptions,
        callback: (error: Error | null, stdout: string, stderr: string) => void) {
        if (command !== 'qb269-tailscale') throw new Error('Unexpected native command');
        native.calls.push(args);
        const child = new actual.ChildProcess();
        const stderr = "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket\n/private/operator token=private-token";
        queueMicrotask(() => {
            child.exitCode = 1;
            callback(Object.assign(new Error(stderr), { code: 1 }), '', stderr);
            child.emit('close', 1, null);
        });
        return child;
    } };
});

afterEach(() => { native.calls.length = 0; vi.restoreAllMocks(); });

it.each([
    ['serve', inferTailscaleServePublicServerUrl],
    ['funnel', inferTailscaleFunnelPublicServerUrl],
] as const)('reports the %s operator refusal while keeping optional URL inference nonfatal', async (command, infer) => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const env = { HAPPIER_TAILSCALE_BIN: 'qb269-tailscale', HAPPIER_TAILSCALE_INFER_PUBLIC_URL: '1' };
    expect(await infer(env)).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
        code: 'tailscale_operator_authorization_refused', retryable: false,
        remediation: expect.stringContaining('sudo'),
    }), expect.any(String));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('/private/operator');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-token');
    expect(native.calls).toEqual([[command, 'status']]);
});
