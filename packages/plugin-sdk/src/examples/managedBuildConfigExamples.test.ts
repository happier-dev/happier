import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('managed UI build config examples', () => {
    it('keeps standard first-party and public examples target-only; the advanced Vite extension is fixture-only', () => {
        for (const relativePath of [
            'packages/plugins/inspector/vite.config.ts',
            'packages/plugins/inspector/rspack.config.mjs',
            'packages/plugins/channels/vite.config.ts',
            'packages/plugins/channels/rspack.config.mjs',
            'packages/plugin-sdk/examples/projects-tasks/vite.config.mjs',
            'packages/plugin-sdk/examples/projects-tasks/rspack.config.mjs',
            'packages/plugin-sdk/examples/projects-tasks/react-native.config.cjs',
            'packages/plugin-sdk/examples/public-authoring/rspack.config.mjs',
            'packages/plugin-sdk/examples/public-authoring/react-native.config.cjs',
        ]) {
            expect(existsSync(join(repoRoot, relativePath)), relativePath).toBe(false);
        }

        const capabilityMetadata = readFileSync(
            join(repoRoot, 'packages/plugin-sdk/scripts/capabilityMatrixMetadata.mjs'),
            'utf8',
        );
        expect(capabilityMetadata).toContain(
            "'./ui/build': available('packages/plugins/inspector/happier-plugin-ui.config.mjs')",
        );
        expect(capabilityMetadata).not.toContain('packages/plugins/inspector/vite.config.ts');

        for (const exampleName of [
            'hosted-web',
            'multi-mode-fallback',
            'production-hosted-reference',
            'projects-tasks',
            'public-authoring',
            'react-native-dev-hot-reload',
            'react-native-installed',
        ]) {
            const exampleRoot = join(repoRoot, 'packages/plugin-sdk/examples', exampleName);
            const buildSource = readFileSync(join(exampleRoot, 'pluginUiBuild.ts'), 'utf8');
            expect(buildSource, exampleName).not.toContain('bundlerConfig');
            for (const configPath of ['vite.config.mjs', 'rspack.config.mjs', 'react-native.config.cjs']) {
                expect(existsSync(join(exampleRoot, configPath)), `${exampleName}/${configPath}`).toBe(false);
            }
        }
    });
});
