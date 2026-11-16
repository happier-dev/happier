import { expect, it, vi } from 'vitest';

import { DefaultTransport } from '@/agent/transport';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { probeAcpAgentCapabilities } from './acpProbe';

it('keeps a supplied probe environment complete without restoring host or Session keys', async () => {
    vi.stubEnv('HAPPIER_TEST_ACP_HOST_ONLY', 'host-only');
    try {
        await withTempDir('happier-acp-probe-env-', async cwd => {
            await Promise.all(['left', 'right'].map(marker => runAddedHostedSession({
                environment: { NODE_ENV: 'test', HAPPIER_TEST_ACP_SESSION_ONLY: 'session-only' }, workingDirectory: cwd, end() {},
            }, async () => {
                await Promise.resolve();
                const result = await probeAcpAgentCapabilities({
                    command: process.execPath,
                    args: ['-e', `
                        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
                            const request = JSON.parse(line);
                            if (request.method !== 'initialize') return;
                            const suppliedOnly = process.env.HAPPIER_TEST_ACP_MARKER === ${JSON.stringify(marker)}
                                && process.env.HAPPIER_TEST_ACP_HOST_ONLY === undefined
                                && process.env.HAPPIER_TEST_ACP_SESSION_ONLY === undefined
                                && process.env.NODE_ENV === undefined;
                            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
                                result: { protocolVersion: request.params.protocolVersion, agentCapabilities: { loadSession: suppliedOnly } },
                            }) + '\\n');
                        });
                    `],
                    cwd, env: { HAPPIER_TEST_ACP_MARKER: marker },
                    transport: new DefaultTransport('probe-environment'), timeoutMs: null,
                });
                expect(result).toMatchObject({ ok: true, agentCapabilities: { loadSession: true } });
            })));
        });
    } finally { vi.unstubAllEnvs(); }
});


it('keeps cached ACP capabilities separate for different probe environments', async () => {
    await withTempDir('happier-acp-probe-env-cache-', async cwd => {
        const args = ['-e', `
            require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
                const request = JSON.parse(line);
                if (request.method !== 'initialize') return;
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
                    result: { protocolVersion: request.params.protocolVersion,
                        agentCapabilities: { loadSession: process.env.HAPPIER_TEST_ACP_SESSION_CAPABILITY === 'enabled' } },
                }) + '\\n');
            });
        `];
        for (const enabled of [false, true]) {
            await runAddedHostedSession({ environment: { NODE_ENV: 'test' }, workingDirectory: cwd, end() {} }, async () => {
                const result = await probeAcpAgentCapabilities({ command: process.execPath, args, cwd,
                    env: { HAPPIER_TEST_ACP_SESSION_CAPABILITY: enabled ? 'enabled' : 'disabled' },
                    transport: new DefaultTransport('probe-environment-cache'), timeoutMs: null,
                });
                expect(result).toMatchObject({ ok: true, agentCapabilities: { loadSession: enabled } });
            });
        }
    });
});
