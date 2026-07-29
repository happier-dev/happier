import { describe, expect, it } from 'vitest';

import {
    applySavedSecretReplacementIntent,
} from './savedSecretMutations';
import type { SavedSecret } from './savedSecretTypes';

function savedSecret(id: string, value: string, updatedAt = 1): SavedSecret {
    return {
        id,
        name: id,
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value },
        createdAt: 1,
        updatedAt,
    };
}

describe('SavedSecret functional Account Settings writer', () => {
    it('replays only the captured add intent and preserves a concurrent canonical secret', () => {
        const base = [savedSecret('base', 'base')];
        const proposed = [savedSecret('new', 'new'), ...base];
        const concurrent = savedSecret('concurrent', 'concurrent');

        const result = applySavedSecretReplacementIntent({
            current: { secrets: [concurrent, ...base] },
            base,
            proposed,
        });

        expect((result.settings.secrets as SavedSecret[]).map(({ id }) => id))
            .toEqual(['new', 'concurrent', 'base']);
    });

    it('preserves the referenced secret and fails typed instead of replaying a whole-array delete', () => {
        const base = [savedSecret('bound', 'bound')];
        expect(() => applySavedSecretReplacementIntent({
            current: {
                secrets: base,
                acpCatalogSettingsV1: {
                    v: 2,
                    backends: [{
                        env: {
                            TOKEN: { t: 'savedSecret', secretId: 'bound' },
                        },
                    }],
                },
            },
            base,
            proposed: [],
        })).toThrowError(expect.objectContaining({
            code: 'saved_secret_in_use',
        }));
    });

    it('returns the stable typed refusal before generic replacement can mutate a Connected Account configuration', () => {
        const base = [savedSecret('bound', 'old')];
        const proposed = [savedSecret('bound', 'new', 2)];
        expect(() => applySavedSecretReplacementIntent({
            current: {
                secrets: base,
                connectedAccountServiceConfigurationsV1: {
                    v: 1,
                    entries: [{
                        service: { pluginId: 'plugin.example', localId: 'service' },
                        modeId: 'token',
                        revision: 'configuration-1',
                        values: {},
                        secretRefs: { token: 'bound' },
                    }],
                },
            },
            base,
            proposed,
        })).toThrowError(expect.objectContaining({
            code: 'saved_secret_referenced_by_connected_account_configuration',
            references: [{
                owner: 'connectedAccountConfiguration',
                path: 'connectedAccountServiceConfigurationsV1.entries[0].secretRefs.token',
            }],
        }));
    });
});
