import { describe, expect, it } from 'vitest';

describe('buildBackgroundServiceReplacementPromptPresentation', () => {
    it('normalizes target mode labels and service summaries for replacement prompts', async () => {
        const { buildBackgroundServiceReplacementPromptPresentation } = await import('./backgroundServiceReplacementPromptPresentation');

        expect(buildBackgroundServiceReplacementPromptPresentation({
            targetServerUrl: 'https://relay.example.test',
            targetReleaseChannel: 'preview',
            services: [{
                label: 'com.happier.cli.daemon.stable.default',
                releaseChannel: 'stable',
                targetMode: 'pinned',
                running: true,
            }],
        })).toEqual({
            targetServerUrl: 'https://relay.example.test',
            targetReleaseChannel: 'preview',
            services: [{
                label: 'com.happier.cli.daemon.stable.default',
                releaseChannel: 'stable',
                targetMode: 'pinned',
                targetModeLabel: 'legacy pinned background service',
                running: true,
                summary: 'com.happier.cli.daemon.stable.default (stable, legacy pinned background service)',
            }],
        });
    });
});
