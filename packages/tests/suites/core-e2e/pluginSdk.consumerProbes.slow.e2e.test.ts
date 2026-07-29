import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';

describe('core e2e: plugin SDK packed consumer probes', () => {
    it('packs the SDK and compiles/runs an out-of-repo NodeNext TS consumer', () => {
        const scriptPath = join(repoRootDir(), 'packages', 'tests', 'pluginSdkConsumers', 'run-probes.mjs');
        const result = spawnSync(process.execPath, [scriptPath, '--consumer=nodenext'], {
            cwd: repoRootDir(),
            env: {
                ...process.env,
                CI: '1',
            },
            encoding: 'utf8',
            timeout: 180_000,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('NodeNext consumer PASS');
    }, 180_000);

    it('packs the SDK and compiles/runs an out-of-repo Vite consumer', () => {
        const scriptPath = join(repoRootDir(), 'packages', 'tests', 'pluginSdkConsumers', 'run-probes.mjs');
        const result = spawnSync(process.execPath, [scriptPath, '--consumer=vite'], {
            cwd: repoRootDir(),
            env: {
                ...process.env,
                CI: '1',
            },
            encoding: 'utf8',
            timeout: 180_000,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('Vite consumer PASS');
    }, 180_000);
});
