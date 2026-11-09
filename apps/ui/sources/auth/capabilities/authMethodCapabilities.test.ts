import { describe, expect, it } from 'vitest';

import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { projectAuthEntryMethodCapabilities, projectAuthenticationMethodCapabilities } from './authMethodCapabilities';

describe('projectAuthenticationMethodCapabilities authentication actions', () => {
    it('uses one semantic action-to-execution projection for feature and auth-entry catalogs', () => {
        const base = buildServerFeaturesResponse();
        const featuresResult = projectAuthenticationMethodCapabilities({
            ...base,
            capabilities: {
                ...base.capabilities,
                auth: {
                    ...base.capabilities.auth,
                    methods: [
                        { id: 'key_challenge', actions: [
                            { id: 'login', enabled: true, mode: 'keyed' },
                            { id: 'provision', enabled: true, mode: 'either' },
                        ] },
                        { id: 'mtls', actions: [{ id: 'login', enabled: true, mode: 'either' }] },
                        { id: 'email_password', actions: [{ id: 'connect', enabled: true, mode: 'keyed' }] },
                        { id: 'acme', actions: [
                            { id: 'login', enabled: true, mode: 'either' },
                            { id: 'provision', enabled: true, mode: 'either' },
                            { id: 'connect', enabled: true, mode: 'either' },
                        ] },
                    ],
                },
                oauth: { providers: {} },
            },
        });
        const authEntryResult = projectAuthEntryMethodCapabilities({
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: featuresResult.catalog.methods.flatMap((method) => method.enabledActions.map((action) => ({
                kind: 'authenticate' as const,
                methodId: method.id,
                action: action.id,
                mode: action.mode,
                origin: 'home' as const,
                // Every auth-entry action carries its own presentation; the feature
                // catalog's method name is what a Home publishes for one without a
                // richer projection.
                presentation: method.presentation ?? { displayName: method.id },
            }))),
            autoRedirect: null,
        });

        const semanticProjection = (result: typeof featuresResult) => result.authenticationActions.map(({ method, action, execution }) => ({
            methodId: method.id,
            action,
            execution,
        }));
        expect(semanticProjection(featuresResult)).toEqual(semanticProjection(authEntryResult));
    });

    /**
     * Released 0.2 clients misclassified any unknown method id — including
     * `email_password` — as an external OAuth provider. The features
     * projection is the fallback boundary where the shared catalog is the
     * only input, so a structured `email_password` row must resolve to the
     * exhaustive native execution and never into the generic OAuth tail.
     */
    it('keeps the features-catalog email_password method out of the OAuth fallback tail', () => {
        const base = buildServerFeaturesResponse();
        const result = projectAuthenticationMethodCapabilities({
            ...base,
            capabilities: {
                ...base.capabilities,
                auth: {
                    ...base.capabilities.auth,
                    methods: [
                        { id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
                        { id: 'email_password', actions: [{ id: 'login', enabled: true, mode: 'either' }] },
                    ],
                },
                oauth: { providers: {} },
            },
        });

        expect(result.authenticationActions).toEqual([
            expect.objectContaining({ execution: { kind: 'key_entry' } }),
            expect.objectContaining({ execution: { kind: 'email_password', action: 'login', mode: 'either' } }),
        ]);
        expect(result.authenticationActions).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ execution: expect.objectContaining({ providerId: 'email_password' }) }),
        ]));
        expect(result.configuredKeylessProviderIds).not.toContain('email_password');
    });

    it('uses a dynamic auth-entry method without a static configured-provider filter', () => {
        const result = projectAuthEntryMethodCapabilities({
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [{
                kind: 'authenticate',
                methodId: 'acme',
                action: 'login',
                mode: 'keyless',
                origin: 'home',
                presentation: { displayName: 'Acme Workforce' },
            }],
            autoRedirect: null,
        });

        expect(result.catalog.methods).toEqual([{
            id: 'acme',
            enabledActions: [{ id: 'login', mode: 'keyless' }],
            presentation: { displayName: 'Acme Workforce' },
        }]);
        expect(result.authenticationActions).toEqual([expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'acme', mode: 'keyless' },
        })]);
    });

    /**
     * A Team identity connection is projected as `connect`/`either`
     * (`resolveAuthEntry.ts:327-332`). Dropping it here left the Team entry
     * surface with a second, hand-built execution projection; the canonical
     * projector owns the action set, so `connect` resolves here and nowhere
     * else. It attaches the method to an Account that already holds its key
     * material, so an unconstrained mode stays keyed.
     */
    it('projects an OAuth connect action instead of dropping it into a second projector', () => {
        const result = projectAuthEntryMethodCapabilities({
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [{
                kind: 'authenticate',
                methodId: 'acme',
                action: 'connect',
                mode: 'either',
                origin: 'team',
                presentation: { displayName: 'Acme Workforce' },
            }],
            autoRedirect: null,
        });

        expect(result.authenticationActions).toEqual([{
            method: {
                id: 'acme',
                enabledActions: [{ id: 'connect', mode: 'either' }],
                presentation: { displayName: 'Acme Workforce' },
            },
            action: { id: 'connect', mode: 'either' },
            execution: { kind: 'oauth', providerId: 'acme', mode: 'keyed' },
        }]);
        // `connect` attaches a method to an existing Account; it is neither a
        // provisioning provider nor a keyless login entry point.
        expect(result.keyedProvisionProviderIds).toEqual([]);
        expect(result.keylessLoginMethodIds).toEqual([]);
    });

    it('preserves every structured advertised method without consulting the legacy OAuth map', () => {
        const base = buildServerFeaturesResponse();
        const result = projectAuthenticationMethodCapabilities({
            ...base,
            capabilities: {
                ...base.capabilities,
                auth: {
                    ...base.capabilities.auth,
                    methods: [
                        { id: 'key_challenge', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] },
                        { id: 'github', actions: [{ id: 'login', enabled: true, mode: 'keyless' }] },
                        { id: 'gitlab', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
                    ],
                },
                oauth: { providers: {} },
            },
        });

        expect(result.authenticationActions).toEqual([
            expect.objectContaining({ execution: { kind: 'generated_key' } }),
            expect.objectContaining({ execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' } }),
            expect.objectContaining({ execution: { kind: 'oauth', providerId: 'gitlab', mode: 'keyed' } }),
        ]);
        expect(result.configuredKeylessProviderIds).toEqual(['github']);
    });

    it('retains the configured-provider filter only for the legacy projection', () => {
        const base = buildServerFeaturesResponse();
        const result = projectAuthenticationMethodCapabilities({
            ...base,
            capabilities: {
                ...base.capabilities,
                auth: {
                    ...base.capabilities.auth,
                    methods: undefined,
                    login: { methods: [{ id: 'github', enabled: true }, { id: 'acme', enabled: true }], requiredProviders: [] },
                },
                oauth: { providers: { github: { configured: true, enabled: true } } },
            },
        });

        expect(result.catalog.provenance).toBe('legacy');
        expect(result.authenticationActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' } }),
        ]));
        expect(result.authenticationActions).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ execution: expect.objectContaining({ providerId: 'acme' }) }),
        ]));
    });
});
