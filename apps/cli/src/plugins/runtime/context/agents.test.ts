import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import { createStablePluginExecService } from '../invocation/services/exec';
import { createAgentCliSystemToolService } from '../exec/system/tools/agentCliBinding';
import { createPluginExecSystemToolResolver } from '../exec/system/tools/resolveGrant';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { createPluginAgentCliReadinessService } from './agents';

function authorizedReadiness(input: Readonly<{
    env: NodeJS.ProcessEnv;
    authorizeLaunch?: Parameters<typeof createStablePluginExecService>[0]['authorizeLaunch'];
    readiness?: ReturnType<typeof createPluginAgentCliReadinessService>;
}>) {
    const definition = { toolId: 'claude-cli', displayName: 'Claude Code' };
    const systemTools = createAgentCliSystemToolService({
        agentId: 'claude',
        runtimeSpec: resolveAgentCliRuntimeSpecForLookupId('claude'),
        binding: { toolId: 'claude-cli' },
        definition,
        processEnv: input.env,
        delegate: createPluginExecSystemToolResolver({ definitions: [definition], registerGrant() {} }),
    });
    return createStablePluginExecService({
        environment: {
            PROBE_MARKER: input.env.PROBE_MARKER ?? '',
            PROBE_VERSION: input.env.PROBE_VERSION ?? '',
        },
        signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
        agentCli: input.readiness ?? createPluginAgentCliReadinessService({ processEnv: input.env }),
        systemTools,
        resolveExecutable: async () => { throw new Error('The already-resolved system tool must be retained'); },
        resolvePath: async () => input.env.HAPPIER_HOME_DIR!,
        ...(input.authorizeLaunch ? { authorizeLaunch: input.authorizeLaunch } : {}),
    }).agentCli;
}


const ENV_KEYS = [
    'HAPPIER_CLAUDE_PATH',
    'HAPPIER_CODEX_PATH',
    'HAPPIER_HOME_DIR',
    'HAPPIER_JS_RUNTIME_PATH',
    'HAPPIER_MANAGED_NODE_BIN',
    'HAPPIER_NODE_PATH',
    'PATH',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Partial<Record<typeof ENV_KEYS[number], string>>;
const tempDirs = new Set<string>();

async function writeExecutable(dir: string, name: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, ['#!/bin/sh', 'printf ready', ''].join('\n'), 'utf8');
    await chmod(path, 0o755);
    return path;
}

async function createIsolatedEnv(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happier-agent-cli-readiness-'));
    tempDirs.add(root);
    const emptyPath = join(root, 'empty-bin');
    await mkdir(emptyPath, { recursive: true });
    process.env.PATH = emptyPath;
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    await mkdir(process.env.HAPPIER_HOME_DIR, { recursive: true });
    delete process.env.HAPPIER_CODEX_PATH;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_NODE_PATH;
    process.env.HAPPIER_CLAUDE_PATH = await writeExecutable(root, 'claude');
}

afterEach(async () => {
    for (const key of ENV_KEYS) {
        const value = originalEnv[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('createPluginAgentCliReadinessService', () => {
    it('reuses an unchanged CLI version and observes an updated executable without a refresh timer', async () => {
        await createIsolatedEnv();
        const root = process.env.HAPPIER_HOME_DIR!;
        const marker = join(root, 'version-probe');
        const executable = join(root, 'claude-version.cjs');
        await writeFile(executable, [
            "require('node:fs').appendFileSync(process.env.PROBE_MARKER, process.env.PROBE_VERSION);",
            "console.log(process.env.PROBE_VERSION + ' (Claude Code)');",
        ].join('\n'));
        const service = authorizedReadiness({
            env: {
                ...process.env,
                HAPPIER_CLAUDE_PATH: executable,
                HAPPIER_JS_RUNTIME_PATH: process.execPath,
                PROBE_MARKER: marker,
                PROBE_VERSION: '2.1.71',
            },
        });

        expect(await service.checkReadiness({
            candidates: ['claude'], requirement: 'any',
        })).toEqual({ launchable: [{ agentId: 'claude' }] });
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await service.checkReadiness({
            candidates: ['claude'], requirement: 'any', includeVersion: true,
        })).toEqual({ launchable: [{ agentId: 'claude', version: '2.1.71' }] });
        expect(await readFile(marker, 'utf8')).toBe('2.1.71');
        expect(await service.checkReadiness({
            candidates: ['claude'], requirement: 'any', includeVersion: true,
        })).toEqual({ launchable: [{ agentId: 'claude', version: '2.1.71' }] });
        expect(await readFile(marker, 'utf8')).toBe('2.1.71');

        await writeFile(executable, [
            "require('node:fs').appendFileSync(process.env.PROBE_MARKER, 'updated');",
            "console.log('2.1.72 (Claude Code)');",
        ].join('\n'));
        expect(await service.checkReadiness({
            candidates: ['claude'], requirement: 'any', includeVersion: true,
        })).toEqual({ launchable: [{ agentId: 'claude', version: '2.1.72' }] });
        expect(await readFile(marker, 'utf8')).toBe('2.1.71updated');

        const cancelled = AbortSignal.abort();
        await expect(service.checkReadiness({
            candidates: ['claude'], requirement: 'any', includeVersion: true, signal: cancelled,
        })).rejects.toMatchObject({ code: 'plugin_exec_aborted' });
        await rm(executable);
        expect(await service.checkReadiness({
            candidates: ['claude'], requirement: 'any', includeVersion: true,
        })).toEqual({ launchable: [] });
    });

    it('keeps shared readiness version observations bound to the invoking Exec environment', async () => {
        await createIsolatedEnv();
        const root = process.env.HAPPIER_HOME_DIR!;
        const marker = join(root, 'scoped-version-probe');
        const executable = join(root, 'claude-scoped.cjs');
        await writeFile(executable, [
            "require('node:fs').appendFileSync(process.env.PROBE_MARKER, process.env.PROBE_VERSION);",
            "console.log(process.env.PROBE_VERSION + ' (Claude Code)');",
        ].join('\n'));
        const env = { ...process.env, HAPPIER_CLAUDE_PATH: executable,
            HAPPIER_JS_RUNTIME_PATH: process.execPath, PROBE_MARKER: marker };
        const readiness = createPluginAgentCliReadinessService({ processEnv: env });
        const first = authorizedReadiness({ env: { ...env, PROBE_VERSION: '2.1.71' }, readiness });
        const second = authorizedReadiness({ env: { ...env, PROBE_VERSION: '2.1.72' }, readiness });
        const request = { candidates: ['claude'], requirement: 'any', includeVersion: true } as const;
        expect(await first.checkReadiness(request)).toEqual({ launchable: [{ agentId: 'claude', version: '2.1.71' }] });
        expect(await first.checkReadiness(request)).toEqual({ launchable: [{ agentId: 'claude', version: '2.1.71' }] });
        expect(await second.checkReadiness(request)).toEqual({ launchable: [{ agentId: 'claude', version: '2.1.72' }] });
        expect(await readFile(marker, 'utf8')).toBe('2.1.712.1.72');
    });

    it('refuses a denied version launch without running the CLI', async () => {
        await createIsolatedEnv();
        const root = process.env.HAPPIER_HOME_DIR!;
        const marker = join(root, 'denied-version-probe');
        const executable = join(root, 'claude-denied.cjs');
        await writeFile(executable, "require('node:fs').writeFileSync(process.env.PROBE_MARKER, 'unexpected');console.log('2.1.71');");
        const service = authorizedReadiness({
            env: {
                ...process.env,
                HAPPIER_CLAUDE_PATH: executable,
                HAPPIER_JS_RUNTIME_PATH: process.execPath,
                PROBE_MARKER: marker,
            },
            // This callback is the host approval boundary; denial must precede OS execution.
            authorizeLaunch: async () => {
                throw new PluginError({ code: 'plugin_exec_denied', message: 'The controller denied the version probe' });
            },
        });
        await expect(service.checkReadiness({
            candidates: ['claude'], requirement: 'any', includeVersion: true,
        })).rejects.toMatchObject({ code: 'plugin_exec_denied' });
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('cancels a running version probe through the request signal', async () => {
        await createIsolatedEnv();
        const root = process.env.HAPPIER_HOME_DIR!;
        const marker = join(root, 'running-version-probe');
        const executable = join(root, 'claude-hanging.cjs');
        await writeFile(executable, [
            "require('node:fs').writeFileSync(process.env.PROBE_MARKER, 'started');",
            'setInterval(() => {}, 1000);',
        ].join('\n'));
        const controller = new AbortController();
        const service = authorizedReadiness({
            env: {
                ...process.env,
                HAPPIER_CLAUDE_PATH: executable,
                HAPPIER_JS_RUNTIME_PATH: process.execPath,
                PROBE_MARKER: marker,
            },
        });
        const pending = service.checkReadiness({
            candidates: ['claude'], requirement: 'any', includeVersion: true,
            signal: controller.signal,
        });
        const rejection = expect(pending).rejects.toThrow();
        try {
            await Promise.race([
                pending.then(() => { throw new Error('Readiness settled before the version probe started'); }),
                (async () => {
                    while (!controller.signal.aborted) {
                        try { await access(marker); return; } catch { /* Wait for the process boundary. */ }
                        await new Promise((resolve) => setTimeout(resolve, 0));
                    }
                })(),
            ]);
        } finally {
            controller.abort();
            await rejection;
        }
    });

    it('reports any-candidate agent CLI readiness from provider CLI resolution', async () => {
        await createIsolatedEnv();
        const service = createPluginAgentCliReadinessService();

        const result = await service.checkReadiness({
            candidates: ['claude', 'codex'],
            requirement: 'any',
            cwd: '/repo',
        });

        expect(result).toEqual({ launchable: [{ agentId: 'claude' }] });
    });

    it('describes launchable agent CLI candidates without claiming auth or build-policy readiness', async () => {
        await createIsolatedEnv();
        const service = createPluginAgentCliReadinessService();

        const result = await service.checkReadiness({
            candidates: ['claude'],
            requirement: 'any',
        });

        expect(result).toEqual({ launchable: [{ agentId: 'claude' }] });
    });

    it('reports all-candidate agent CLI readiness as missing when one candidate is unavailable', async () => {
        await createIsolatedEnv();
        const service = createPluginAgentCliReadinessService();

        const result = await service.checkReadiness({
            candidates: ['claude', 'codex'],
            requirement: 'all',
        });

        expect(result.launchable.map((entry) => entry.agentId)).toEqual(['claude']);
    });
});
