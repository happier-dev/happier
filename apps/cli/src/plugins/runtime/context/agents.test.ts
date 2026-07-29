import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPluginAgentCliReadinessService } from './agents';

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
