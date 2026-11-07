import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { isProviderCliPathRunnable, resolveJavaScriptRuntimeCommand } from './index.js';
import {
    managedJavaScriptRuntimeBinPath,
    resolveExistingManagedJavaScriptRuntimeCommand,
    resolveJavaScriptRuntimePathEntries,
} from './managedJavaScriptRuntime.js';
import { resolveWindowsCommandInvocation } from '../process/index.js';

function makeExecutableFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

describe('managedJavaScriptRuntime binary-safe selection', () => {
    const tempDirs: string[] = [];
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalJsRuntimePath = process.env.HAPPIER_JS_RUNTIME_PATH;
    const originalPathext = process.env.PATHEXT;

    afterEach(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
        if (originalJsRuntimePath === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
        else process.env.HAPPIER_JS_RUNTIME_PATH = originalJsRuntimePath;
        if (originalPathext === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = originalPathext;
        for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it.each(['win32', 'linux', 'darwin'] as const)(
        'preserves multiline launcher arguments with the managed runtime on %s', (platform) => {
            Object.defineProperty(process, 'platform', { value: platform, configurable: true });
            const homeDir = mkdtempSync(join(tmpdir(), 'happier-managed-runtime-argv-'));
            tempDirs.push(homeDir);
            const env = { HAPPIER_HOME_DIR: homeDir, PATH: '' };
            const wrapper = managedJavaScriptRuntimeBinPath(env);
            const nodeDir = join(homeDir, 'tools', 'js-runtime', 'current', 'runtime', ...(platform === 'win32' ? [] : ['bin']));
            const node = join(nodeDir, platform === 'win32' ? 'node.exe' : 'node');
            mkdirSync(join(wrapper, '..'), { recursive: true });
            mkdirSync(nodeDir, { recursive: true });
            makeExecutableFile(wrapper, platform === 'win32'
                ? '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n'
                : '#!/bin/sh\nexec "$(dirname "$0")/../runtime/bin/node" "$@"\n');
            makeExecutableFile(node, '');
            const expectedCommand = platform === 'win32' ? node : wrapper;
            const args = ['claude_remote_launcher.cjs', '--append-system-prompt', '# Session title\r\n\r\nKeep "quotes" & %literal%\nnext line', '--input-format', 'stream-json'];

            expect(resolveExistingManagedJavaScriptRuntimeCommand(env)).toBe(expectedCommand);
            for (const isBunRuntime of [true, false]) {
                const command = resolveJavaScriptRuntimeCommand({
                    isBunRuntime,
                    processEnv: env,
                    currentExecPath: join(homeDir, platform === 'win32' ? 'happier.exe' : 'happier'),
                });
                expect(command).toBe(expectedCommand);
                expect(resolveWindowsCommandInvocation({ command: command!, args, env })).toEqual({ command: expectedCommand, args });
                expect(resolveJavaScriptRuntimePathEntries({ processEnv: env, runtimeCommand: command })).toEqual([nodeDir]);
            }
        },
    );

    it('does not treat node on PATH as a runtime fallback for stale bun bundles', () => {
        const root = join(tmpdir(), `happier-cli-common-js-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });

    const nodePath = join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
    const cliPath = join(binDir, 'codex');

    if (process.platform === 'win32') {
      makeExecutableFile(nodePath, '');
      makeExecutableFile(cliPath, '@echo off\r\n');
    } else {
      makeExecutableFile(nodePath, '#!/bin/sh\nexit 0\n');
      makeExecutableFile(cliPath, '#!/usr/bin/env node\nconsole.log("ok");\n');
    }

    const env = {
      PATH: binDir,
      HAPPIER_HOME_DIR: join(root, 'home'),
    } satisfies NodeJS.ProcessEnv;

    expect(resolveJavaScriptRuntimeCommand({
      isBunRuntime: true,
      processEnv: env,
      currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
    })).toBeNull();

        expect(isProviderCliPathRunnable(cliPath, env, {
            isBunRuntime: true,
            currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
        })).toBe(false);
    });

    it('keeps the current node executable when already running under node', () => {
        const root = join(tmpdir(), `happier-cli-common-node-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });

        const nodePath = join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
        if (process.platform === 'win32') {
            makeExecutableFile(nodePath, '');
        } else {
            makeExecutableFile(nodePath, '#!/bin/sh\nexit 0\n');
        }

        const env = {
            PATH: '',
            HAPPIER_HOME_DIR: join(root, 'home'),
        } satisfies NodeJS.ProcessEnv;

        expect(resolveJavaScriptRuntimeCommand({
            isBunRuntime: false,
            processEnv: env,
            currentExecPath: nodePath,
        })).toBe(nodePath);
    });

    it('keeps the current node executable even when isBunRuntime=true', () => {
        const root = join(tmpdir(), `happier-cli-common-bun-node-current-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });

        const nodePath = join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
        if (process.platform === 'win32') {
            makeExecutableFile(nodePath, '');
        } else {
            makeExecutableFile(nodePath, '#!/bin/sh\nexit 0\n');
        }

        const env = {
            PATH: '',
            HAPPIER_HOME_DIR: join(root, 'home'),
        } satisfies NodeJS.ProcessEnv;

        expect(resolveJavaScriptRuntimeCommand({
            isBunRuntime: true,
            processEnv: env,
            currentExecPath: nodePath,
        })).toBe(nodePath);
    });

    it('fails closed when only a PATH node exists and the current executable is stale', () => {
        const root = join(tmpdir(), `happier-cli-common-node-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const binDir = join(root, 'bin');
        mkdirSync(binDir, { recursive: true });

        const nodePath = join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
        if (process.platform === 'win32') {
            makeExecutableFile(nodePath, '');
        } else {
            makeExecutableFile(nodePath, '#!/bin/sh\nexit 0\n');
        }

        const env = {
            PATH: binDir,
            HAPPIER_HOME_DIR: join(root, 'home'),
        } satisfies NodeJS.ProcessEnv;

        expect(resolveJavaScriptRuntimeCommand({
            isBunRuntime: false,
            processEnv: env,
            currentExecPath: join(root, 'deleted-runtime', 'cli', 'happier'),
        })).toBeNull();
    });

    it('does not treat an installed happier binary as the node runtime when no node runtime is available', () => {
        const root = join(tmpdir(), `happier-cli-common-binary-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const cliDir = join(root, 'runtime', 'cli');
        mkdirSync(cliDir, { recursive: true });

        const binaryPath = join(cliDir, 'happier');
        makeExecutableFile(binaryPath, '#!/bin/sh\nexit 0\n');

        const env = {
            PATH: '',
            HAPPIER_HOME_DIR: join(root, 'home'),
        } satisfies NodeJS.ProcessEnv;

        expect(resolveJavaScriptRuntimeCommand({
            isBunRuntime: false,
            processEnv: env,
            currentExecPath: binaryPath,
        })).toBe(null);
    });

    it('prefers the .cmd shim over an extensionless Windows JS runtime override path', () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

        const root = join(tmpdir(), `happier-cli-common-js-runtime-win32-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(root, { recursive: true });

        const extensionlessPath = join(root, 'node');
        writeFileSync(extensionlessPath, '', 'utf8');
        const cmdShimPath = join(root, 'node.cmd');
        writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

        process.env.HAPPIER_JS_RUNTIME_PATH = extensionlessPath;
        process.env.PATHEXT = '.CMD;.EXE';

        expect(resolveJavaScriptRuntimeCommand({
            isBunRuntime: true,
            processEnv: process.env,
            currentExecPath: join(root, 'bun.exe'),
        })?.toLowerCase()).toBe(cmdShimPath.toLowerCase());
    });

    it('expands ~/ explicit JS runtime overrides against HOME', () => {
        const root = join(tmpdir(), `happier-cli-common-js-runtime-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const homeDir = join(root, 'home');
        const runtimeDir = join(homeDir, 'custom-runtime');
        mkdirSync(runtimeDir, { recursive: true });

        const nodePath = join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node');
        if (process.platform === 'win32') {
            makeExecutableFile(nodePath, '');
        } else {
            makeExecutableFile(nodePath, '#!/bin/sh\nexit 0\n');
        }

        expect(resolveJavaScriptRuntimeCommand({
            isBunRuntime: false,
            processEnv: {
                HOME: homeDir,
                USERPROFILE: homeDir,
                HAPPIER_JS_RUNTIME_PATH: `~/custom-runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
            },
            currentExecPath: join(root, 'happier'),
        })).toBe(nodePath);
    });
});
