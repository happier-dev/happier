import { describe, expect, it } from 'vitest';
import { resolveConnectedServiceProfileLabel, resolveQualifiedConnectedAccountLabel } from './connectedServiceProfilePreferences.js';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };

describe('canonical connected Account label projection', () => {
    it('does not resolve scalar-display labels from unencoded personal-label aliases', () => {
        const serviceId = 'happier.agent.codex/openai-codex';
        expect(resolveConnectedServiceProfileLabel({ serviceId, profileId: 'default', labelsByKey: {
            'happier.agent.codex/openai-codex/default': 'Retired raw label',
        } })).toBeNull();
        expect(resolveConnectedServiceProfileLabel({ serviceId, profileId: 'folder/account:one', labelsByKey: {
            'happier.agent.codex%2Fopenai-codex/folder%2Faccount%3Aone': 'Canonical label',
            'happier.agent.codex/openai-codex/folder/account:one': 'Retired raw label',
        } })).toBe('Canonical label');
    });
    it('does not resolve personal labels from legacy scalar or unencoded qualified keys', () => {
        for (const labelsByKey of [
            { 'openai-codex/default': 'Legacy personal label' },
            { 'happier.agent.codex/openai-codex/default': 'Raw qualified personal label' },
        ]) {
            expect(resolveQualifiedConnectedAccountLabel({ service, accountId: 'default', labelsByKey }))
                .toBeNull();
        }
    });

    it('resolves exact canonical default and opaque Account identities without service or encoding aliases', () => {
        expect(resolveQualifiedConnectedAccountLabel({ service, accountId: 'default', labelsByKey: {
            'happier.agent.codex%2Fopenai-codex/default': '  Default personal label  ',
            'openai-codex/default': 'Legacy value',
        } })).toBe('Default personal label');
        expect(resolveQualifiedConnectedAccountLabel({ service, accountId: 'folder/account:one', labelsByKey: {
            'happier.agent.codex%2Fopenai-codex/folder%2Faccount%3Aone': 'Opaque personal label',
            'happier.agent.codex%2Fother/folder%2Faccount%3Aone': 'Other service',
        } })).toBe('Opaque personal label');
        expect(resolveQualifiedConnectedAccountLabel({ service, accountId: 'folder%2Faccount:one', labelsByKey: {
            'happier.agent.codex%2Fopenai-codex/folder%2Faccount%3Aone': 'Different Account',
        } })).toBeNull();
    });
});
