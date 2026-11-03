import { describe, expect, it } from 'vitest';
import type { ProjectedAuthenticationCatalog } from '@happier-dev/cli-common/authentication/authMethodCatalog';

import type { VerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';

import { composeWelcomeEntryModel, type WelcomeAuthenticationMethod } from './composeWelcomeEntryModel';

const target = { kind: 'saved_profile', profileRef: 'home-a' } as const;
const method = (id: string, actionId: 'login' | 'provision', mode: 'keyed' | 'keyless'): WelcomeAuthenticationMethod => ({
    method: { id, enabledActions: [{ id: actionId, mode }] } satisfies ProjectedAuthenticationCatalog['methods'][number],
    action: { id: actionId, mode },
    execution: id === 'key_challenge'
        ? actionId === 'provision' ? { kind: 'generated_key' } : { kind: 'key_entry' }
        : id === 'mtls'
            ? { kind: 'mtls' }
            : { kind: 'oauth', providerId: id, mode },
    authority: { purpose: 'home', target },
    intendedHome: target,
});

describe('composeWelcomeEntryModel', () => {
    it('keeps Home actions live while optional service discovery is loading', () => {
        const model = composeWelcomeEntryModel({
            target: { kind: 'selected_home', home: target, label: 'Home A' },
            homeMethods: [method('key_challenge', 'provision', 'keyed'), method('github', 'login', 'keyless')],
            context: { kind: 'home' },
            allowedNavigation: { changeHome: true, selectService: false, scanOrPasteHome: true, createPersonalHome: false },
            serviceCatalogState: { kind: 'loading', hintName: 'Happier' },
            userHistory: 'first_time',
        });

        expect(model.actions.map((row) => row.action.kind)).toEqual([
            'authenticate', 'authenticate', 'scan_or_paste_home', 'choose_home',
        ]);
        expect(model.actions.filter((row) => row.emphasis === 'primary')).toHaveLength(1);
        expect(model.notice).toEqual({ kind: 'service_loading', serviceName: 'Happier', hasUsableHomeMethods: true });
    });

    describe('first-run hierarchy', () => {
        const serviceAuthority = {
            endpointUrl: 'https://accounts.example.test',
            serverIdentityId: 'service-a',
            canonicalServerUrl: 'https://accounts.example.test',
        } as unknown as VerifiedAccountServiceAuthority;
        const serviceMethod = (id: string, actionId: 'login' | 'provision', mode: 'keyed' | 'keyless'): WelcomeAuthenticationMethod => ({
            ...method(id, actionId, mode),
            authority: { purpose: 'account_service', service: serviceAuthority },
            intendedHome: null,
        } as WelcomeAuthenticationMethod);
        const shape = (model: ReturnType<typeof composeWelcomeEntryModel>) => model.actions.map((row) => [
            row.action.kind === 'authenticate'
                ? (row.action.labelRole === 'new_here' ? 'new_here' : row.action.request.method.id)
                : row.action.kind,
            row.emphasis,
        ]);
        const navigation = { changeHome: true, selectService: true, scanOrPasteHome: true, createPersonalHome: true };

        it('leads a first run with the service door, offers the Personal Home next, and quiets everything else', () => {
            const model = composeWelcomeEntryModel({
                target: { kind: 'none' },
                homeMethods: [],
                context: { kind: 'home' },
                allowedNavigation: navigation,
                serviceCatalogState: {
                    kind: 'ready',
                    authority: serviceAuthority,
                    name: 'Happier Cloud',
                    methods: [serviceMethod('key_challenge', 'login', 'keyed'), serviceMethod('key_challenge', 'provision', 'keyed'), serviceMethod('github', 'login', 'keyless')],
                },
                userHistory: 'first_time',
            });

            expect(shape(model)).toEqual([
                ['new_here', 'primary'],
                ['create_personal_home', 'secondary'],
                ['key_challenge', 'tertiary'],
                ['github', 'tertiary'],
                ['scan_or_paste_home', 'tertiary'],
                ['choose_home', 'tertiary'],
                ['choose_sign_in_service', 'tertiary'],
            ]);
        });

        it('gives a build without hosted defaults its own Home and service doors', () => {
            const model = composeWelcomeEntryModel({
                target: { kind: 'none' },
                homeMethods: [],
                context: { kind: 'home' },
                allowedNavigation: navigation,
                serviceCatalogState: { kind: 'not_offered' },
                userHistory: 'first_time',
            });

            expect(shape(model)).toEqual([
                ['create_personal_home', 'primary'],
                ['choose_home', 'secondary'],
                ['choose_sign_in_service', 'secondary'],
                ['scan_or_paste_home', 'tertiary'],
            ]);
        });

        it('leads with connecting to a Home when no Personal Home can be created', () => {
            const model = composeWelcomeEntryModel({
                target: { kind: 'none' },
                homeMethods: [],
                context: { kind: 'home' },
                allowedNavigation: { ...navigation, createPersonalHome: false },
                serviceCatalogState: { kind: 'not_offered' },
                userHistory: 'first_time',
            });

            expect(shape(model)[0]).toEqual(['choose_home', 'primary']);
        });

        it('keeps a returning person on their own sign-in, with the rest quiet', () => {
            const model = composeWelcomeEntryModel({
                target: { kind: 'selected_home', home: target, label: 'Home A' },
                homeMethods: [method('github', 'login', 'keyless'), method('key_challenge', 'provision', 'keyed')],
                context: { kind: 'home' },
                allowedNavigation: { ...navigation, selectService: false },
                serviceCatalogState: { kind: 'not_offered' },
                userHistory: 'returning',
            });

            expect(shape(model)).toEqual([
                ['github', 'primary'],
                ['scan_or_paste_home', 'tertiary'],
                ['choose_home', 'tertiary'],
                ['create_personal_home', 'secondary'],
                ['new_here', 'secondary'],
            ]);
        });
    });

    it('distinguishes an optional-service failure from a Home entry dead end', () => {
        const base = {
            target: { kind: 'selected_home' as const, home: target, label: 'Home A' },
            context: { kind: 'home' as const },
            allowedNavigation: { changeHome: false, selectService: false, scanOrPasteHome: false, createPersonalHome: false },
            serviceCatalogState: { kind: 'unavailable' as const, hintName: 'Happier' },
            userHistory: 'returning' as const,
        };

        expect(composeWelcomeEntryModel({ ...base, homeMethods: [method('github', 'login', 'keyless')] }).notice)
            .toEqual({ kind: 'service_unavailable', serviceName: 'Happier', hasUsableHomeMethods: true });
        expect(composeWelcomeEntryModel({ ...base, homeMethods: [] }).notice)
            .toEqual({ kind: 'service_unavailable', serviceName: 'Happier', hasUsableHomeMethods: false });
    });

    it('preserves every service provider and its exact authority tuple', () => {
        const features = buildServerFeaturesResponse();
        const authority = {
            endpointUrl: 'https://accounts.example.test',
            serverIdentityId: 'service-a',
            canonicalServerUrl: 'https://accounts.example.test',
            capability: {
                version: 1 as const,
                homeDirectory: true,
                homeEnrollment: true,
                homeLoginAssertion: {
                    keyId: 'a'.repeat(64),
                    publicKeyBase64Url: 'A'.repeat(43),
                },
            },
            snapshot: {
                status: 'ready' as const,
                serverIdentityId: 'service-a',
                features: {
                    ...features,
                    capabilities: {
                        ...features.capabilities,
                        accountDirectory: {
                            version: 1 as const,
                            homeDirectory: true,
                            homeEnrollment: true,
                            homeLoginAssertion: {
                                keyId: 'a'.repeat(64),
                                publicKeyBase64Url: 'A'.repeat(43),
                            },
                        },
                        server: { canonicalServerUrl: 'https://accounts.example.test' },
                        serverIdentity: { serverIdentityId: 'service-a' },
                    },
                },
            },
        } satisfies VerifiedAccountServiceAuthority;
        const serviceMethod = (id: string): WelcomeAuthenticationMethod => ({
            method: { id, enabledActions: [{ id: 'login', mode: 'keyless' }] },
            action: { id: 'login', mode: 'keyless' },
            execution: { kind: 'oauth', providerId: id, mode: 'keyless' },
            authority: { purpose: 'account_service', service: authority },
            intendedHome: target,
        });
        const model = composeWelcomeEntryModel({
            target: { kind: 'explicit_home', home: target, label: 'Home A' },
            homeMethods: [],
            context: { kind: 'home' },
            allowedNavigation: { changeHome: false, selectService: false, scanOrPasteHome: true, createPersonalHome: false },
            serviceCatalogState: { kind: 'ready', authority, name: 'Acme', methods: [serviceMethod('github'), serviceMethod('google')] },
            userHistory: 'returning',
        });

        expect(model.actions.slice(1).map((row) => row.action.kind === 'authenticate' ? row.action.request.method.id : row.action.kind))
            .toEqual(['github', 'google']);
        expect(model.actions[1]?.id).toContain('service:service-a:https://accounts.example.test|account_service|github|login|keyless');
    });

    describe('same-server dual-role dedupe', () => {
        const selfAuthority = (serverIdentityId: string): VerifiedAccountServiceAuthority => {
            const features = buildServerFeaturesResponse();
            const capability = {
                version: 1 as const,
                homeDirectory: true,
                homeEnrollment: true,
                homeLoginAssertion: { keyId: 'a'.repeat(64), publicKeyBase64Url: 'A'.repeat(43) },
            };
            return {
                endpointUrl: 'https://home-a.example.test',
                serverIdentityId,
                canonicalServerUrl: 'https://home-a.example.test',
                capability,
                snapshot: {
                    status: 'ready' as const,
                    serverIdentityId,
                    features: {
                        ...features,
                        capabilities: {
                            ...features.capabilities,
                            accountDirectory: capability,
                            server: { canonicalServerUrl: 'https://home-a.example.test' },
                            serverIdentity: { serverIdentityId },
                        },
                    },
                },
            };
        };
        const serviceMethod = (
            authority: VerifiedAccountServiceAuthority,
            id: string,
            execution: WelcomeAuthenticationMethod['execution'] = { kind: 'oauth', providerId: id, mode: 'keyless' },
            actionId: 'login' | 'provision' = 'login',
            mode: 'keyed' | 'keyless' = 'keyless',
        ): WelcomeAuthenticationMethod => ({
            method: { id, enabledActions: [{ id: actionId, mode }] },
            action: { id: actionId, mode },
            execution: execution as never,
            authority: { purpose: 'account_service', service: authority },
            intendedHome: target,
        });
        const methodIds = (model: ReturnType<typeof composeWelcomeEntryModel>) => model.actions
            .filter((row) => row.action.kind === 'authenticate')
            .map((row) => row.action.kind === 'authenticate'
                ? `${row.action.request.authority.purpose}:${row.action.request.method.id}:${row.action.request.action.id}`
                : row.action.kind);

        it('targets a chosen sign-in service instead of the unrelated seeded Home', () => {
            const authority = selfAuthority('identity-service-b');
            const model = composeWelcomeEntryModel({
                target: { kind: 'none' },
                homeMethods: [method('key_challenge', 'provision', 'keyed'), method('github', 'login', 'keyless')],
                observedHomeServerIdentityId: 'identity-home-a',
                context: { kind: 'home' },
                allowedNavigation: { changeHome: true, selectService: true, scanOrPasteHome: true, createPersonalHome: false },
                serviceCatalogState: {
                    kind: 'ready', authority, name: 'Service B',
                    methods: [serviceMethod(authority, 'key_challenge', { kind: 'generated_key' }, 'provision', 'keyed'), serviceMethod(authority, 'github')],
                },
                userHistory: 'first_time',
            });
            expect(methodIds(model)).toEqual(['account_service:key_challenge:provision', 'account_service:github:login']);
            expect(model.targetContext).toEqual({ label: 'Service B' });
            expect(model.showHomeStatus).toBe(false);
            expect(model.actions[0]?.action).toMatchObject({ kind: 'authenticate', labelRole: 'new_here' });
            expect(model.actions.filter((row) => row.action.kind === 'authenticate' && row.action.labelRole === 'new_here')).toHaveLength(1);
        });

        it('keeps a selected service authoritative while unavailable, without fallback Home methods', () => {
            const model = composeWelcomeEntryModel({
                target: { kind: 'selected_service', label: 'Service B' },
                homeMethods: [method('key_challenge', 'provision', 'keyed')],
                context: { kind: 'home' },
                allowedNavigation: { changeHome: true, selectService: true, scanOrPasteHome: true, createPersonalHome: false },
                serviceCatalogState: { kind: 'unavailable', hintName: 'Service B' },
                userHistory: 'first_time',
            });
            expect(methodIds(model)).toEqual([]);
            expect(model.showHomeStatus).toBe(false);
            expect(model.notice).toEqual({ kind: 'service_unavailable', serviceName: 'Service B', hasUsableHomeMethods: false });
            expect(model.actions.some((row) => row.action.kind === 'choose_sign_in_service')).toBe(true);
        });

        it('keeps the direct Home row and drops the identical same-server service row', () => {
            const authority = selfAuthority('identity-home-a');
            const model = composeWelcomeEntryModel({
                target: { kind: 'selected_home', home: target, label: 'Home A' },
                homeMethods: [method('github', 'login', 'keyless'), method('key_challenge', 'login', 'keyed')],
                observedHomeServerIdentityId: 'identity-home-a',
                context: { kind: 'home' },
                allowedNavigation: { changeHome: false, selectService: false, scanOrPasteHome: false, createPersonalHome: false },
                serviceCatalogState: {
                    kind: 'ready', authority, name: 'Home A',
                    methods: [serviceMethod(authority, 'github'), serviceMethod(authority, 'google')],
                },
                userHistory: 'returning',
            });

            expect(methodIds(model)).toEqual([
                'home:github:login',
                'home:key_challenge:login',
                'account_service:google:login',
            ]);
        });

        it('never dedupes across distinct server identities or distinct method/action/mode/execution', () => {
            const foreign = selfAuthority('identity-service-b');
            const model = composeWelcomeEntryModel({
                target: { kind: 'selected_home', home: target, label: 'Home A' },
                homeMethods: [method('github', 'login', 'keyless')],
                observedHomeServerIdentityId: 'identity-home-a',
                context: { kind: 'home' },
                allowedNavigation: { changeHome: false, selectService: false, scanOrPasteHome: false, createPersonalHome: false },
                serviceCatalogState: { kind: 'ready', authority: foreign, name: 'Service B', methods: [serviceMethod(foreign, 'github')] },
                userHistory: 'returning',
            });
            expect(methodIds(model)).toEqual(['home:github:login', 'account_service:github:login']);

            const self = selfAuthority('identity-home-a');
            const distinct = composeWelcomeEntryModel({
                target: { kind: 'selected_home', home: target, label: 'Home A' },
                homeMethods: [method('key_challenge', 'login', 'keyed'), method('github', 'provision', 'keyed')],
                observedHomeServerIdentityId: 'identity-home-a',
                context: { kind: 'home' },
                allowedNavigation: { changeHome: false, selectService: false, scanOrPasteHome: false, createPersonalHome: false },
                serviceCatalogState: {
                    kind: 'ready', authority: self, name: 'Home A',
                    methods: [
                        // Same method id but a provisioning action the Home does not offer for it.
                        serviceMethod(self, 'key_challenge', { kind: 'generated_key' }, 'provision', 'keyed'),
                        // Same provider id, different mode.
                        serviceMethod(self, 'github', { kind: 'oauth', providerId: 'github', mode: 'keyless' }, 'provision', 'keyless'),
                    ],
                },
                userHistory: 'returning',
            });
            expect(methodIds(distinct)).toEqual([
                'home:key_challenge:login',
                'account_service:key_challenge:provision',
                'account_service:github:provision',
                'home:github:provision',
            ]);
        });
    });
});
