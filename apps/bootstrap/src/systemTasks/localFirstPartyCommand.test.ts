import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureLocalFirstPartyComponentCommand } from './localFirstPartyCommand.js';

describe('ensureLocalFirstPartyComponentCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('prefers the repo-local hstack command before attempting a payload download', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-repo-local-hstack-'));
        const repoRoot = join(rootDir, 'repo');
        const hstackPath = join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');
        const preparePayload = vi.fn(async () => {
            throw new Error('preparePayload should not have been called');
        });
        const installPayload = vi.fn(async () => {
            throw new Error('installPayload should not have been called');
        });

        try {
            mkdirSync(dirname(hstackPath), { recursive: true });
            writeFileSync(hstackPath, '#!/usr/bin/env node\n', 'utf8');
            chmodSync(hstackPath, 0o755);

            await expect(ensureLocalFirstPartyComponentCommand({
                componentId: 'hstack',
                processEnv: {
                    HAPPIER_STACK_REPO_DIR: repoRoot,
                    PATH: '',
                },
            }, {
                preparePayload,
                installPayload,
            })).resolves.toBe(hstackPath);

            expect(preparePayload).not.toHaveBeenCalled();
            expect(installPayload).not.toHaveBeenCalled();
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('prefers the repo-local Happier CLI command before attempting a payload download', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-repo-local-happier-cli-'));
        const repoRoot = join(rootDir, 'repo');
        const happierPath = join(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs');
        const preparePayload = vi.fn(async () => {
            throw new Error('preparePayload should not have been called');
        });
        const installPayload = vi.fn(async () => {
            throw new Error('installPayload should not have been called');
        });

        try {
            mkdirSync(dirname(happierPath), { recursive: true });
            writeFileSync(happierPath, '#!/usr/bin/env node\n', 'utf8');
            chmodSync(happierPath, 0o755);

            await expect(ensureLocalFirstPartyComponentCommand({
                componentId: 'happier-cli',
                processEnv: {
                    HAPPIER_STACK_REPO_DIR: repoRoot,
                    PATH: '',
                },
            }, {
                preparePayload,
                installPayload,
            })).resolves.toBe(happierPath);

            expect(preparePayload).not.toHaveBeenCalled();
            expect(installPayload).not.toHaveBeenCalled();
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });
});
