import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectCliSnapshotOnDaemonPath } from '@/capabilities/snapshots/cliSnapshot';
import { resolveProviderCliCommand, isProviderCliPathRunnable, resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/providers';

const workDir = mkdtempSync(join(tmpdir(), 'happier-debug-'));
const homeDir = join(workDir, 'home');
const binDir = join(workDir, 'bin');
mkdirSync(homeDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
const nodePath = join(binDir, 'node');
const codexPath = join(binDir, 'codex');
writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', 'utf8');
chmodSync(nodePath, 0o755);
writeFileSync(codexPath, '#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("codex 0.200.0");\n', 'utf8');
chmodSync(codexPath, 0o755);
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.LOCALAPPDATA = join(homeDir, 'AppData', 'Local');
process.env.HAPPIER_HOME_DIR = homeDir;
process.env.PATH = binDir;
delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
delete process.env.HAPPIER_CODEX_PATH;

const originalExecPath = process.execPath;
const originalBunDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');
Object.defineProperty(process, 'execPath', { configurable: true, value: '/Applications/Happier.app/Contents/MacOS/happier' });
Object.defineProperty(process.versions, 'bun', { configurable: true, value: '1.2.23' });

console.log('resolveProviderCliCommand', resolveProviderCliCommand('codex'));
console.log('resolveJavaScriptRuntimeCommand', resolveJavaScriptRuntimeCommand({ isBunRuntime: typeof process.versions.bun === 'string', processEnv: process.env, currentExecPath: process.execPath }));
console.log('isProviderCliPathRunnable', isProviderCliPathRunnable(codexPath, process.env, { isBunRuntime: typeof process.versions.bun === 'string', currentExecPath: process.execPath }));
console.log(JSON.stringify(await detectCliSnapshotOnDaemonPath({ requestedCliNames: ['codex'], bypassCache: true }), null, 2));

Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
if (originalBunDescriptor) Object.defineProperty(process.versions, 'bun', originalBunDescriptor);
else delete (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
