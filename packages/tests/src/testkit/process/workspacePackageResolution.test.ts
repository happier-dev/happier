import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES,
    resolveCliBundledWorkspacePackageDir,
    resolveCliSharedDepPackageNames,
    resolveCliWorkspacePackageDir,
} from './workspacePackageResolution';

describe('workspacePackageResolution', () => {
    it('keeps the canonical CLI shared workspace package list in one place', () => {
        expect(CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES).toEqual([
            'agents',
            'cli-common',
            'connection-supervisor',
            'plugin-sdk',
            'peer-mediation',
            'protocol',
            'transfers',
            'release-runtime',
        ]);
    });

    it('derives workspace and bundled package directories from the same package name', () => {
        const rootDir = '/repo';

        expect(resolveCliWorkspacePackageDir(rootDir, 'protocol')).toBe('/repo/packages/protocol');
        expect(resolveCliBundledWorkspacePackageDir(rootDir, 'protocol')).toBe(
            '/repo/apps/cli/node_modules/@happier-dev/protocol',
        );
        expect(resolveCliWorkspacePackageDir(rootDir, 'plugins-inspector')).toBe(
            '/repo/packages/plugins/inspector',
        );
    });

    it('derives the complete shared dependency inventory from the CLI bundled dependency contract', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-cli-shared-deps-'));
        await mkdir(join(rootDir, 'apps', 'cli'), { recursive: true });
        await writeFile(
            join(rootDir, 'apps', 'cli', 'package.json'),
            JSON.stringify({
                bundledDependencies: [
                    '@happier-dev/plugin-sdk',
                    '@happier-dev/plugins-inspector',
                    '@happier-dev/plugins-grok',
                    '@happier-dev/plugins-inspector',
                    'external-package',
                ],
            }),
            'utf8',
        );

        expect(resolveCliSharedDepPackageNames(rootDir)).toEqual([
            'plugin-sdk',
            'plugins-inspector',
            'plugins-grok',
        ]);

        await writeFile(
            join(rootDir, 'apps', 'cli', 'package.json'),
            JSON.stringify({
                bundleDependencies: [
                    '@happier-dev/plugins-inspector',
                ],
            }),
            'utf8',
        );
        expect(resolveCliSharedDepPackageNames(rootDir)).toEqual(['plugins-inspector']);

        await writeFile(
            join(rootDir, 'apps', 'cli', 'package.json'),
            JSON.stringify({ name: '@happier-dev/cli' }),
            'utf8',
        );
        expect(() => resolveCliSharedDepPackageNames(rootDir)).toThrow(
            'has no @happier-dev bundled dependencies',
        );
    });
});
