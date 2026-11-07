import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readSavedSecretUsedBySources, subscribeSavedSecretUsedBySources } from './savedSecretUsedBy';

const initial = storage.getState();
afterEach(() => storage.setState(initial, true));

describe('Saved Secret reference settings demand', () => {
    it('does no census reads for unrelated settings and publishes changed future reference carriers', () => {
        const scope = { serverId: 'reference-home', accountId: 'reference-account' };
        const census = vi.fn(() => readSavedSecretUsedBySources(scope).settings);
        const stop = subscribeSavedSecretUsedBySources(census);
        try {
            for (let index = 0; index < 3; index++) {
                const state = storage.getState();
                state.applySettings({ ...state.settings, showLineNumbers: !state.settings.showLineNumbers }, index + 1);
            }
            storage.setState(state => ({ settings: { ...state.settings, themePreference: 'dark' } }));
            expect(census).toHaveBeenCalledTimes(0);

            storage.getState().applySettings(settingsParse({ ...storage.getState().settings,
                futureReferenceCarrier: { secretRef: 'future-reference' },
            }), 4);
            expect(census).toHaveBeenCalledTimes(1);
            expect(census.mock.results.at(-1)?.value).toMatchObject({
                futureReferenceCarrier: { secretRef: 'future-reference' },
            });

            const withoutCarrier: Record<string, unknown> = { ...storage.getState().settings };
            delete withoutCarrier.futureReferenceCarrier;
            storage.getState().applySettings(settingsParse(withoutCarrier), 5);
            expect(census).toHaveBeenCalledTimes(2);
            expect(census.mock.results.at(-1)?.value).not.toHaveProperty('futureReferenceCarrier');

            storage.setState({ settings: settingsParse({ ...storage.getState().settings,
                restoredReferenceCarrier: { secretRef: 'restored-reference' },
            }) });
            expect(census).toHaveBeenCalledTimes(3);
            expect(census.mock.results.at(-1)?.value).toMatchObject({
                restoredReferenceCarrier: { secretRef: 'restored-reference' },
            });
            storage.setState({ ...storage.getState(), settings: initial.settings }, true);
            expect(census).toHaveBeenCalledTimes(4);
            expect(census.mock.results.at(-1)?.value).not.toHaveProperty('restoredReferenceCarrier');
        } finally { stop(); }
    });
});
