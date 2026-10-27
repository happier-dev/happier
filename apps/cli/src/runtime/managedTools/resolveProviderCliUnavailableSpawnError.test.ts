import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { resolveProviderCliUnavailableSpawnError } from './resolveProviderCliUnavailableSpawnError';

describe('resolveProviderCliUnavailableSpawnError', () => {
    const tempDirs: string[] = [];

    function writeExecutable(name: string): string {
        const dir = mkdtempSync(join(tmpdir(), 'happier-provider-availability-'));
        tempDirs.push(dir);
        const path = join(dir, name);
        writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        return path;
    }

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            try { chmodSync(dir, 0o755); } catch { /* best effort */ }
        }
    });

    it('returns a PROVIDER_UNAVAILABLE spawn error with install guidance when the CLI is not resolvable', () => {
        const result = resolveProviderCliUnavailableSpawnError({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            processEnv: { HAPPIER_CODEX_PATH: '/definitely-missing-happier-codex/codex' },
        });
        expect(result).toMatchObject({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.PROVIDER_UNAVAILABLE,
            errorMessage: expect.stringContaining('Codex'),
        });
    });

    it('returns null when the CLI resolves in the probed environment', () => {
        expect(resolveProviderCliUnavailableSpawnError({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            processEnv: { HAPPIER_CLAUDE_PATH: writeExecutable('claude') },
        })).toBeNull();
    });

    it('honors spawn-provided environment overrides in the probe', () => {
        const codexPath = writeExecutable('codex');
        expect(resolveProviderCliUnavailableSpawnError({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            spawnEnvironmentVariables: { HAPPIER_CODEX_PATH: codexPath },
            processEnv: {},
        })).toBeNull();
    });

    it('expands ${VAR} references in spawn overrides the way the runner child env does', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-provider-availability-expand-'));
        tempDirs.push(dir);
        writeFileSync(join(dir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        chmodSync(dir, 0o755);
        expect(resolveProviderCliUnavailableSpawnError({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            spawnEnvironmentVariables: {
                HAPPIER_CODEX_PATH: '${HAPPIER_TEST_CODEX_ROOT}/codex',
                HAPPIER_HOME_DIR: '/definitely-not-the-probe-home',
            },
            processEnv: { HAPPIER_TEST_CODEX_ROOT: dir },
        })).toBeNull();
    });

    it('leaves existing-session requests and configured ACP backends to their own handling', () => {
        const unavailableEnv = { HAPPIER_CODEX_PATH: '/definitely-missing-happier-codex/codex' };
        expect(resolveProviderCliUnavailableSpawnError({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            existingSessionId: 'cmvexisting0',
            processEnv: unavailableEnv,
        })).toBeNull();
        expect(resolveProviderCliUnavailableSpawnError({
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            processEnv: unavailableEnv,
        })).toBeNull();
        expect(resolveProviderCliUnavailableSpawnError({
            backendTarget: undefined,
            processEnv: unavailableEnv,
        })).toBeNull();
    });
});
