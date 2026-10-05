import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { resolvePluginContributionKindLabel } from './pluginContributionKindLabel';

describe('plugin contribution kind label', () => {
    it('recognizes input types before later projected contribution kinds', () => {
        expect(resolvePluginContributionKindLabel(['inputTypes', 'agent']))
            .toBe(t('settingsPlugins.surfaces.kinds.inputTypes'));
    });

    it('skips plumbing contributions and leaves plumbing-only plugins unlabeled', () => {
        expect(resolvePluginContributionKindLabel(['managedDependencies', 'accountCollections', 'dragSources', 'dropTargets', 'agent']))
            .toBe(t('settingsPlugins.surfaces.kinds.agent'));
        expect(resolvePluginContributionKindLabel(['managedDependencies', 'accountCollections', 'dragSources', 'dropTargets'])).toBeNull();
    });
});
