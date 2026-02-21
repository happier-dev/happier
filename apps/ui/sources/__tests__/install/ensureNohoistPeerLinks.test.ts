import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeTempDir(prefix: string) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('ensureNohoistPeerLinks', () => {
    it('links nohoisted react-native into repo root node_modules for tooling that expects it', async () => {
        const mod: any = await import('../../../tools/ensureNohoistPeerLinks.mjs');
        expect(typeof mod.ensureNohoistPeerLinks).toBe('function');

        const tmp = makeTempDir('happier-ui-nohoist-links-');
        const repoRootDir = path.join(tmp, 'repo');
        const expoAppDir = path.join(repoRootDir, 'apps', 'ui');

        try {
            fs.mkdirSync(path.join(repoRootDir, 'node_modules'), { recursive: true });
            fs.mkdirSync(path.join(expoAppDir, 'node_modules', 'react-native'), { recursive: true });
            fs.writeFileSync(path.join(expoAppDir, 'node_modules', 'react-native', 'package.json'), '{}\n', 'utf8');

            mod.ensureNohoistPeerLinks({ repoRootDir, expoAppDir });

            const linkPath = path.join(repoRootDir, 'node_modules', 'react-native');
            const targetPath = path.join(expoAppDir, 'node_modules', 'react-native');

            expect(fs.existsSync(path.join(linkPath, 'package.json'))).toBe(true);
            expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(targetPath));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

