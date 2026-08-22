import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveExecutablePluginRuntimeRegistry } from '../../../resolveExecutablePluginRuntimeRegistry';

type AgentCliBindingFixture = Readonly<{
    agentId: 'claude' | 'codex' | 'opencode';
    pluginId: string;
    systemToolId: string;
    overrideEnvKey: 'HAPPIER_CLAUDE_PATH' | 'HAPPIER_CODEX_PATH' | 'HAPPIER_OPENCODE_PATH';
    readableJavaScriptOverride: boolean;
    invokeResolvedTool: boolean;
}>;

const fixtures: readonly AgentCliBindingFixture[] = Object.freeze([
    {
        agentId: 'claude',
        pluginId: 'happier.agent.claude',
        systemToolId: 'claude-cli',
        overrideEnvKey: 'HAPPIER_CLAUDE_PATH',
        readableJavaScriptOverride: true,
        invokeResolvedTool: true,
    },
    {
        agentId: 'opencode',
        pluginId: 'happier.agent.opencode',
        systemToolId: 'opencode-cli',
        overrideEnvKey: 'HAPPIER_OPENCODE_PATH',
        readableJavaScriptOverride: false,
        invokeResolvedTool: false,
    },
    {
        agentId: 'codex',
        pluginId: 'happier.agent.codex',
        systemToolId: 'codex-cli',
        overrideEnvKey: 'HAPPIER_CODEX_PATH',
        readableJavaScriptOverride: false,
        invokeResolvedTool: true,
    },
]);

describe('Agent CLI system-tool binding (integration)', () => {
    it.each(fixtures)(
        'keeps the canonical $agentId override ahead of a different PATH executable through activated runtime services',
        async (fixture) => {
            if (fixture.readableJavaScriptOverride && process.platform === 'win32') {
                return;
            }

            const happyHomeDir = await mkdtemp(join(tmpdir(), `happier-${fixture.agentId}-binding-home-`));
            const toolRoot = await mkdtemp(join(tmpdir(), `happier-${fixture.agentId}-binding-tools-`));
            const overridePath = join(
                toolRoot,
                fixture.readableJavaScriptOverride
                    ? `${fixture.agentId}-override.js`
                    : `${fixture.agentId}-override`,
            );
            const pathExecutable = join(
                toolRoot,
                process.platform === 'win32' ? `${fixture.agentId}.cmd` : fixture.agentId,
            );
            const previousPath = process.env.PATH;
            const previousOverride = process.env[fixture.overrideEnvKey];
            const previousJavaScriptRuntime = process.env.HAPPIER_JS_RUNTIME_PATH;
            const expectedOutput = `override-${fixture.agentId}`;

            await writeFile(
                overridePath,
                fixture.readableJavaScriptOverride
                    ? `process.stdout.write(${JSON.stringify(expectedOutput)});\n`
                    : process.platform === 'win32'
                        ? `@echo off\r\n<nul set /p "=${expectedOutput}"\r\n`
                        : `#!/bin/sh\nprintf %s ${JSON.stringify(expectedOutput)}\n`,
                'utf8',
            );
            await chmod(overridePath, fixture.readableJavaScriptOverride ? 0o644 : 0o755);
            await writeFile(
                pathExecutable,
                process.platform === 'win32'
                    ? '@echo off\r\n<nul set /p "=path-executable"\r\n'
                    : '#!/bin/sh\nprintf %s path-executable\n',
                'utf8',
            );
            await chmod(pathExecutable, 0o755);
            process.env.PATH = `${toolRoot}${delimiter}${previousPath ?? ''}`;
            process.env[fixture.overrideEnvKey] = overridePath;
            process.env.HAPPIER_JS_RUNTIME_PATH = process.execPath;

            const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                pluginIds: [fixture.pluginId],
            });
            try {
                await runtimeRegistry.activateContributionsOnDemand([{
                    pluginId: fixture.pluginId,
                    family: 'agents',
                    localId: fixture.agentId,
                }]);
                const services = await runtimeRegistry.createAgentInvocationServices({
                    pluginId: fixture.pluginId,
                    pluginVersion: '0.0.0',
                    agentId: fixture.agentId,
                    generation: String(runtimeRegistry.generation),
                    correlationId: `${fixture.agentId}-binding`,
                    cwd: toolRoot,
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                });

                const resolved = await services.exec.systemTools.resolve({
                    toolId: fixture.systemToolId,
                    purpose: `Launch ${fixture.agentId}`,
                    cwd: toolRoot,
                });
                expect(resolved).toMatchObject({
                    executablePath: overridePath,
                });
                if (fixture.invokeResolvedTool) {
                    const result = await services.exec.run({
                        executable: resolved.executable,
                        args: [],
                        cwd: { root: 'workspace', relativePath: '' },
                    });
                    expect(result.termination.observed).toMatchObject({
                        kind: 'exit',
                        exitCode: 0,
                    });
                    expect(new TextDecoder().decode(result.stdout)).toBe(expectedOutput);
                }
            } finally {
                await runtimeRegistry.dispose();
                if (previousPath === undefined) delete process.env.PATH;
                else process.env.PATH = previousPath;
                if (previousOverride === undefined) delete process.env[fixture.overrideEnvKey];
                else process.env[fixture.overrideEnvKey] = previousOverride;
                if (previousJavaScriptRuntime === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
                else process.env.HAPPIER_JS_RUNTIME_PATH = previousJavaScriptRuntime;
                await rm(happyHomeDir, { recursive: true, force: true });
                await rm(toolRoot, { recursive: true, force: true });
            }
        },
    );
});
