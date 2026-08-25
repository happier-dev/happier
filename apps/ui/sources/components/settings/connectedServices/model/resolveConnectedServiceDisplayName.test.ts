import { describe, expect, it } from 'vitest';

import { getLegacyConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import {
    resolveConnectedServiceDisplayName,
    resolveConnectedServiceShortName,
    resolveQualifiedConnectedServiceRegistryDisplayName,
} from './resolveConnectedServiceDisplayName';

describe('resolveConnectedServiceDisplayName', () => {
    it('uses only the generated legacy adapter when no qualified descriptor is projected', () => {
        const entry = getLegacyConnectedServiceRegistryEntry('claude-subscription');

        expect(resolveConnectedServiceDisplayName('claude-subscription', (key) => key)).toBe(
            entry.displayNameKey ?? 'connectedServices.fallbackName',
        );
    });

    it('does not let a scalar built-in id manufacture descriptor presentation', () => {
        const entry = getLegacyConnectedServiceRegistryEntry('github');

        expect(resolveConnectedServiceDisplayName('github', (key) => key)).toBe(
            entry.displayNameKey ?? 'connectedServices.fallbackName',
        );
    });
});

describe('resolveConnectedServiceShortName', () => {
    it('does not maintain an unprojected static short-name registry', () => {
        expect(resolveConnectedServiceShortName('openai-codex', (key) => key)).toBe('connectedServices.fallbackName');
        expect(resolveConnectedServiceShortName('claude-subscription', (key) => key)).toBe('connectedServices.fallbackName');
    });

    it('falls back to the localized display name when the registry has no short name', () => {
        const entry = getLegacyConnectedServiceRegistryEntry('bitbucket');

        expect(entry.shortName).toBeUndefined();
        expect(resolveConnectedServiceShortName('bitbucket', (key) => key)).toBe('connectedServices.fallbackName');
    });
});

describe('resolveQualifiedConnectedServiceRegistryDisplayName', () => {
    it('reads the exact daemon-projected applied descriptor instead of an installed-manifest guess', () => {
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({
            entries: [{
                serviceId: 'external-gateway',
                service: { pluginId: 'external.plugin', localId: 'gateway' },
                connectCommand: '',
                supportsOauth: false,
                projectedTitle: 'External Gateway',
            }],
        }, { pluginId: 'external.plugin', localId: 'gateway' }, (key) => key)).toBe('External Gateway');
    });

    it('renders a plugin-declared descriptor title in the reader\u2019s language', () => {
        // `plugins.sentry.account.title` ships translated in every bundled
        // locale; reading only the developer `fallback` showed English to
        // every non-English user.
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({
            entries: [{
                serviceId: 'sentry',
                service: { pluginId: 'happier.sentry', localId: 'sentry' },
                connectCommand: '',
                supportsOauth: false,
                projectedTitle: {
                    key: 'plugins.sentry.account.title',
                    fallback: 'Sentry account',
                },
            }],
        }, { pluginId: 'happier.sentry', localId: 'sentry' }, (key) => key, (pluginId, value) => (
            pluginId === 'happier.sentry'
            && typeof value === 'object'
            && value !== null
            && 'key' in value
                ? 'Compte Sentry'
                : ''
        )))
            .toBe('Compte Sentry');
    });

    it('keeps the developer fallback when the declared key is not in the catalog', () => {
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({
            entries: [{
                serviceId: 'gateway',
                service: { pluginId: 'external.plugin', localId: 'gateway' },
                connectCommand: '',
                supportsOauth: false,
                projectedTitle: {
                    key: 'plugins.external.totallyUnknown.title',
                    fallback: 'External Gateway',
                },
            }],
        }, { pluginId: 'external.plugin', localId: 'gateway' }, (key) => key))
            .toBe('External Gateway');
    });

    it('fails closed to the generic service title when no applied descriptor matches', () => {
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({ entries: [] }, {
            pluginId: 'external.plugin',
            localId: 'gateway',
        }, (key) => key)).toBe('connectedServices.fallbackName');
    });
});
