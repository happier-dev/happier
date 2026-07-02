import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type DescriptorExports = Readonly<{
    CONNECTED_ACCOUNT_DESCRIPTORS?: ReadonlyArray<{
        id: string;
        aliases: readonly string[];
        connectModes: readonly unknown[];
        credentialKinds?: readonly string[];
        defaultCredentialKind?: string;
        oauth?: { refresh: { body: string }; authorization?: { scopes: readonly string[] } };
        tokenSetup?: {
            setupUrl?: string;
            permissions?: Readonly<Record<string, string>>;
            tokenKind?: string;
            credentialPayloadKind?: string;
            identity?: {
                kind: string;
                promptLabelKey: string;
                missingValueErrorKey: string;
            };
        };
        materialization?: { materializationKinds: readonly string[] };
    }>;
    ConnectedAccountDescriptorSchema?: {
        parse: (value: unknown) => unknown;
    };
    getConnectedAccountDescriptor?: (id: string) => {
        aliases: readonly string[];
        connectModes: readonly unknown[];
        credentialKinds?: readonly string[];
        defaultCredentialKind?: string;
        oauth?: { refresh: { body: string }; authorization?: { scopes: readonly string[] } };
        tokenSetup?: {
            setupUrl?: string;
            permissions?: Readonly<Record<string, string>>;
            tokenKind?: string;
            credentialPayloadKind?: string;
            identity?: {
                kind: string;
                promptLabelKey: string;
                missingValueErrorKey: string;
            };
        };
        materialization?: { materializationKinds: readonly string[] };
    } | null;
    requireConnectedAccountDescriptor?: (id: string) => unknown;
}>;

const descriptorExports = protocol as DescriptorExports;

describe('connectedAccountDescriptors', () => {
    it('validates built-in connected account descriptors with the shared descriptor base', () => {
        const parsed = descriptorExports.ConnectedAccountDescriptorSchema?.parse({
            id: 'openai-codex',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'connectedServices.serviceNames.openaiCodex',
            credentialKinds: ['oauth'],
            defaultCredentialKind: 'oauth',
            aliases: ['codex'],
            connectModes: [
                {
                    targetId: 'codex',
                    mode: 'oauth',
                    credentialKind: 'oauth',
                    default: true,
                },
            ],
            oauth: {
                publicClientId: {
                    envKey: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID',
                    defaultValue: 'public-client-id',
                },
                tokenUrl: {
                    envKey: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL',
                    defaultValue: 'https://auth.openai.com/oauth/token',
                },
                authorization: {
                    endpointUrl: 'https://auth.openai.com/oauth/authorize',
                    defaultRedirectUri: 'http://localhost:1455/auth/callback',
                    scopes: ['openid'],
                    query: {
                        responseType: 'code',
                        extraParams: {},
                    },
                    pkce: true,
                },
                refresh: {
                    body: 'form',
                    hookKey: 'standard-oauth-refresh',
                },
                payloadMapping: {
                    expiresAt: {
                        absoluteField: 'expires_at',
                        expiresInField: 'expires_in',
                    },
                    accessTokenField: 'access_token',
                    refreshTokenField: 'refresh_token',
                    idTokenField: 'id_token',
                    providerAccountIdField: 'account_id',
                },
            },
            ui: {
                connectCommand: 'happier connect codex',
                oauthAddActionModes: ['device', 'paste', 'browser'],
            },
        });

        expect(parsed).toMatchObject({
            kind: 'auth.connectedAccount',
            capabilityGates: [],
            redaction: 'none',
        });
    });

    it('registers GitHub as a token-only SCM hosting descriptor', () => {
        expect(descriptorExports.CONNECTED_ACCOUNT_DESCRIPTORS?.map((descriptor) => descriptor.id)).toEqual([
            'openai-codex',
            'openai',
            'anthropic',
            'claude-subscription',
            'gemini',
            'github',
        ]);
        expect(descriptorExports.getConnectedAccountDescriptor?.('openai-codex')?.aliases).toContain('codex');
        expect(descriptorExports.getConnectedAccountDescriptor?.('claude-subscription')?.connectModes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ targetId: 'claude', mode: 'setup-token', default: true }),
                expect.objectContaining({ targetId: 'claude', mode: 'oauth' }),
            ]),
        );
        expect(descriptorExports.getConnectedAccountDescriptor?.('claude-subscription')?.oauth?.authorization?.scopes).toEqual([
            'user:inference',
            'user:profile',
            'user:sessions:claude_code',
            'user:mcp_servers',
            'user:file_upload',
        ]);
        expect(descriptorExports.getConnectedAccountDescriptor?.('gemini')?.oauth?.refresh.body).toBe('form');

        const github = descriptorExports.getConnectedAccountDescriptor?.('github');
        expect(github).toMatchObject({
            aliases: ['github'],
            credentialKinds: ['token'],
            defaultCredentialKind: 'token',
            connectModes: [
                expect.objectContaining({
                    targetId: 'github',
                    mode: 'token',
                    credentialKind: 'token',
                    tokenKind: 'personal-access-token',
                    default: true,
                }),
            ],
            materialization: {
                materializationKinds: ['scm_hosting_token'],
            },
        });
        expect(github?.oauth).toBeUndefined();
        expect(github?.tokenSetup?.setupUrl).toContain('https://github.com/settings/personal-access-tokens/new?');
        expect(github?.tokenSetup?.setupUrl).toContain('contents=write');
        expect(github?.tokenSetup?.setupUrl).toContain('pull_requests=write');
        expect(github?.tokenSetup?.setupUrl).toContain('administration=write');
        expect(github?.tokenSetup?.permissions).toEqual({
            contents: 'write',
            pull_requests: 'write',
            administration: 'write',
        });

        expect(descriptorExports.getConnectedAccountDescriptor?.('bitbucket')).toBeNull();
    });

    it('exposes short brand names through the ui projection for compact surfaces', () => {
        const shortNamesById = Object.fromEntries(
            (descriptorExports.CONNECTED_ACCOUNT_DESCRIPTORS ?? []).map((descriptor) => [descriptor.id, descriptor.ui.shortName]),
        );
        expect(shortNamesById).toEqual({
            'openai-codex': 'Codex',
            openai: 'OpenAI',
            anthropic: 'Anthropic',
            'claude-subscription': 'Claude',
            gemini: 'Gemini',
            github: 'GitHub',
        });
    });

    it('rejects descriptor metadata that stores raw secret-shaped values', () => {
        expect(() => descriptorExports.ConnectedAccountDescriptorSchema?.parse({
            id: 'openai',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'connectedServices.serviceNames.openai',
            credentialKinds: ['token'],
            defaultCredentialKind: 'token',
            aliases: ['codex'],
            connectModes: [
                {
                    targetId: 'codex',
                    mode: 'api-key',
                    credentialKind: 'token',
                    default: false,
                    tokenKind: 'api-key',
                },
            ],
            tokenSetup: {
                tokenKind: 'api-key',
                promptLabelKey: 'connectedServices.tokenPrompts.openaiApiKey',
                missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingApiKey',
                accessToken: 'should-not-live-in-descriptor',
            },
            ui: {
                connectCommand: 'happier connect codex --api-key',
                oauthAddActionModes: [],
            },
        })).toThrow(/secret/i);
    });

    it('throws for unknown descriptor ids', () => {
        expect(() => descriptorExports.requireConnectedAccountDescriptor?.('missing')).toThrow(/Unsupported connected account/);
    });
});
