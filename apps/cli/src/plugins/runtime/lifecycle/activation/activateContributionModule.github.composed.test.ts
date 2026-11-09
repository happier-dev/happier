import { describe, expect, it } from 'vitest';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { loadBundledPluginLocators } from '@/plugins/projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { activateContributionModule } from './activateContributionModule';

describe('GitHub contribution activation through the host', () => {
    it.each(['bundled', 'without-pull-request-metadata'] as const)(
        'rejects %s overlapping activation without replacing the active generation',
        async basis => {
            const github = await import('@happier-dev/plugins-scm-github');
            const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(row => row.pluginId === github.PLUGIN_MANIFEST.id);
            if (!locator) throw new Error('Missing bundled GitHub locator');
            const bundled = loadBundledPluginLocators([locator])[0];
            if (!bundled) throw new Error('Missing bundled GitHub declaration');
            const provider = github.PLUGIN_MANIFEST.contributes.targetedPluginContributions.find(row => row.target.pluginId === 'happier.channels');
            expect(provider?.descriptor).toHaveProperty('pullRequests.repositoryKind', 'github');
            expect(bundled.manifest.contributes.targetedPluginContributions.find(row => row.target.pluginId === 'happier.channels'))
                .toEqual(provider);

            // The metadata is optional. Omitting it isolates the former provider
            // shape while keeping the same real GitHub activation and host rights.
            const declaration = basis === 'bundled' ? bundled.manifest : {
                ...github.PLUGIN_MANIFEST,
                contributes: {
                    ...github.PLUGIN_MANIFEST.contributes,
                    targetedPluginContributions: github.PLUGIN_MANIFEST.contributes.targetedPluginContributions.map(row => {
                        if (row.target.pluginId !== 'happier.channels') return row;
                        const descriptor = { ...row.descriptor };
                        delete descriptor.pullRequests;
                        return { ...row, descriptor };
                    }),
                },
            };
            const admitted = ingestCanonicalPluginManifest(declaration, {
                manifestAuthority: 'bundled_first_party', sourceProvenance: 'registryCustodied',
            });
            if (!admitted.ok) throw new Error(admitted.diagnostics.map(row => row.message).join('\n'));
            const activate = (occurrenceId: string) => activateContributionModule({
                pluginId: admitted.manifest.id, occurrenceId, manifest: admitted.manifest,
                manifestAuthority: 'bundled_first_party', moduleNamespace: github, isOccurrenceCurrent: () => true,
            });
            const first = await activate('github-current');
            try {
                expect(first.status, JSON.stringify(first.diagnostics)).toBe('active');
                expect(first.registrations.filter(row => row.family === 'actions').map(row => row.localId).sort())
                    .toEqual(admitted.manifest.contributes.actions.filter(row => row.execution.target === 'daemon').map(row => row.id).sort());
                const overlap = await activate('github-overlap');
                try {
                    expect(overlap.status).toBe('unavailable');
                    expect(overlap.diagnostics).toEqual(expect.arrayContaining([
                        expect.objectContaining({
                            code: 'plugin_activation_failed',
                            message: expect.stringContaining('GitHub plugin activation overlap would replace the active plugin generation'),
                        }),
                    ]));
                } finally { await overlap.dispose(); }
            } finally { await first.dispose(); }
            const replacement = await activate('github-after-cleanup');
            try {
                expect(replacement.status, JSON.stringify(replacement.diagnostics)).toBe('active');
            } finally { await replacement.dispose(); }
        },
    );
});
