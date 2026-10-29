import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPidProvablyAbsent } from '@happier-dev/cli-common/process';

import { DefaultTransport } from '@/agent/transport';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDaemonizingProcessFixture } from '@/testkit/process/daemonizingProcess';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { probeAcpAgentCapabilities } from './acpProbe';

describe('ACP readiness probe process lifetime', () => {
    it('cleans a successful initialization tree even when the launcher ignores SIGTERM', async () => {
        await withTempDir('happier-acp-probe-success-', async directory => {
            const receipt = join(directory, 'pids.json');
            let pids: { root: number; descendant: number } | undefined;
            try {
                const result = await probeAcpAgentCapabilities({ command: process.execPath,
                    args: ['-e', `
                        const { spawn } = require('node:child_process');
                        const fs = require('node:fs');
                        process.on('SIGTERM', () => {});
                        process.stdin.on('end', () => process.exit(0));
                        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                            stdio: 'ignore', detached: process.platform !== 'win32',
                        });
                        child.unref();
                        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ root: process.pid, descendant: child.pid }));
                        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
                            const request = JSON.parse(line);
                            if (request.method === 'initialize') process.stdout.write(JSON.stringify({
                                jsonrpc: '2.0', id: request.id,
                                result: { protocolVersion: request.params.protocolVersion, agentCapabilities: { loadSession: true } },
                            }) + '\\n');
                        });
                        setInterval(() => {}, 1000);
                    `], cwd: directory, env: {}, transport: new DefaultTransport('probe-success'),
                    timeoutMs: 10_000 });
                pids = JSON.parse(await readFile(receipt, 'utf8'));
                expect(result.ok).toBe(true);
                expect(isPidProvablyAbsent(pids!.root)).toBe(true);
                expect(await waitForProcessExit(pids!.descendant)).toBe(true);
            } finally {
                pids ??= await readFile(receipt, 'utf8').then(value => JSON.parse(value)).catch(() => undefined);
                for (const pid of pids ? [pids.root, pids.descendant] : []) {
                    if (!isPidProvablyAbsent(pid)) {
                        try { process.kill(pid, 'SIGKILL'); } catch { /* Exact fixture processes only. */ }
                        await waitForProcessExit(pid);
                    }
                }
            }
        });
    });

    it('ends an independently grouped descendant when its owning probe is cancelled', async ({ task }) => {
        await withTempDir('happier-acp-probe-lifetime-', async directory => {
            const fixture = createDaemonizingProcessFixture(directory);
            const controller = new AbortController();
            const probe = probeAcpAgentCapabilities({ command: process.execPath, args: fixture.args,
                cwd: directory, env: {}, transport: new DefaultTransport('probe-lifetime'),
                timeoutMs: null, signal: controller.signal });
            try {
                const descendantPid = await fixture.ready({ launch: probe, timeoutMs: task.timeout });
                controller.abort();
                expect((await probe).ok).toBe(false);
                expect(await waitForProcessExit(descendantPid, { timeoutMs: 500 })).toBe(true);
            } finally {
                controller.abort();
                await probe;
                await fixture.cleanup();
            }
        });
    });
});
