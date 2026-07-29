import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPluginExecSystemToolResolver } from './resolveGrant';

const temporaryRoots = new Set<string>();

afterEach(async () => {
    await Promise.all([...temporaryRoots].map(async (root) => {
        await rm(root, { recursive: true, force: true });
        temporaryRoots.delete(root);
    }));
});

describe('createPluginExecSystemToolResolver', () => {
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

        await expect(resolver.resolve({
            toolId: 'javascript-tool',
            purpose: 'Do not broaden generic system tools',
            preferredPath: entryPoint,
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_SYSTEM_TOOL_UNAVAILABLE',
        });
    });
});
