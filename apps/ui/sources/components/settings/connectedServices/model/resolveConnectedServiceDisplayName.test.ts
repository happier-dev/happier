import { describe, expect, it } from 'vitest';

import { getLegacyConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { projectConnectedServiceRegistryEntries } from '@/sync/domains/connectedServices/connectedServiceRegistry';

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
        // No brand short name exists without a projection; the full localized name stands in.
        expect(resolveConnectedServiceShortName('openai-codex', (key) => key)).toBe('connectedServices.serviceNames.openaiCodex');
        expect(resolveConnectedServiceShortName('claude-subscription', (key) => key)).toBe('connectedServices.serviceNames.claudeSubscription');
    });

    it('falls back to the localized display name when the registry has no short name', () => {
        const entry = getLegacyConnectedServiceRegistryEntry('bitbucket');

        expect(entry.shortName).toBeUndefined();
        expect(resolveConnectedServiceShortName('bitbucket', (key) => key)).toBe('connectedServices.serviceNames.bitbucket');
    });
});

describe('resolveQualifiedConnectedServiceRegistryDisplayName', () => {
    it.each([
        ['happier.agent.claude', 'claude-subscription'],
        ['happier.machine.vercel', 'vercel-account'],
        ['happier.scm.forge.github', 'github-account'],
    ])('keeps the admitted bundled name before and after descriptor settlement (%s/%s)', (pluginId, localId) => {
        const declaration = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS[`${pluginId}/${localId}`];
        expect(declaration).toBeDefined();
        const descriptor = projectConnectedAccountDescriptorV1({ descriptor: declaration!.descriptor,
            pluginId, serviceId: localId, provenance: 'first_party', sourceKind: 'bundled',
            availability: { state: 'available', reason: 'resolved' }, diagnostics: [] });
        const entries = projectConnectedServiceRegistryEntries({ scopeKey: 'home', status: 'ready',
            descriptors: [descriptor], conflicts: [], errorReason: null });
        const service = { pluginId, localId };
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({ entries: [] }, service, key => key))
            .toBe(resolveQualifiedConnectedServiceRegistryDisplayName({ entries }, service, key => key));
    });
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

    it('names an unpublished built-in service from its qualified identity, not the generic title', () => {
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({ entries: [] }, {
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
        }, (key) => key)).toBe('Claude');
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({ entries: [] }, {
            pluginId: 'happier.agent.claude',
            localId: 'anthropic',
        }, (key) => key)).toBe('Anthropic API key');
    });

    it('names a retained external service from its stored identity without claiming it is installed', () => {
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({ entries: [] }, {
            pluginId: 'external.plugin',
            localId: 'cloud-account',
        }, (key) => key)).toBe('Cloud Account');
    });

    it('distinguishes matching service titles with their qualified plugin identity', () => {
        const entries = ['com.acme.cloud', 'com.example.cloud'].map(pluginId => ({
            serviceId: 'cloud', service: { pluginId, localId: 'cloud' },
            connectCommand: '', supportsOauth: false, projectedTitle: 'Cloud',
        }));
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({ entries }, entries[0]!.service, key => key))
            .toBe('Cloud · com.acme.cloud');
        expect(resolveQualifiedConnectedServiceRegistryDisplayName({ entries }, entries[1]!.service, key => key))
            .toBe('Cloud · com.example.cloud');
    });
});
