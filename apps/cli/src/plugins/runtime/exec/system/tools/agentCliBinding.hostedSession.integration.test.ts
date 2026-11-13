import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { bindAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

it.each([false, true])('uses the Session CLI through admitted Agent services (retained launch: %s)', async retained => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-hosted-agent-cli-'));
    let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
        const paths = Object.fromEntries(await Promise.all(['first', 'second', 'retained'].map(async label => {
            const path = join(directory, `${label}.cjs`);
            await writeFile(path, `process.stdout.write(${JSON.stringify(label)});\n`);
            return [label, path] as const;
        })));
        admitted = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { pluginIds: ['happier.agent.claude'] },
        });
        const registry = admitted.registry;
        await registry.activateContributionsOnDemand([{ pluginId: 'happier.agent.claude', family: 'agents', localId: 'claude' }]);
        const agent = registry.agentRuntimesByAgentId.get('claude');
        if (!agent) throw new Error('Expected admitted Claude Agent');
        await Promise.all(['first', 'second'].map(label => runAddedHostedSession({
            environment: { ...process.env, HAPPIER_CLAUDE_PATH: paths[label], HAPPIER_JS_RUNTIME_PATH: process.execPath },
            workingDirectory: directory,
            end: () => undefined,
        }, async () => {
            // Runtime-surface invocations (including handoff) have no retained
            // launch. The explicit retained binding is the neighbouring control.
            const services = retained
                ? await registry.createAgentInvocationServices({
                    pluginId: agent.pluginId, pluginVersion: agent.pluginVersion, agentId: agent.agentId,
                    occurrenceId: agent.occurrenceId, correlationId: label, cwd: directory,
                    signal: new AbortController().signal, isOccurrenceCurrent: agent.isCurrent,
                    agentCliLaunch: bindAgentCliLaunchSpec({ localAgentId: 'claude', spec: {
                        source: 'override', resolvedPath: paths.retained!, command: process.execPath, args: [paths.retained!],
                    } }),
                })
                : (await agent.createAgentRuntimeSurfaceInvocationContext({ cwd: directory })).services;
            const tool = await services.exec.systemTools.resolve({ toolId: 'claude-cli', purpose: 'Run Session CLI', cwd: directory });
            expect(tool.executablePath).toBe(paths[retained ? 'retained' : label]);
            const result = await services.exec.run({ executable: tool.executable, args: [], cwd: directory });
            expect(result.termination.observed).toMatchObject({ kind: 'exit', exitCode: 0 });
            expect(new TextDecoder().decode(result.stdout)).toBe(retained ? 'retained' : label);
        })));
    } finally {
        await admitted?.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});
