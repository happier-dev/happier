import { describe, expect, it } from 'vitest';
import { INSTALLABLES_CATALOG, INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import { getInstallablesRegistryEntries } from './installablesRegistry';

describe('getInstallablesRegistryEntries', () => {
    it('returns the expected built-in installables', () => {
        const entries = getInstallablesRegistryEntries();

        expect(entries.map((e) => e.key)).toEqual(INSTALLABLES_CATALOG.map((e) => e.key));
        expect(entries.map((e) => e.capabilityId)).toEqual(INSTALLABLES_CATALOG.map((e) => e.capabilityId));
        expect(entries.map((e) => e.supportsManagedOverrideInstall)).toEqual([false, false]);
        expect(entries.map((e) => [e.key, e.defaultPolicy])).toEqual([
            [INSTALLABLE_KEYS.CODEX_ACP, { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' }],
            [INSTALLABLE_KEYS.GH, { autoInstallWhenNeeded: false, autoUpdateMode: 'notify' }],
        ]);
        expect(entries.find((entry) => entry.key === INSTALLABLE_KEYS.GH)).toMatchObject({
            title: 'GitHub CLI',
            iconName: 'git-pull-request-outline',
            groupTitleKey: 'newSession.githubCliBanner.title',
            installLabels: {
                installKey: 'newSession.githubCliBanner.install',
                updateKey: 'newSession.githubCliBanner.update',
                reinstallKey: 'newSession.githubCliBanner.reinstall',
            },
        });
    });
});
