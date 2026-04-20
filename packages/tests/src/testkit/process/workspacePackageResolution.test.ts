import { describe, expect, it } from 'vitest';

import {
    CLI_SHARED_DEP_PACKAGE_NAMES,
    resolveCliBundledWorkspacePackageDir,
    resolveCliWorkspacePackageDir,
} from './workspacePackageResolution';

describe('workspacePackageResolution', () => {
    it('keeps the canonical CLI shared workspace package list in one place', () => {
        expect(CLI_SHARED_DEP_PACKAGE_NAMES).toEqual([
            'agents',
            'cli-common',
            'connection-supervisor',
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
    });
});
