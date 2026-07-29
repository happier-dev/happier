import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, relative } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('scm RPC handlers (workingDirectory tilde)', () => {
    let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

    beforeAll(async () => {
        runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
                pluginIds: ['happier.scm.backend.git'],
            }),
        });
    });

    afterAll(async () => {
        await runtimeRegistryLease?.release();
        runtimeRegistryLease = null;
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    });

    it('expands ~ workingDirectory for repository detection when request.cwd is omitted', async () => {
        const originalHome = process.env.HOME;
        const originalUserProfile = process.env.USERPROFILE;

        const fakeHome = mkdtempSync(join(tmpdir(), 'happier-home-'));
        process.env.HOME = fakeHome;
        process.env.USERPROFILE = fakeHome;

        try {
            const workspace = mkdtempSync(join(fakeHome, 'happier-scm-tilde-'));
            git(workspace, ['init']);
            git(workspace, ['config', 'user.email', 'test@example.com']);
            git(workspace, ['config', 'user.name', 'Test User']);
            writeFileSync(join(workspace, 'a.txt'), 'a\n');
            git(workspace, ['add', 'a.txt']);
            git(workspace, ['commit', '-m', 'init']);

            const tildePath = `~/${relative(homedir(), workspace)}`;
            const { call } = createTestRpcManager({ workingDirectory: tildePath });

            const result = await call<any, {}>(RPC_METHODS.SCM_STATUS_SNAPSHOT, {});

            expect(result.success, JSON.stringify(result)).toBe(true);
            expect(result.snapshot.repo.isRepo).toBe(true);
            expect(realpathSync(result.snapshot.repo.rootPath)).toBe(realpathSync(workspace));
        } finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalUserProfile === undefined) {
                delete process.env.USERPROFILE;
            } else {
                process.env.USERPROFILE = originalUserProfile;
            }
        }
    });

    it('detects a repository when the machine working directory is the home directory and request.cwd is an absolute repo path', async () => {
        const originalHome = process.env.HOME;
        const originalUserProfile = process.env.USERPROFILE;

        const fakeHome = mkdtempSync(join(tmpdir(), 'happier-home-'));
        process.env.HOME = fakeHome;
        process.env.USERPROFILE = fakeHome;

        try {
            const workspace = mkdtempSync(join(fakeHome, 'happier-scm-absolute-'));
            git(workspace, ['init']);
            git(workspace, ['config', 'user.email', 'test@example.com']);
            git(workspace, ['config', 'user.name', 'Test User']);
            writeFileSync(join(workspace, 'a.txt'), 'a\n');
            git(workspace, ['add', 'a.txt']);
            git(workspace, ['commit', '-m', 'init']);

            const { call } = createTestRpcManager({ workingDirectory: fakeHome });

            const result = await call<any, { cwd: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, {
                cwd: workspace,
            });

            expect(result.success, JSON.stringify(result)).toBe(true);
            expect(result.snapshot.repo.isRepo).toBe(true);
            expect(realpathSync(result.snapshot.repo.rootPath)).toBe(realpathSync(workspace));
        } finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalUserProfile === undefined) {
                delete process.env.USERPROFILE;
            } else {
                process.env.USERPROFILE = originalUserProfile;
            }
        }
    });
});
