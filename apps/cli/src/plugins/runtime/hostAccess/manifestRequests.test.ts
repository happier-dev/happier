import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
    resolveManifestHostAccessRequests,
    resolveManifestHostAccessRequestsForQualifiedContribution,
} from './manifestRequests';

function manifest() {
    const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
        id: 'acme.accounts',
        hostAccess: {
            required: [{
                id: 'required-account',
                capability: 'connectedAccounts',
                reason: 'Use required account',
                scope: {
                    serviceRefs: ['account'],
                    operations: ['use'],
                },
            }],
            optional: [{
                id: 'optional-account',
                capability: 'connectedAccounts',
                reason: 'Select optional account',
                scope: {
                    serviceRefs: ['account'],
                    operations: ['select'],
                },
            }],
        },
        contributes: {
            projectNativeAdapters: [{ id: 'pixi', files: ['pixi.toml'], roles: ['resolveCommand', 'prepareToolchain'] }],
            backgroundServices: [{ id: 'account-supervisor' }],
            composerReferences: [{ id: 'account-reference', title: 'Account', description: 'Find Account context', icon: 'search', triggers: ['@'] }],
            composerAttachments: [{ id: 'account-attachment', title: 'Account', icon: 'search', cardinality: 'many', valueSchema: { type: 'object' } }],
            requestInterceptors: [{ id: 'account-interceptor', origins: ['https://example.test'] }],
            events: [{ id: 'account-event', kind: 'subscription', target: { kind: 'plugin', event: 'changed' } }],
            mcp: { servers: [{ id: 'account-tools', title: 'Account', kind: 'dynamic' }],
                discoverySources: [{ id: 'account-discovery', title: 'Account', loadedInHappierSessions: true }] },
            notificationChannels: [{
                id: 'account-notifier',
                kind: 'plugin',
                title: 'Account notifier',
                defaultEnabled: true,
            }],
            connectedAccountDescriptors: [{
                id: 'account',
                title: 'Account',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                    }],
                },
            }],
        },
    }));
    if (!parsed) throw new Error('Expected canonical manifest fixture');
    return parsed;
}

describe('resolveManifestHostAccessRequests', () => {
    it('resolves required and optional request ids through one manifest owner in declaration order', () => {
        const pluginManifest = manifest();

        expect(resolveManifestHostAccessRequests({
            manifest: pluginManifest,
            pluginId: pluginManifest.id,
            contribution: { family: 'actions', localId: 'run' },
            requestIds: ['optional-account', 'required-account'],
        })).toEqual([
            {
                request: pluginManifest.hostAccess.optional[0],
                required: false,
            },
            {
                request: pluginManifest.hostAccess.required[0],
                required: true,
            },
        ]);

        expect(resolveManifestHostAccessRequests({
            manifest: pluginManifest,
            pluginId: pluginManifest.id,
            contribution: { family: 'resources', localId: 'live-status' },
            requestIds: ['required-account'],
        })).toEqual([{
            request: pluginManifest.hostAccess.required[0],
            required: true,
        }]);
    });

    it('gives background services the plugin generation\'s full normalized HostAccess declaration', () => {
        const pluginManifest = manifest();

        expect(resolveManifestHostAccessRequests({
            manifest: pluginManifest,
            pluginId: pluginManifest.id,
            contribution: { family: 'backgroundServices', localId: 'account-supervisor' },
        })).toEqual([
            {
                request: pluginManifest.hostAccess.required[0],
                required: true,
            },
            {
                request: pluginManifest.hostAccess.optional[0],
                required: false,
            },
        ]);
    });

    it('resolves every live full-service qualified caller through its declared manifest contribution', () => {
        const pluginManifest = manifest();

        for (const contribution of [
            {
                id: 'pixi',
                qualifiedId: 'acme.accounts/projectNativeAdapters/pixi',
            },
            {
                id: 'account-supervisor',
                qualifiedId: 'acme.accounts/backgroundServices/account-supervisor',
            },
            {
                id: 'account-notifier',
                qualifiedId: 'acme.accounts/notificationChannels/account-notifier',
            },
            {
                id: 'account',
                qualifiedId: 'acme.accounts/connectedAccountDescriptors/account',
            },
            { id: 'account-reference', qualifiedId: 'acme.accounts/composerReferences/account-reference' },
            { id: 'account-attachment', qualifiedId: 'acme.accounts/composerAttachments/account-attachment' },
            { id: 'account-interceptor', qualifiedId: 'acme.accounts/requestInterceptors/account-interceptor' },
            { id: 'account-event', qualifiedId: 'acme.accounts/events/account-event' },
            { id: 'account-tools', qualifiedId: 'acme.accounts/mcp.servers/account-tools' },
            { id: 'account-discovery', qualifiedId: 'acme.accounts/mcp.discoverySources/account-discovery' },
        ]) {
            expect(resolveManifestHostAccessRequestsForQualifiedContribution({
                manifest: pluginManifest,
                pluginId: pluginManifest.id,
                contribution,
            })).toEqual([
                {
                    request: pluginManifest.hostAccess.required[0],
                    required: true,
                },
                {
                    request: pluginManifest.hostAccess.optional[0],
                    required: false,
                },
            ]);
        }

        expect(resolveManifestHostAccessRequestsForQualifiedContribution({
            manifest: pluginManifest,
            pluginId: pluginManifest.id,
            contribution: {
                id: 'account-supervisor',
                qualifiedId: 'acme.accounts/agents/account-supervisor',
            },
        })).toBeNull();
    });

    it('fails closed when a contribution references a missing request id', () => {
        const pluginManifest = manifest();

        expect(() => resolveManifestHostAccessRequests({
            manifest: pluginManifest,
            pluginId: pluginManifest.id,
            contribution: { family: 'hooks', localId: 'before-run' },
            requestIds: ['missing'],
        })).toThrow(
            "Target hook 'acme.accounts/hooks/before-run' references missing host access request 'missing'",
        );
    });
});
