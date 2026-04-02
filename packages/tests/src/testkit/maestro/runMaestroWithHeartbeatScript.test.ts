import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { waitFor } from '../timing';
import { isProcessAlive, terminateProcessTreeByPid } from '../process/processTree';

const execFileAsync = promisify(execFile);

describe('scripts/run-maestro-with-heartbeat.mjs', () => {
    const TEST_TIMEOUT_MS = 30_000;

    it('runs with a stubbed maestro binary and writes a manifest', async () => {
        const repoRoot = resolve(__dirname, '../../../../..');
        const scratch = await mkdtemp(join(tmpdir(), 'happier-maestro-script-'));

        const binDir = join(scratch, 'bin');
        await mkdir(binDir, { recursive: true });

        const maestroStubPath = join(binDir, 'maestro');
        const argsLogPath = join(scratch, 'maestro-args.txt');
        await writeFile(
            maestroStubPath,
            [
                '#!/usr/bin/env sh',
                // `/bin/sh` is `dash` on Ubuntu and does not support `pipefail`.
                'set -eu',
                'if [ -n "${MAESTRO_ARGS_LOG_PATH:-}" ]; then',
                '  printf "%s\\n" "$@" > "$MAESTRO_ARGS_LOG_PATH"',
                'fi',
                // Accept any invocation (we only need the wrapper to succeed).
                'exit 0',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(maestroStubPath, 0o755);

        const scriptPath = join(repoRoot, 'packages/tests/scripts/run-maestro-with-heartbeat.mjs');
        await execFileAsync(
            process.execPath,
            [
                scriptPath,
                '--platform',
                'android',
                '--flows',
                'suites/mobile-e2e/flows',
                '--appId',
                'dev.happier.app.internaldev',
                '--serverUrl',
                'http://127.0.0.1:26050',
                '--skip-app-install-check',
            ],
            {
                cwd: scratch,
                env: {
                    ...process.env,
                    HAPPIER_E2E_MAESTRO_BIN: maestroStubPath,
                    HAPPIER_E2E_ANDROID_ADB_REVERSE: '0',
                    // Keep this unit test self-contained (do not spawn Expo/Metro).
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    MAESTRO_CLI_NO_ANALYTICS: '1',
                    MAESTRO_ARGS_LOG_PATH: argsLogPath,
                },
            },
        );

        const maestroArgs = await readFile(argsLogPath, 'utf8');
        expect(maestroArgs).toContain('HAPPIER_E2E_DEV_CLIENT_METRO_URL=');

        const logsDir = join(scratch, '.project', 'logs', 'e2e', 'mobile-maestro');
        const entries = (await readdir(logsDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        expect(entries.length).toBeGreaterThan(0);

        const lastRunDir = join(logsDir, entries[entries.length - 1]!, 'manifest.json');
        const manifest = JSON.parse(await readFile(lastRunDir, 'utf8'));
        expect(manifest.tool).toBe('maestro');
        expect(manifest.platform).toBe('android');
        expect(manifest.appId).toBe('dev.happier.app.internaldev');
    }, TEST_TIMEOUT_MS);

    it('can enable adb reverse for android and keep loopback URLs', async () => {
        const repoRoot = resolve(__dirname, '../../../../..');
        const scratch = await mkdtemp(join(tmpdir(), 'happier-maestro-script-'));

        const binDir = join(scratch, 'bin');
        await mkdir(binDir, { recursive: true });

        const maestroStubPath = join(binDir, 'maestro');
        const maestroArgsLogPath = join(scratch, 'maestro-args.txt');
        await writeFile(
            maestroStubPath,
            [
                '#!/usr/bin/env sh',
                // `/bin/sh` is `dash` on Ubuntu and does not support `pipefail`.
                'set -eu',
                'if [ -n "${MAESTRO_ARGS_LOG_PATH:-}" ]; then',
                '  printf "%s\\n" "$@" > "$MAESTRO_ARGS_LOG_PATH"',
                'fi',
                'exit 0',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(maestroStubPath, 0o755);

        const adbStubPath = join(binDir, 'adb');
        const adbArgsLogPath = join(scratch, 'adb-args.txt');
        await writeFile(
            adbStubPath,
            [
                '#!/usr/bin/env sh',
                'set -euo pipefail',
                'if [ -n "${ADB_ARGS_LOG_PATH:-}" ]; then',
                '  printf "%s\\n" "$@" >> "$ADB_ARGS_LOG_PATH"',
                'fi',
                'exit 0',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(adbStubPath, 0o755);

        const scriptPath = join(repoRoot, 'packages/tests/scripts/run-maestro-with-heartbeat.mjs');
        await execFileAsync(
            process.execPath,
            [
                scriptPath,
                '--platform',
                'android',
                '--flows',
                'suites/mobile-e2e/flows',
                '--appId',
                'dev.happier.app.internaldev',
                '--serverUrl',
                'http://127.0.0.1:26050',
                '--skip-app-install-check',
            ],
            {
                cwd: scratch,
                env: {
                    ...process.env,
                    HAPPIER_E2E_MAESTRO_BIN: maestroStubPath,
                    HAPPIER_E2E_ADB_BIN: adbStubPath,
                    HAPPIER_E2E_ANDROID_ADB_REVERSE: '1',
                    // Keep this unit test self-contained (do not spawn Expo/Metro).
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    MAESTRO_ARGS_LOG_PATH: maestroArgsLogPath,
                    ADB_ARGS_LOG_PATH: adbArgsLogPath,
                },
            },
        );

        const maestroArgs = await readFile(maestroArgsLogPath, 'utf8');
        expect(maestroArgs).toContain('HAPPIER_E2E_SERVER_URL=http://127.0.0.1:26050');
        const metroUrlLine = maestroArgs
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.startsWith('HAPPIER_E2E_DEV_CLIENT_METRO_URL='));
        expect(metroUrlLine).toMatch(/^HAPPIER_E2E_DEV_CLIENT_METRO_URL=http:\/\/(127\.0\.0\.1|localhost):8081$/);

        const adbArgs = await readFile(adbArgsLogPath, 'utf8');
        expect(adbArgs).toContain('reverse');
        expect(adbArgs).toContain('tcp:26050');
        expect(adbArgs).toContain('tcp:8081');
    }, TEST_TIMEOUT_MS);

    it('terminates a long-running maestro child on SIGTERM', async () => {
        const repoRoot = resolve(__dirname, '../../../../..');
        const scratch = await mkdtemp(join(tmpdir(), 'happier-maestro-script-cleanup-'));

        const binDir = join(scratch, 'bin');
        await mkdir(binDir, { recursive: true });

        const maestroStubJsPath = join(binDir, 'maestro-stub.cjs');
        const maestroMarkerPath = join(scratch, 'maestro-marker.json');
        await writeFile(
            maestroStubJsPath,
            [
                "'use strict';",
                "const { spawn } = require('node:child_process');",
                "const { writeFileSync } = require('node:fs');",
                "const markerPath = process.env.MAESTRO_STUB_MARKER;",
                "if (!markerPath) throw new Error('Missing MAESTRO_STUB_MARKER');",
                "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
                "if (!grandchild.pid) throw new Error('Failed to spawn grandchild');",
                "writeFileSync(markerPath, JSON.stringify({ maestroPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');",
                "setInterval(() => {}, 1000);",
                '',
            ].join('\n'),
            'utf8',
        );

        const maestroStubPath = join(binDir, 'maestro');
        await writeFile(
            maestroStubPath,
            [
                '#!/usr/bin/env sh',
                // `/bin/sh` is `dash` on Ubuntu and does not support `pipefail`.
                'set -eu',
                `exec node "${maestroStubJsPath}" "$@"`,
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(maestroStubPath, 0o755);

        const scriptPath = join(repoRoot, 'packages/tests/scripts/run-maestro-with-heartbeat.mjs');
        const child = spawn(
            process.execPath,
            [
                scriptPath,
                '--platform',
                'android',
                '--flows',
                'suites/mobile-e2e/flows',
                '--appId',
                'dev.happier.app.internaldev',
                '--serverUrl',
                'http://127.0.0.1:26050',
                '--skip-app-install-check',
            ],
            {
                cwd: scratch,
                env: {
                    ...process.env,
                    HAPPIER_E2E_MAESTRO_BIN: maestroStubPath,
                    // Avoid requiring a real Android toolchain in this unit test.
                    HAPPIER_E2E_ANDROID_ADB_REVERSE: '0',
                    // Keep this unit test self-contained (do not spawn Expo/Metro).
                    HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
                    MAESTRO_CLI_NO_ANALYTICS: '1',
                    MAESTRO_STUB_MARKER: maestroMarkerPath,
                },
                stdio: ['ignore', 'ignore', 'ignore'],
            },
        );

        try {
            await waitFor(async () => {
                try {
                    const raw = await readFile(maestroMarkerPath, 'utf8');
                    const parsed = JSON.parse(raw) as { maestroPid?: unknown; grandchildPid?: unknown };
                    return Number.isInteger(parsed.maestroPid) && Number.isInteger(parsed.grandchildPid);
                } catch {
                    return false;
                }
            }, { timeoutMs: 20_000, intervalMs: 100, context: 'maestro stub marker' });

            const marker = JSON.parse(await readFile(maestroMarkerPath, 'utf8')) as { maestroPid: number; grandchildPid: number };
            expect(marker.maestroPid).toBeGreaterThan(0);
            expect(marker.grandchildPid).toBeGreaterThan(0);
            expect(isProcessAlive(marker.maestroPid)).toBe(true);
            expect(isProcessAlive(marker.grandchildPid)).toBe(true);

            child.kill('SIGTERM');

            await waitFor(() => child.exitCode !== null, {
                timeoutMs: 10_000,
                intervalMs: 50,
                context: 'wrapper shutdown',
            });

            await waitFor(() => !isProcessAlive(marker.maestroPid), {
                timeoutMs: 10_000,
                intervalMs: 100,
                context: 'maestro stub shutdown',
            });

            await waitFor(() => !isProcessAlive(marker.grandchildPid), {
                timeoutMs: 10_000,
                intervalMs: 100,
                context: 'maestro grandchild shutdown',
            });
        } finally {
            if (!child.killed) child.kill('SIGTERM');
            await terminateProcessTreeByPid(child.pid ?? 0, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
        }
    }, TEST_TIMEOUT_MS);
});
