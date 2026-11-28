import { describe, expect, it } from 'vitest';
import { INSTALLABLES_CATALOG, INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import { getInstallablesRegistryEntries } from './installablesRegistry';

describe('getInstallablesRegistryEntries', () => {
    it.each(['local-embeddings', 'difftastic'] as const)('exposes %s for offline preinstallation without version polling', (key) => {
        const entry = getInstallablesRegistryEntries().find((candidate) => candidate.key === key);
        expect(entry).toBeDefined();
        if (!entry) throw new Error(`Missing installable: ${key}`);

        const data = {
            installed: true,
            installedVersion: '0.2.12',
            sourceKind: 'pinned_archive',
            lastInstallLogPath: null,
            lastBackgroundUpdateCheckAtMs: null,
        };
        const result = { ok: true, checkedAt: 1, data } as const;
        const results = { [entry.capabilityId]: result };

        expect(entry.getStatus(results)).toEqual(data);
        expect(entry.getDetectResult(results)).toEqual(result);
        expect(entry.getStatus(undefined)).toBeNull();
        expect(entry.getStatus({ [entry.capabilityId]: { ok: false, checkedAt: 1, error: { message: 'Unavailable' } } })).toBeNull();
        expect(entry.shouldPrefetchLatestVersion({ result, data })).toBe(false);
        expect(entry.buildLatestVersionDetectRequest()).toEqual({ requests: [{ id: `dep.${key}` }] });
        expect(entry.defaultPolicy).toEqual({ autoInstallWhenNeeded: true, autoUpdateMode: 'off' });
    });

    it('returns the expected built-in installables', () => {
        const entries = getInstallablesRegistryEntries();

        expect(entries.map((e) => e.key)).toEqual(INSTALLABLES_CATALOG.map((e) => e.key));
        expect(entries.map((e) => e.capabilityId)).toEqual(INSTALLABLES_CATALOG.map((e) => e.capabilityId));
        expect(entries.every((e) => e.supportsManagedOverrideInstall === false)).toBe(true);
        expect(entries.map((e) => [e.key, e.defaultPolicy])).toEqual(expect.arrayContaining([
            [INSTALLABLE_KEYS.CODEX_ACP, { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' }],
            [INSTALLABLE_KEYS.GH, { autoInstallWhenNeeded: false, autoUpdateMode: 'notify' }],
            [INSTALLABLE_KEYS.LOCAL_EMBEDDINGS, { autoInstallWhenNeeded: true, autoUpdateMode: 'off' }],
            [INSTALLABLE_KEYS.DIFFTASTIC, { autoInstallWhenNeeded: true, autoUpdateMode: 'off' }],
        ]));
        expect(entries.find((entry) => entry.key === INSTALLABLE_KEYS.GH)).toMatchObject({
            title: 'GitHub CLI',
            iconName: 'git-pull-request',
            groupTitleKey: 'newSession.githubCliBanner.title',
            installLabels: {
                installKey: 'newSession.githubCliBanner.install',
                updateKey: 'newSession.githubCliBanner.update',
                reinstallKey: 'newSession.githubCliBanner.reinstall',
            },
        });
    });
});
