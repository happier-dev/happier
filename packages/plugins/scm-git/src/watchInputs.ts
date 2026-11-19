import { readCurrentBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { join, resolve } from 'node:path';

import { inspectGitCheckoutIdentity } from './checkoutIdentity.js';
import { buildScmNonInteractiveEnv } from './providers/shared/nonInteractiveEnv.js';
import { readScmEnvironment, runScmCommand } from './runtime.js';
import type { ScmBackend } from './types.js';

/** Git owns both checkout metadata resolution and ignore configuration sources. */
export const readGitWorkspaceWatchInputs: NonNullable<NonNullable<ScmBackend['workspaceIntegration']>['watchInputs']> = async ({ context }) => {
    const identity = await inspectGitCheckoutIdentity({ cwd: context.cwd });
    if (!identity) throw Object.assign(new Error('Git checkout metadata is unavailable.'), { code: 'COMMAND_FAILED' });
    const env = buildScmNonInteractiveEnv();
    const environment = readScmEnvironment();
    const [origins, excludes, globalConfig, systemConfig] = await Promise.all([
        runScmCommand({ bin: 'git', cwd: context.cwd, env,
            args: ['config', '--show-origin', '--name-only', '--null', '--list', '--includes'] }),
        runScmCommand({ bin: 'git', cwd: context.cwd, env,
            args: ['config', '--path', '--default', `${environment.XDG_CONFIG_HOME || '~/.config'}/git/ignore`, '--get', 'core.excludesFile'] }),
        runScmCommand({ bin: 'git', cwd: context.cwd, env, args: ['var', 'GIT_CONFIG_GLOBAL'] }),
        runScmCommand({ bin: 'git', cwd: context.cwd, env, args: ['var', 'GIT_CONFIG_SYSTEM'] }),
    ]);
    if (!origins.success || !excludes.success || !globalConfig.success || !systemConfig.success) {
        throw Object.assign(new Error('Git ignore configuration sources are unavailable.'), { code: 'COMMAND_FAILED' });
    }
    const commandPaths = readCurrentBackendRuntimeServices()?.repositoryFileSystem?.commandPaths;
    const commandDirectory = commandPaths?.toCommandPath(context.cwd) ?? context.cwd;
    const metadata = [
        join(identity.gitDirPath, 'HEAD'), join(identity.gitDirPath, 'index'),
        join(identity.gitDirPath, 'config.worktree'), join(identity.commonDirPath, 'config'),
        join(identity.commonDirPath, 'packed-refs'), join(identity.commonDirPath, 'info', 'exclude'),
        join(identity.commonDirPath, 'refs', 'stash'),
    ];
    if (identity.branchName) metadata.push(join(identity.commonDirPath, 'refs', 'heads', identity.branchName));
    const paths = new Set(metadata.map(path => commandPaths?.fromCommandPath(path) ?? path));
    function addConfigPath(path: string): void {
        const absolute = resolve(commandDirectory, path);
        try {
            paths.add(commandPaths?.fromCommandPath(absolute) ?? absolute);
        } catch (error) {
            // System and global configuration outside the admitted workspace are not observable here.
            if (error instanceof Error && 'code' in error && error.code === 'workspace_root_unsafe') return;
            throw error;
        }
    }
    const fields = origins.stdout.split('\0');
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const origin = fields[index];
        if (origin.startsWith('file:')) addConfigPath(origin.slice('file:'.length));
    }
    // Origins omit absent files. Git's own candidates keep first creation observable too.
    for (const config of [globalConfig, systemConfig]) {
        for (const path of config.stdout.split(/\r?\n/u).filter(Boolean)) addConfigPath(path);
    }
    const excludePath = excludes.stdout.trim();
    if (excludePath) addConfigPath(excludePath);
    return { paths: [...paths], workspaceFileNames: ['.gitignore', '.git'] };
};
