import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));

function getServerDir(): string {
    return resolve(currentDir, '..');
}

describe('runCommand.ts', () => {
    let tmpDir = '';

    afterEach(async () => {
        if (tmpDir) {
            await rm(tmpDir, { recursive: true, force: true });
            tmpDir = '';
        }
    });

    it('loads when only the server scripts directory is copied into an image layer', async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'happier-server-run-command-'));
        const copiedScriptsDir = join(tmpDir, 'repo', 'apps', 'server', 'scripts');
        await mkdir(copiedScriptsDir, { recursive: true });

        await writeFile(
            join(tmpDir, 'repo', 'apps', 'server', 'package.json'),
            await readFile(join(getServerDir(), 'package.json'), 'utf8'),
            'utf8',
        );
        const sourcePath = join(getServerDir(), 'scripts', 'runCommand.ts');
        const copiedPath = join(copiedScriptsDir, 'runCommand.ts');
        await writeFile(copiedPath, await readFile(sourcePath, 'utf8'), 'utf8');

        const importScript = [
            `const mod = await import(${JSON.stringify(pathToFileURL(copiedPath).href)});`,
            `if (typeof mod.runCommand !== 'function') throw new Error('missing runCommand export');`,
        ].join('\n');

        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', importScript], {
            cwd: getServerDir(),
            env: {
                ...process.env,
                NODE_OPTIONS: '',
            },
            encoding: 'utf8',
            stdio: 'pipe',
        });

        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    });

    it('ignores npm CLI paths when resolving Windows Yarn commands', async () => {
        const mod = await import('./runCommand');
        const resolver = (
            mod as {
                resolveServerScriptCommandInvocation?: (
                    cmd: string,
                    args: readonly string[],
                    env: NodeJS.ProcessEnv,
                    options: { platform: NodeJS.Platform; processExecPath: string; comspec: string },
                ) => { command: string; args: string[]; windowsVerbatimArguments?: boolean };
            }
        ).resolveServerScriptCommandInvocation;

        expect(typeof resolver).toBe('function');
        if (typeof resolver !== 'function') return;

        const invocation = resolver(
            'yarn',
            ['-s', 'schema:sync', '--quiet'],
            {
                npm_execpath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
                COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
            },
            {
                platform: 'win32',
                processExecPath: 'C:\\node\\node.exe',
                comspec: 'C:\\Windows\\System32\\cmd.exe',
            },
        );

        expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe');
        expect(invocation.windowsVerbatimArguments).toBe(true);
        expect(invocation.args.join(' ')).toContain('yarn.cmd');
        expect(invocation.args.join(' ')).not.toContain('npm-cli.js');
    });

    it('uses Yarn npm_execpath entries when resolving nested Yarn commands', async () => {
        const mod = await import('./runCommand');
        const resolver = (
            mod as {
                resolveServerScriptCommandInvocation?: (
                    cmd: string,
                    args: readonly string[],
                    env: NodeJS.ProcessEnv,
                    options: { platform: NodeJS.Platform; processExecPath: string },
                ) => { command: string; args: string[]; windowsVerbatimArguments?: boolean };
            }
        ).resolveServerScriptCommandInvocation;

        expect(typeof resolver).toBe('function');
        if (typeof resolver !== 'function') return;

        const invocation = resolver(
            'yarn',
            ['-s', 'schema:sync', '--quiet'],
            {
                npm_execpath: '/opt/yarn-v1.22.22/lib/cli.js',
            },
            {
                platform: 'linux',
                processExecPath: '/usr/local/bin/node',
            },
        );

        expect(invocation).toEqual({
            command: '/usr/local/bin/node',
            args: ['/opt/yarn-v1.22.22/lib/cli.js', '-s', 'schema:sync', '--quiet'],
        });
    });
});
