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
            backgroundServices: [{ id: 'account-supervisor' }],
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
