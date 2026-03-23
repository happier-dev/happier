import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { isProviderCliPathRunnable, resolveJavaScriptRuntimeCommand } from './index.js';

function makeExecutableFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

describe('managedJavaScriptRuntime system node fallback', () => {
    it('treats JS-backed CLIs as runnable in compiled bun bundles when node is present on PATH', () => {
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
    })).toBe(nodePath);

        expect(isProviderCliPathRunnable(cliPath, env, {
            isBunRuntime: true,
            currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
        })).toBe(true);
    });

    it('falls back to system node under the node runtime when the current executable path is stale', () => {
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
        })).toBe(nodePath);
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
});
