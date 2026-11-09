import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { authorizePluginExecLaunchForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from './deploymentExecEnvPort';

it('allows trusted launch placement while preserving admitted phase and source lifetime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-build-directory-'));
    const sourceRoot = join(root, 'source');
    const launchCwd = join(root, 'native');
    await mkdir(sourceRoot); await mkdir(launchCwd);
    const signal = new AbortController().signal;
    const executable = { kind: 'systemTool', id: 'docker' } as const;
    const exec = createStablePluginExecService({ signal,
        isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/docker' }),
        resolvePath: async () => launchCwd });
    let current = true;
    const source = { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment',
        machineId: 'builder', installationId: 'installed', rootPath: sourceRoot, manifestFingerprint: 'manifest',
        async assertCurrent() { if (!current) throw Object.assign(new Error('withdrawn'), { code: 'approval_stale' }); },
        async commit() {}, async abort() {} };
    const prepare = async () => ({ env: {}, secretValues: [], refs: [], async recheck() {}, dispose() {} });
    try {
        const ordinary = createDeploymentExecEnvPortForHost({ source, signal, phase: 'build',
            isCurrent: () => true, prepare });
        const ordinaryLaunch = await authorizePluginExecLaunchForHost(exec, { executable, cwd: launchCwd,
            deploymentEnv: await ordinary.prepare({ source, phase: 'build' }) }, { agentIsolation: null });
        try { expect(ordinaryLaunch.cwd).toBe(launchCwd); }
        finally { await ordinaryLaunch.release(); }
        const buildInput = { source, signal, phase: 'build' as const, isCurrent: () => true, prepare };
        const build = createDeploymentExecEnvPortForHost(buildInput);
        const launch = await authorizePluginExecLaunchForHost(exec, { executable, cwd: launchCwd,
            deploymentEnv: await build.prepare({ source, phase: 'build' }) }, { agentIsolation: null });
        try {
            expect(launch.cwd).toBe(launchCwd);
            current = false;
            await expect(launch.recheckInputs?.()).rejects.toMatchObject({ code: 'approval_stale' });
        } finally { await launch.release(); }
        current = true;
        const runtimeInput = { ...buildInput, phase: 'runtime' as const };
        const runtime = createDeploymentExecEnvPortForHost(runtimeInput);
        await expect(runtime.prepare({ source, phase: 'build' })).rejects.toMatchObject({ code: 'unavailable' });
        const runtimeAttachment = await runtime.prepare({ source, phase: 'runtime' });
        runtimeAttachment.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
});
