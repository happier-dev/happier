import { describe, expect, it } from 'vitest';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createAgentCliSystemToolService, createRetainedAgentCliSystemToolService } from './agentCliBinding';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { resolveNativeAgentLaunchEnvironment } from '@/agent/runtime/launchEnvironment';

describe('Agent CLI system-tool startup prerequisite', () => {
    it('preserves command lookup through the retained Agent CLI grant and real Exec launch', async () => {
        const home = createTempDirSync('happier-retained-agent-environment-');
        try {
            const entrypoint = join(home, 'agent.cjs');
            await writeFile(entrypoint, 'process.stdout.write(JSON.stringify({path:process.env.PATH??null,extensions:process.env.PATHEXT??null,hasCredential:process.env.HOST_CREDENTIAL!==undefined}))');
            const environment = resolveNativeAgentLaunchEnvironment({
                processEnv: { ...process.env, HOST_CREDENTIAL: 'must-not-reach-agent' },
            });
            const service = createStablePluginExecService({ environment: {},
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                systemTools: createRetainedAgentCliSystemToolService({
                    agentId: 'fixture', binding: { toolId: 'agent-cli' },
                    definition: { toolId: 'agent-cli', displayName: 'Agent CLI', lookupNames: [] },
                    launch: { source: 'system', resolvedPath: entrypoint, command: process.execPath, args: [entrypoint] },
                    delegate: { async resolve() { throw new Error('The retained CLI must remain exact'); } },
                }),
                async resolveExecutable() { throw new Error('A retained grant must not resolve the CLI again'); },
                async resolvePath() { throw new Error('No path resolution is required'); },
            });
            const granted = await service.systemTools.resolve({ toolId: 'agent-cli', purpose: 'Verify native command lookup' });
            const result = await service.run({ executable: granted.executable, env: environment.values });
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
                path: process.env.PATH ?? null, extensions: process.platform === 'win32' ? process.env.PATHEXT ?? null : null,
                hasCredential: false,
            });
        } finally { removeTempDirSync(home); }
    });

    it('resolves an explicitly selected path through the canonical Agent CLI launch owner', async () => {
        const home = createTempDirSync('happier-selected-agent-system-tool-');
        try {
            const selected = writeExecutableShimSync({ dir: home, fileName: process.platform === 'win32' ? 'selected.cmd' : 'selected',
                contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
            const service = createAgentCliSystemToolService({
                agentId: 'fixture',
                runtimeSpec: {
                    id: 'fixture', title: 'Fixture', binaryName: 'missing-agent',
                    knownUserBinDirSuffixes: [], sourcePreferenceDefault: 'system-first',
                    managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: null,
                    acceptsJavaScriptFileOverride: false,
                },
                binding: { toolId: 'agent-cli' },
                definition: { toolId: 'agent-cli', displayName: 'Agent CLI', lookupNames: ['missing-agent'] },
                processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home },
                delegate: { async resolve() { throw new Error('Selected Agent CLI must use its canonical owner'); } },
            });
            await expect(service.resolve({ toolId: 'agent-cli', purpose: 'Inspect Agent', preferredPath: selected }))
                .resolves.toMatchObject({ executablePath: selected });
        } finally { removeTempDirSync(home); }
    });

    it('reports a missing CLI through the public PluginError contract with safe remediation', async () => {
        const home = createTempDirSync('happier-missing-agent-system-tool-');
        const agentId = 'private-agent-identity';
        try {
            const service = createAgentCliSystemToolService({
                agentId,
                runtimeSpec: {
                    id: agentId, title: 'Private Agent', binaryName: 'private-agent',
                    knownUserBinDirSuffixes: [], sourcePreferenceDefault: 'system-first',
                    managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: null,
                    acceptsJavaScriptFileOverride: false,
                },
                binding: { toolId: 'agent-cli' },
                definition: { toolId: 'agent-cli', displayName: 'Agent CLI', lookupNames: ['private-agent'] },
                processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home },
                delegate: { async resolve() { throw new Error('Unrelated tool must not be resolved'); } },
            });
            const failure = await service.resolve({ toolId: 'agent-cli', purpose: 'Open Agent Session' })
                .then(() => undefined, (error: unknown) => error);
            expect(isPluginError(failure)).toBe(true);
            expect(failure).toMatchObject({ code: 'agent_cli_missing', retryable: false });
            if (!isPluginError(failure)) throw new Error('Expected the canonical PluginError contract');
            expect(failure.message).toMatch(/install.*CLI|CLI.*install/iu);
            expect(failure.message).not.toContain(agentId);
            expect(failure.message).not.toContain(home);
        } finally {
            removeTempDirSync(home);
        }
    });
});
