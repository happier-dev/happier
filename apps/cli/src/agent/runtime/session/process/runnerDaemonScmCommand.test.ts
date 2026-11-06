import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createRunnerDaemonPluginServicesHost } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { ScmCommandRunner } from '@/scm/runtime';
import { withTempDir } from '@/testkit/fs/tempDir';
import {
    decodeRunnerDaemonPluginServiceWireValueV1,
    RunnerDaemonPluginServiceOperationV1Schema,
} from './agentRuntimeDaemonPluginServicesProtocol';
import { prepareRunnerDaemonPluginServices } from './runnerDaemonPluginServices';

describe('runner daemon SCM commands', () => {
    it('preserves real Git success and command failure through the daemon response boundary', async () => {
        await withTempDir('happier-runner-scm-', async cwd => {
            execFileSync('git', ['init', '-q'], { cwd });
            const services = createUnavailablePluginServices();
            const lifetime = new AbortController();
            const retainedAgent = createAgentSessionRunnerFactoryBinding({
                v: 1, pluginId: 'fixture.plugin', pluginVersion: '1.0.0', agentId: 'fixture.agent', localAgentId: 'agent',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'localPath' },
                locator: { module: './agent.js', export: 'createRuntime', runtimeApiVersion: 1 },
                normalizedModulePath: '/plugins/fixture/agent.js', loadMode: 'immutable-js',
            });
            const host = createRunnerDaemonPluginServicesHost({
                async createInvocation() {
                    return {
                        services,
                        agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' as const }, workspaceRoots: [] }) },
                        resourceDescriptors: {},
                        subscriptionCapabilities: { settingsWatch: false, eventSubscriptions: [], resourceWatches: [], notificationPreferencesWatch: false },
                        authorizeOperation: () => true,
                        executeCurrentGlobalAction: services.actions.execute,
                        currentGlobalMcp: services.mcp,
                        currentGlobalExternalSessions: services.sessions.external,
                        dispose() {},
                    };
                },
            });
            let run: ScmCommandRunner | undefined;
            try {
                await prepareRunnerDaemonPluginServices({
                    invocationId: 'scm-session', signal: lifetime.signal, local: services,
                    bindHostScmCommandRunner: runner => { run = runner; },
                    dispatch: async (operation, options) => {
                        const response = await host.dispatch({
                            sessionId: 'scm-session', retainedAgent,
                            runner: { pid: 123, processStartTimeMs: 1, processCommandHash: '4'.repeat(64), snapshotIdentity: 'snapshot-1' },
                            operation: RunnerDaemonPluginServiceOperationV1Schema.parse(operation),
                            ...options,
                        });
                        return decodeRunnerDaemonPluginServiceWireValueV1(response.value);
                    },
                });
                if (!run) throw new Error('Missing host SCM binding');
                expect(await run({ bin: 'git', cwd, args: ['rev-parse', '--is-inside-work-tree'] }))
                    .toMatchObject({ success: true, stdout: 'true\n', exitCode: 0, aborted: false });
                const failed = await run({ bin: 'git', cwd, args: ['rev-parse', '--verify', 'refs/heads/missing'] });
                expect(failed).toMatchObject({ success: false, exitCode: 128, aborted: false });
                expect(failed.stderr).not.toBe('scm_exec_unavailable');
            } finally {
                lifetime.abort();
                await host.dispose();
            }
        });
    });
});
