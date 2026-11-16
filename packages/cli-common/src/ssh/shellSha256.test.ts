import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { REMOTE_SHA256_FILE_FUNCTION } from './shellSha256.js';
import { safeBashSingleQuote } from './shellQuote.js';

describe('remote SHA-256 command owner', () => {
    it.skipIf(process.platform === 'win32')('verifies bytes on a guest with shasum and no sha256sum', async () => {
        const root = await mkdtemp(join(tmpdir(), 'sha256-guest-'));
        const run = promisify(execFile);
        try {
            for (const name of ['shasum', 'awk']) {
                const resolved = (await run('/bin/sh', ['-c', `command -v ${name}`])).stdout.trim();
                await symlink(resolved, join(root, name));
            }
            const path = join(root, 'payload with spaces');
            await writeFile(path, 'payload bytes');
            const result = await run('/bin/sh', ['-c', `${REMOTE_SHA256_FILE_FUNCTION}; sha256_file ${safeBashSingleQuote(path)}`], { env: { ...process.env, PATH: root } });
            expect(result.stdout.trim()).toBe(createHash('sha256').update('payload bytes').digest('hex'));
            const list = `${createHash('sha256').update('payload bytes').digest('hex')}  ${path}\n`;
            const verify = `${REMOTE_SHA256_FILE_FUNCTION}; printf '%s' ${safeBashSingleQuote(list)} | sha256_files -c`;
            expect((await run('/bin/sh', ['-c', verify], { env: { ...process.env, PATH: root } })).stdout).toContain(': OK');
            await writeFile(path, 'changed bytes');
            await expect(run('/bin/sh', ['-c', verify], { env: { ...process.env, PATH: root } })).rejects.toMatchObject({ code: 1 });
            await expect(run('/bin/sh', ['-c', `${REMOTE_SHA256_FILE_FUNCTION}; sha256_file ${safeBashSingleQuote(path)}`], { env: { ...process.env, PATH: '/missing-sha-tools' } }))
                .rejects.toMatchObject({ code: 127 });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
