/**
 * Tests for the checklist-based capabilities RPCs:
 * - capabilities.describe
 * - capabilities.detect
 *
 * These replace legacy detect-cli / detect-capabilities / dep-status.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSessionHandlers } from './registerSessionHandlers';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '@happier-dev/protocol';
import { CHECKLIST_IDS, resumeChecklistId } from '@happier-dev/protocol/checklists';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

function createTestRpcManager(params?: { scopePrefix?: string }) {
    const scopePrefix = params?.scopePrefix ?? 'machine-test';
    return createEncryptedRpcTestClient({
        scopePrefix,
        encryptionKey: new Uint8Array(32).fill(7),
        logger: () => undefined,
        registerHandlers: (manager) => registerSessionHandlers(manager, process.cwd()),
    });
}

function expectCapabilityData(
    response: CapabilitiesDetectResponse,
    capabilityId: string,
): Readonly<Record<string, unknown>> {
    const entry = response.results[capabilityId as keyof CapabilitiesDetectResponse['results']];
    expect(entry?.ok).toBe(true);
    if (!entry || !entry.ok || typeof entry.data !== 'object' || entry.data === null) {
        throw new Error(`Expected capability ${capabilityId} to return object data`);
    }
    return entry.data as Readonly<Record<string, unknown>>;
}

describe('registerCommonHandlers capabilities', () => {
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;

    beforeEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;

        if (originalPathext === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = originalPathext;
    });

    afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;

        if (originalPathext === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = originalPathext;
    });

    it('describes supported capabilities and checklists', async () => {
        const { call } = createTestRpcManager();
        const result = await call<CapabilitiesDescribeResponse, Record<string, never>>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});

        expect(result.protocolVersion).toBe(1);
        expect(result.capabilities.map((c) => c.id)).toEqual(
            expect.arrayContaining(['cli.codex', 'cli.claude', 'cli.gemini', 'cli.opencode', 'tool.tmux', 'tool.windowsTerminal', CODEX_ACP_DEP_ID]),
        );
        expect(Object.keys(result.checklists)).toEqual(
            expect.arrayContaining([
                CHECKLIST_IDS.NEW_SESSION,
                CHECKLIST_IDS.MACHINE_DETAILS,
                resumeChecklistId('claude'),
                resumeChecklistId('codex'),
                resumeChecklistId('gemini'),
                resumeChecklistId('opencode'),
            ]),
        );
        expect(result.checklists[resumeChecklistId('codex')].map((r) => r.id)).toEqual(
            expect.arrayContaining(['cli.codex', CODEX_ACP_DEP_ID]),
        );
    });

    it('detects checklist new-session deterministically from PATH', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-'));
        try {
            const isWindows = process.platform === 'win32';

            const fakeCodex = join(dir, isWindows ? 'codex.cmd' : 'codex');
            const fakeClaude = join(dir, isWindows ? 'claude.cmd' : 'claude');
            const fakeGemini = join(dir, isWindows ? 'gemini.cmd' : 'gemini');
            const fakeOpenCode = join(dir, isWindows ? 'opencode.cmd' : 'opencode');
            const fakeTmux = join(dir, isWindows ? 'tmux.cmd' : 'tmux');
            const fakeWindowsTerminal = join(dir, 'wt.exe');

            await writeFile(
                fakeCodex,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo codex 1.2.3& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 1.2.3"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeClaude,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo claude 0.1.0& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.1.0"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeGemini,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo gemini 9.9.9& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gemini 9.9.9"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeOpenCode,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo opencode 0.1.48& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode 0.1.48"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeTmux,
                isWindows
                    ? '@echo off\r\nif "%1"=="-V" (echo tmux 3.3a& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux 3.3a"; exit 0; fi\necho ok\n',
                'utf8',
            );
            await writeFile(
                fakeWindowsTerminal,
                isWindows ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
                'utf8',
            );

            if (!isWindows) {
                await chmod(fakeCodex, 0o755);
                await chmod(fakeClaude, 0o755);
                await chmod(fakeGemini, 0o755);
                await chmod(fakeOpenCode, 0o755);
                await chmod(fakeTmux, 0o755);
                await chmod(fakeWindowsTerminal, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }

            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager();
            const result = await call<CapabilitiesDetectResponse, CapabilitiesDetectRequest>(RPC_METHODS.CAPABILITIES_DETECT, {
                checklistId: CHECKLIST_IDS.NEW_SESSION,
            });

            expect(result.protocolVersion).toBe(1);
            const codexData = expectCapabilityData(result, 'cli.codex');
            expect(codexData.available).toBe(true);
            expect(codexData.resolvedPath).toBe(fakeCodex);

            const claudeData = expectCapabilityData(result, 'cli.claude');
            expect(claudeData.available).toBe(true);
            expect(claudeData.resolvedPath).toBe(fakeClaude);

            const geminiData = expectCapabilityData(result, 'cli.gemini');
            expect(geminiData.available).toBe(true);
            expect(geminiData.resolvedPath).toBe(fakeGemini);

            const openCodeData = expectCapabilityData(result, 'cli.opencode');
            expect(openCodeData.available).toBe(true);
            expect(openCodeData.resolvedPath).toBe(fakeOpenCode);

            const tmuxData = expectCapabilityData(result, 'tool.tmux');
            expect(tmuxData.available).toBe(true);
            expect(tmuxData.resolvedPath).toBe(fakeTmux);

            const windowsTerminalData = expectCapabilityData(result, 'tool.windowsTerminal');
            expect(windowsTerminalData.available).toBe(true);
            expect(windowsTerminalData.resolvedPath).toBe(fakeWindowsTerminal);

            const executionRunsData = expectCapabilityData(result, 'tool.executionRuns');
            expect(executionRunsData.available).toBe(true);
            // voice_agent is gated by build policy + feature decisions; preview policy currently denies voice.agent by default.
            expect(executionRunsData.intents).toEqual(['review', 'plan', 'delegate']);
            expect(executionRunsData.backends).toEqual(
                expect.objectContaining({
                    claude: expect.objectContaining({ available: true }),
                    codex: expect.objectContaining({ available: true }),
                }),
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('supports installing vendor-recipe provider CLIs via capabilities.invoke (dry-run)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-provider-install-'));
        try {
            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager({ scopePrefix: 'machine-test-provider-install' });
            const result = await call<CapabilitiesInvokeResponse, CapabilitiesInvokeRequest>(RPC_METHODS.CAPABILITIES_INVOKE, {
                id: 'cli.claude',
                method: 'install',
                // Avoid flakiness when the host machine already has Claude installed via any source.
                params: { dryRun: true, skipIfInstalled: false },
            });

            expect(result.ok).toBe(true);
            if (!result.ok) return;

            const okResult = result.result as {
                plan: { providerId: string; binaries: string[] };
                alreadyInstalled: boolean;
                logPath: string | null;
            };
            expect(okResult.plan).toMatchObject({ providerId: 'claude', binaries: ['claude'] });
            expect(typeof okResult.alreadyInstalled).toBe('boolean');
            expect(okResult.logPath).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns install-confirmation-required when attempting to execute a vendor recipe without allowVendorRecipeExecution', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-provider-install-confirm-'));
        try {
            // Keep PATH empty so even an allowed install cannot execute anything during the test.
            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager({ scopePrefix: 'machine-test-provider-install-confirm' });
            const result = await call<CapabilitiesInvokeResponse, CapabilitiesInvokeRequest>(RPC_METHODS.CAPABILITIES_INVOKE, {
                id: 'cli.claude',
                method: 'install',
                params: { dryRun: false },
            });

            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe('install-confirmation-required');
            expect(result.logPath).toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('accepts allowVendorRecipeExecution=true and proceeds into the vendor recipe path (without running commands in test PATH)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-provider-install-allowed-'));
        try {
            // Keep PATH empty so commandExistsOnPath fails deterministically.
            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager({ scopePrefix: 'machine-test-provider-install-allowed' });
            const result = await call<CapabilitiesInvokeResponse, CapabilitiesInvokeRequest>(RPC_METHODS.CAPABILITIES_INVOKE, {
                id: 'cli.claude',
                method: 'install',
                // Avoid flakiness when the host machine already has Claude installed via any source.
                params: { dryRun: false, allowVendorRecipeExecution: true, skipIfInstalled: false },
            });

            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe('install-failed');
            expect(result.error.message).toContain('Command not found');
            expect(typeof result.logPath).toBe('string');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns install-not-available when provider has no auto-install recipe for the selected platform', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-provider-install-missing-recipe-'));
        try {
            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager({ scopePrefix: 'machine-test-provider-install-missing-recipe' });
            const result = await call<CapabilitiesInvokeResponse, CapabilitiesInvokeRequest>(RPC_METHODS.CAPABILITIES_INVOKE, {
                id: 'cli.opencode',
                method: 'install',
                params: { dryRun: true, platform: 'win32' },
            });

            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe('install-not-available');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('detects tool.executionRuns backends from PATH even when requesting only tool.executionRuns', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-execution-runs-'));
        try {
            const isWindows = process.platform === 'win32';

            const fakeCodex = join(dir, isWindows ? 'codex.cmd' : 'codex');
            await writeFile(
                fakeCodex,
                isWindows
                    ? '@echo off\r\nif "%1"=="--version" (echo codex 1.2.3& exit /b 0)\r\necho ok\r\n'
                    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 1.2.3"; exit 0; fi\necho ok\n',
                'utf8',
            );

            if (!isWindows) {
                await chmod(fakeCodex, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }

            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager({ scopePrefix: 'machine-test-execution-runs' });
            const result = await call<CapabilitiesDetectResponse, CapabilitiesDetectRequest>(RPC_METHODS.CAPABILITIES_DETECT, {
                requests: [{ id: 'tool.executionRuns' }],
            });

            expect(result.protocolVersion).toBe(1);
            const executionRunsData = expectCapabilityData(result, 'tool.executionRuns');
            expect(executionRunsData.available).toBe(true);
            expect((executionRunsData.backends as any)?.codex?.available).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('supports per-capability params (includeLoginStatus) and skips latest-version checks when onlyIfInstalled=true and not installed', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-login-'));
        try {
            const isWindows = process.platform === 'win32';
            const fakeCodex = join(dir, isWindows ? 'codex.cmd' : 'codex');
            await writeFile(
                fakeCodex,
                isWindows
                    ? '@echo off\r\nif \"%1\"==\"login\" if \"%2\"==\"status\" (echo ok& exit /b 0)\r\nif \"%1\"==\"--version\" (echo codex 1.2.3& exit /b 0)\r\necho nope& exit /b 1\r\n'
                    : '#!/bin/sh\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo ok; exit 0; fi\nif [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi\necho nope; exit 1;\n',
                'utf8',
            );
            if (!isWindows) {
                await chmod(fakeCodex, 0o755);
            } else {
                process.env.PATHEXT = '.CMD';
            }
            process.env.PATH = `${dir}`;

            const { call } = createTestRpcManager();
            const result = await call<CapabilitiesDetectResponse, CapabilitiesDetectRequest>(RPC_METHODS.CAPABILITIES_DETECT, {
                requests: [
                    { id: 'cli.codex', params: { includeLoginStatus: true } },
                    { id: CODEX_ACP_DEP_ID, params: { includeLatestVersion: true, onlyIfInstalled: true } },
                ],
            });

            const codexData = expectCapabilityData(result, 'cli.codex');
            expect(codexData.isLoggedIn).toBe(true);

            const depData = expectCapabilityData(result, CODEX_ACP_DEP_ID);
            expect(depData.installed).toBe(false);
            expect(depData.latestVersionCheck).toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
