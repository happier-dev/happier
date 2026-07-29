import { describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry } from './types';
import { scmBackendProjectionFamily } from './scmBackends';
import { scmHostingProviderProjectionFamily } from './scmHostingProviders';

// Projection-family fixture supplies only the two contribution families read by
// this test; the complete registry construction contract is covered upstream.
const registry = {
    scmBackends: [
        {
            id: 'active',
            pluginId: 'acme.scm.backend',
            definition: {
                id: 'active',
                title: 'Acme VCS',
                description: 'Active backend',
                kind: 'acme',
                capabilities: ['detect', 'status'],
                metadata: { routing: 'stacked' },
            },
        },
        {
            id: 'stale',
            pluginId: 'acme.scm.backend',
            definition: {
                id: 'stale',
                title: 'Stale VCS',
                kind: 'acme',
                capabilities: ['detect'],
            },
        },
    ],
    scmHostingProviders: [
        {
            id: 'active',
            pluginId: 'acme.scm.hosting',
            definition: {
                id: 'active',
                title: 'Acme Forge',
                description: 'Active hosting provider',
                kind: 'acme',
                capabilities: ['detect', 'clone', 'pullRequest'],
                authService: 'account',
                metadata: { tier: 'enterprise' },
            },
        },
        {
            id: 'stale',
            pluginId: 'acme.scm.hosting',
            definition: {
                id: 'stale',
                title: 'Stale Forge',
                kind: 'acme',
                capabilities: ['detect'],
            },
        },
    ],
} as unknown as ResolvedContributionRegistry;

describe('SCM daemon projection runtime authority', () => {
    it('projects complete client facts only for current authoritative runtime registrations', () => {
        const context = {
            registry,
            generation: 12,
            scmRuntimeAvailability: {
                backendIds: new Set(['acme.scm.backend/active']),
                hostingProviderIds: new Set(['acme.scm.hosting/active']),
            },
        };

        expect(scmBackendProjectionFamily.project(context).entriesById).toEqual({
            'acme.scm.backend/active': expect.objectContaining({
                id: 'acme.scm.backend/active',
                localId: 'active',
                pluginId: 'acme.scm.backend',
                displayName: 'Acme VCS',
                description: 'Active backend',
                operations: ['detect', 'status'],
                metadata: { routing: 'stacked' },
            }),
        });
        expect(scmHostingProviderProjectionFamily.project(context).entriesById).toEqual({
            'acme.scm.hosting/active': expect.objectContaining({
                id: 'acme.scm.hosting/active',
                localId: 'active',
                pluginId: 'acme.scm.hosting',
                displayName: 'Acme Forge',
                description: 'Active hosting provider',
                operations: ['detect', 'clone', 'pullRequest'],
                authService: { pluginId: 'acme.scm.hosting', localId: 'account' },
                metadata: { tier: 'enterprise' },
            }),
        });
    });
});
