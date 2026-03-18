import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

function hasAnyExecuteBit(mode: number): boolean {
    return (mode & 0o111) !== 0;
}

describe('fixNodePtySpawnHelperPermissions', () => {
    it('marks spawn-helper as executable on darwin', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-node-pty-test-'));
        const nodePtyDir = resolve(join(rootDir, 'node_modules', 'node-pty'));
        const helperPath = resolve(join(nodePtyDir, 'prebuilds', 'darwin-arm64', 'spawn-helper'));

        await mkdir(resolve(join(nodePtyDir, 'prebuilds', 'darwin-arm64')), { recursive: true });
        await writeFile(helperPath, 'fake', 'utf8');
        await chmod(helperPath, 0o644);

        const require = createRequire(import.meta.url);
        const mod = require('./fix-node-pty-spawn-helper-permissions.cjs') as {
            fixNodePtySpawnHelperPermissions: (input: { platform: string; nodePtyDirs: string[] }) => Promise<{ changed: number }>;
        };

        const before = await stat(helperPath);
        expect(hasAnyExecuteBit(before.mode)).toBe(false);

        const result = await mod.fixNodePtySpawnHelperPermissions({ platform: 'darwin', nodePtyDirs: [nodePtyDir] });
        expect(result.changed).toBe(1);

        const after = await stat(helperPath);
        expect(hasAnyExecuteBit(after.mode)).toBe(true);
    });
});
