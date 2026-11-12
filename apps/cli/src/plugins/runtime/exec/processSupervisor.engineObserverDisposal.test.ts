import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { captureProcessTree } from '@/processes/terminate/terminateProcessTree';
import { spawnSupervisedPluginProcess } from './processSupervisor';

function spawnEngineLikeTransport(exitCode?: number) {
    // Match the Engine dial-stdio transport's raw pipes, zero retained output,
    // ordinary daemon ownership and POSIX process group at the real OS boundary.
    // Node stands in for the external executable; supervision stays real.
    return spawnSupervisedPluginProcess({
        command: process.execPath,
        args: ['-e', `
            process.stdin.resume();
            ${exitCode === undefined ? '' : `process.stdin.once('end', () => process.exit(${exitCode}));`}
            process.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n');
        `],
        env: { HAPPIER_PROCESS_OWNER: 'v1.123456789abc.happier.daemon' },
        pipeStdout: true,
        maxStdoutBytes: 0,
        maxStderrBytes: 0,
        spawnOptions: { detached: process.platform !== 'win32', windowsHide: true },
    });
}

describe('Engine-like transport disposal', () => {
    it.each([0, 17])('settles an exited transport with zero retained bytes (exit %s)', async exitCode => {
        const supervised = spawnEngineLikeTransport(exitCode);
        try {
            await once(supervised.child.stdout, 'data');
            // Keep the fixture alive through a native census, as the existing
            // daemonizing fixture does. No capture/termination or exit is mocked.
            expect((await captureProcessTree({ pid: supervised.child.pid! })).status).toBe('ok');
            await supervised.handle.closeStdin();
            expect(await supervised.handle.waitForExit()).toEqual({
                observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' },
            });
            await expect(supervised.handle.dispose()).resolves.toBeUndefined();
            await expect(supervised.waitForSettlement()).resolves.toEqual({ status: 'ended' });
            const result = await supervised.handle.wait();
            expect(result.stdout).toHaveLength(0);
            expect(result.stderr).toHaveLength(0);
        } finally {
            supervised.child.kill('SIGKILL');
            await supervised.dispose().catch(() => undefined);
        }
    });

    it('settles live pipe disposal after first raw output without retaining bytes', async () => {
        const supervised = spawnEngineLikeTransport();
        try {
            await once(supervised.child.stdout, 'data');
            expect((await captureProcessTree({ pid: supervised.child.pid! })).status).toBe('ok');
            expect(supervised.child.exitCode).toBeNull();
            await expect(supervised.handle.dispose()).resolves.toBeUndefined();
            await expect(supervised.waitForSettlement()).resolves.toEqual({ status: 'ended' });
            const result = await supervised.handle.wait();
            expect(result.termination.requestedBy).toEqual({ kind: 'dispose', reason: 'caller' });
            expect(result.stdout).toHaveLength(0);
            expect(result.stderr).toHaveLength(0);
        } finally {
            supervised.child.kill('SIGKILL');
            await supervised.dispose().catch(() => undefined);
        }
    });
});
