import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isPluginError } from '@happier-dev/plugin-sdk';

import { createPluginExecSystemToolResolver } from './resolveGrant';

const temporaryRoots = new Set<string>();

afterEach(async () => {
    await Promise.all([...temporaryRoots].map(async (root) => {
        await rm(root, { recursive: true, force: true });
        temporaryRoots.delete(root);
    }));
});

describe('createPluginExecSystemToolResolver', () => {
    it('names the missing declared tool and safe remedy without disclosing lookup paths', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-missing-'));
        temporaryRoots.add(root);
        const resolver = createPluginExecSystemToolResolver({
            definitions: [{ toolId: 'docker', displayName: 'Docker', lookupNames: ['docker'] }],
            baseEnv: { PATH: root },
            registerGrant() { throw new Error('Missing tool must not issue a grant'); },
        });
        const failure = await resolver.resolve({ toolId: 'docker', purpose: 'deployment-native-compose',
            preferredPath: join(root, 'private-install', 'docker') }).catch((error: unknown) => error);
        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'plugin_exec_system_tool_unavailable',
            details: { kind: 'systemToolUnavailable', toolId: 'docker', remedy: 'install_on_machine_and_add_to_daemon_path' } });
        expect(JSON.stringify(failure)).not.toContain(root);
    });

    it.skipIf(process.platform === 'win32')('keeps the granted executable exact while descendants resolve commands through the host PATH', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-descendants-'));
        temporaryRoots.add(root);
        const selected = join(root, 'selected-agent');
        await writeFile(selected, '#!/bin/sh\nexec descendant-command\n', { mode: 0o755 });
        await writeFile(join(root, 'descendant-command'), '#!/bin/sh\nprintf descendant-ok\n', { mode: 0o755 });
        await writeFile(join(root, 'agent'), '#!/bin/sh\nprintf substituted-agent\n', { mode: 0o755 });
        const hostEnvironment = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ''}` };
        const resolver = createPluginExecSystemToolResolver({
            definitions: [{ toolId: 'agent-cli', displayName: 'Agent', lookupNames: ['agent'] }],
            baseEnv: hostEnvironment,
            registerGrant() {},
        });
        const grant = await resolver.resolve({ toolId: 'agent-cli', purpose: 'Run selected Agent', preferredPath: selected });
        const observed = spawnSync(grant.launch.executablePath, [...(grant.launch.args ?? [])], {
            env: { ...hostEnvironment, ...grant.launch.env }, encoding: 'utf8',
        });
        expect(grant.launch.executablePath).toBe(selected);
        expect(observed.error).toBeUndefined();
        expect(observed.status).toBe(0);
        expect(observed.stdout).toBe('descendant-ok');
    });

    it('projects a host-private readable JavaScript preferred path through the captured runtime', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-runtime-'));
        temporaryRoots.add(root);
        const entryPoint = join(root, 'tool.js');
        const javascriptRuntime = join(root, 'explicit-js-runtime');
        await writeFile(entryPoint, 'process.stdout.write("agent-cli");\n', { mode: 0o644 });
        await writeFile(javascriptRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const resolver = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'javascript-tool',
                displayName: 'JavaScript tool',
                lookupNames: [],
            }],
            baseEnv: {
                HAPPIER_JS_RUNTIME_PATH: javascriptRuntime,
                PATH: '',
            },
            preferredPathAccess: 'readable-javascript',
            registerGrant() {},
        });

        await expect(resolver.resolve({
            toolId: 'javascript-tool',
            purpose: 'Prove captured runtime identity',
            preferredPath: entryPoint,
        })).resolves.toMatchObject({
            executablePath: entryPoint,
            launch: {
                executablePath: javascriptRuntime,
                args: [entryPoint],
            },
        });
    });

    it('keeps an ordinary executable JavaScript tool direct with its declared arguments', async () => {
        if (process.platform === 'win32') return;

        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-direct-js-'));
        temporaryRoots.add(root);
        const entryPoint = join(root, 'tool.js');
        const javascriptRuntime = join(root, 'should-not-run');
        await writeFile(entryPoint, '#!/bin/sh\nprintf direct\n', { mode: 0o755 });
        await writeFile(javascriptRuntime, '#!/bin/sh\nexit 99\n', { mode: 0o755 });

        const resolver = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'javascript-tool',
                displayName: 'JavaScript tool',
                lookupNames: [],
                defaultArgs: ['--declared'],
            }],
            baseEnv: {
                HAPPIER_JS_RUNTIME_PATH: javascriptRuntime,
                PATH: '',
            },
            registerGrant() {},
        });

        await expect(resolver.resolve({
            toolId: 'javascript-tool',
            purpose: 'Preserve the executable system tool shebang',
            preferredPath: entryPoint,
        })).resolves.toMatchObject({
            executablePath: entryPoint,
            launch: {
                executablePath: entryPoint,
                args: ['--declared'],
            },
        });
    });

    it('keeps readable non-executable JavaScript entrypoints unavailable for ordinary system tools', async () => {
        if (process.platform === 'win32') return;

        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-readable-js-'));
        temporaryRoots.add(root);
        const entryPoint = join(root, 'tool.js');
        await writeFile(entryPoint, 'process.stdout.write("should-not-run");\n', { mode: 0o644 });

        const resolver = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'javascript-tool',
                displayName: 'JavaScript tool',
                lookupNames: [],
            }],
            baseEnv: {
                HAPPIER_JS_RUNTIME_PATH: process.execPath,
                PATH: '',
            },
            registerGrant() {},
        });

        const failure = await resolver.resolve({
            toolId: 'javascript-tool',
            purpose: 'Do not broaden generic system tools',
            preferredPath: entryPoint,
        }).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'plugin_exec_system_tool_unavailable',
            diagnostics: [{
                code: 'system_tool_missing',
                severity: 'error',
            }],
        });
    });

    /**
     * Vendors publish Windows agent CLIs as `PATHEXT` shims (`droid.cmd`,
     * `fx.cmd`, …) while every plugin manifest declares the bare executable
     * name. Joining a PATH root with the bare name alone never finds those, so
     * a Windows install the vendor recipe just performed stays undetected.
     */
    it('resolves a declared lookup name through the host PATHEXT shim list', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-windows-shim-'));
        temporaryRoots.add(root);
        const shim = join(root, 'droid.cmd');
        await writeFile(shim, '@echo off\r\n', { mode: 0o755 });
        // A decoy the default extension list would prefer over `.CMD`. It must
        // lose, because this host's PATHEXT names only `.CMD` — which proves the
        // user's PATHEXT reaches the resolver instead of a built-in default.
        await writeFile(join(root, 'droid.bat'), '@echo off\r\n', { mode: 0o755 });

        const resolver = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'droid-cli',
                displayName: 'Factory Droid CLI',
                lookupNames: ['droid'],
            }],
            baseEnv: {
                PATH: root,
                PATHEXT: '.CMD',
            },
            platform: 'win32',
            registerGrant() {},
        });

        await expect(resolver.resolve({
            toolId: 'droid-cli',
            purpose: 'Detect a vendor-installed Windows agent CLI',
        })).resolves.toMatchObject({ executablePath: shim });
    });

    it('does not invent extension candidates on a POSIX host', async () => {
        if (process.platform === 'win32') return;

        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-posix-shim-'));
        temporaryRoots.add(root);
        await writeFile(join(root, 'droid.cmd'), '@echo off\r\n', { mode: 0o755 });

        const resolver = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'droid-cli',
                displayName: 'Factory Droid CLI',
                lookupNames: ['droid'],
            }],
            baseEnv: {
                PATH: root,
                PATHEXT: '.COM;.EXE;.BAT;.CMD',
            },
            platform: 'linux',
            registerGrant() {},
        });

        const failure = await resolver.resolve({
            toolId: 'droid-cli',
            purpose: 'Keep POSIX resolution exact',
        }).then(() => undefined, (error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'plugin_exec_system_tool_unavailable' });
    });
});
