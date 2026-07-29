import { normalize, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { workspacePackageSourcesPlugin } from './vitestWorkspacePackageResolution';

const FIRST_PARTY_AGENT_PLUGIN_PACKAGES = [
    ['@happier-dev/plugins-antigravity', 'antigravity'],
    ['@happier-dev/plugins-auggie', 'auggie'],
    ['@happier-dev/plugins-claude', 'claude'],
    ['@happier-dev/plugins-codex', 'codex'],
    ['@happier-dev/plugins-copilot', 'copilot'],
    ['@happier-dev/plugins-cursor', 'cursor'],
    ['@happier-dev/plugins-gemini', 'gemini'],
    ['@happier-dev/plugins-grok', 'grok'],
    ['@happier-dev/plugins-kilo', 'kilo'],
    ['@happier-dev/plugins-kimi', 'kimi'],
    ['@happier-dev/plugins-kiro', 'kiro'],
    ['@happier-dev/plugins-ohmypi', 'ohmypi'],
    ['@happier-dev/plugins-opencode', 'opencode'],
    ['@happier-dev/plugins-pi', 'pi'],
    ['@happier-dev/plugins-qwen', 'qwen'],
    ['@happier-dev/plugins-review-coderabbit', 'review-coderabbit'],
    ['@happier-dev/plugins-review-deepsec', 'review-deepsec'],
] as const;

describe('CLI Vitest workspace package source resolution', () => {
    it('resolves every first-party Agent manifest from current source', () => {
        expect(FIRST_PARTY_AGENT_PLUGIN_PACKAGES).toHaveLength(17);

        for (const [packageName, pluginDirectory] of FIRST_PARTY_AGENT_PLUGIN_PACKAGES) {
            const sourceRoot = resolve('../../packages/plugins', pluginDirectory, 'src');
            expect(
                normalize(workspacePackageSourcesPlugin.resolveId(`${packageName}/manifest`) ?? ''),
                packageName,
            ).toBe(normalize(resolve(sourceRoot, 'manifest.ts')));
            expect(
                normalize(workspacePackageSourcesPlugin.resolveId(packageName) ?? ''),
                `${packageName}: activation entrypoint`,
            ).toBe(normalize(resolve(sourceRoot, 'index.ts')));
        }
    });
});
