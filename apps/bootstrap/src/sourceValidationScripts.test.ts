import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
};

describe('bootstrap source validation', () => {
    it('runs ordinary tests from source without workspace publication', () => {
        expect(packageJson.scripts?.test).toContain('--script=test:local');
        expect(packageJson.scripts?.['test:local']).not.toMatch(/build:shared|buildSharedDeps|ensureWorkspacePackagesBuilt/);
        expect(packageJson.scripts?.['build:binary']).toContain('build:shared');
    });

    it('uses the canonical workspace-source resolver for first-party test imports', () => {
        const vitestConfig = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');

        expect(vitestConfig).toContain('createWorkspacePackageSourcesPlugin');
        expect(vitestConfig).toContain('../../scripts/testing/vitestWorkspacePackageResolution.ts');
        expect(vitestConfig).toContain('happier-bootstrap-workspace-package-sources');
        expect(vitestConfig).toContain("packageName: '@happier-dev/agents'");
        expect(vitestConfig).toContain("packageName: '@happier-dev/cli-common'");
        expect(vitestConfig).toContain("packageName: '@happier-dev/protocol'");
    });
});
