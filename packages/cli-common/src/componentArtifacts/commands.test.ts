import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { resolveBunCommand } from './commands.js';

describe('resolveBunCommand', () => {
    it('resolves bun from BUN_INSTALL when bun is not on PATH', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-install-'));
        try {
            const bunInstallDir = join(tempRoot, '.bun');
            const bunBinDir = join(bunInstallDir, 'bin');
            const bunPath = join(bunBinDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
            mkdirSync(bunBinDir, { recursive: true });
            writeFileSync(bunPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
                mode: 0o755,
            });

            expect(resolveBunCommand({
                processEnv: {
                    BUN_INSTALL: bunInstallDir,
                },
                commandProbe: () => false,
            })).toBe(bunPath);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
