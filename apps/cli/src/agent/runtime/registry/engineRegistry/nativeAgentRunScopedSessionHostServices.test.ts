import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNativeAgentExecutionRunHostServices } from './nativeAgentSessionHostServiceOwners';
import { createAgentNativeHomeReadService } from '@/agent/runtime/nativeHomeFileService';

describe('createNativeAgentExecutionRunHostServices', () => {
    it('reads native auth and settles a Run-scoped daemon refresh without Session custody', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-run-auth-'));
        const controller = new AbortController();
        // Synthetic bytes at the filesystem boundary; no user credential is opened.
        await writeFile(join(root, 'auth.json'), '{"account":"run-member"}');
        const daemonRequests: unknown[] = [];
        const services = createNativeAgentExecutionRunHostServices({
            signal: controller.signal,
            executionRunId: 'detached-run',
            directory: root,
            machineId: 'machine-1',
            accountSettings: null,
            runtimeRegistry: null,
            pluginId: 'happier.agent.codex',
            agentId: 'codex',
            happyHomeDir: root,
            nativeHome: createAgentNativeHomeReadService({ root, declaredFileIds: ['auth.json'] })!,
            // The daemon transport is the system boundary; normalization remains real.
            refreshRuntimeAuthViaDaemon: async (request) => {
                daemonRequests.push(request);
                return { status: 'refreshed', result: { accessToken: 'synthetic-fresh', chatgptAccountId: 'run-member' } };
            },
        });
        try {
            const files = await services.nativeHome!.readFiles(['auth.json']);
            expect(new TextDecoder().decode(files['auth.json'])).toBe('{"account":"run-member"}');
            await expect(services.nativeHome!.readFiles(['undeclared.json'])).rejects.toThrow('credential_file_undeclared');
            await expect(services.auth!.services.refreshRuntimeAuth({
                serviceId: 'openai-codex',
                selection: { kind: 'profile', profileId: 'run-member' },
                expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                refreshAttemptId: 'attempt-run',
            })).resolves.toEqual({ status: 'refreshed', result: { accessToken: 'synthetic-fresh', chatgptAccountId: 'run-member' } });
            expect(daemonRequests).toEqual([expect.objectContaining({
                refreshAttemptId: 'attempt-run',
                selection: { kind: 'profile', profileId: 'run-member', serviceId: 'happier.agent.codex/openai-codex' },
            })]);
            expect(daemonRequests[0]).not.toHaveProperty('sessionId');
            controller.abort();
            await expect(services.auth!.services.refreshRuntimeAuth({ serviceId: 'openai-codex' })).rejects.toThrow();
            await expect(services.nativeHome!.readFiles(['auth.json'])).rejects.toThrow();
        } finally {
            controller.abort();
            await services.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('exposes only scope-neutral services and never projects a Run as a Session', async () => {
        const previous = process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
        const controller = new AbortController();
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-run-host-services-'));
        const services = createNativeAgentExecutionRunHostServices({
            signal: controller.signal,
            executionRunId: 'run-shared-host-services',
            directory: '/repo',
            machineId: 'machine-1',
            accountSettings: null,
            runtimeRegistry: null,
            runtimeAuthority: { runtimeCapabilities: ['sessionHooks'] },
            pluginId: 'happier.agent.acme',
            agentId: 'acme',
            happyHomeDir,
        });

        try {
            expect(Object.keys(services).sort()).toEqual([
                'dispose',
                'features',
                'fileFollow',
                'hooks',
                'mcp',
                'toolExecution',
            ]);
            delete process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
            expect(services.features.isEnabled('execution.runs')).toBe(true);
            process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = '0';
            expect(services.features.isEnabled('execution.runs')).toBe(false);
            await expect(services.mcp.resolveServers()).resolves.toEqual([]);
            await expect(services.toolExecution.before({
                callId: 'call-1',
                name: 'Read',
                input: { path: '/repo/README.md' },
            })).resolves.toEqual({
                status: 'continue',
                input: { path: '/repo/README.md' },
            });

            const forwarderAssets = await services.hooks.resolveForwarderAssets();
            expect(forwarderAssets.sessionForwarderScript).toContain('session_hook_forwarder.cjs');
            const pluginDir = await services.hooks.createPluginDir({
                files: [{ path: 'settings.json', json: { detached: true } }],
            });
            expect((await stat(pluginDir)).isDirectory()).toBe(true);
            const hookServer = await services.hooks.startServer({});
            expect(hookServer.port).toBeGreaterThan(0);
            await hookServer.dispose();

            expect(services.hooks).not.toHaveProperty('publishProviderTranscript');
            expect(services).not.toHaveProperty('transcripts');
            expect(services).not.toHaveProperty('accountUsage');
            expect(services).not.toHaveProperty('terminalHost');
            expect(services).not.toHaveProperty('workflowActivity');
            expect(services).not.toHaveProperty('subagents');
            controller.abort();
            expect(services.features.isEnabled('execution.runs')).toBe(false);
            await services.dispose();
            await expect(stat(pluginDir)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            controller.abort();
            await services.dispose();
            if (previous === undefined) {
                delete process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
            } else {
                process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = previous;
            }
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
