import { describe, expect, it, vi } from 'vitest';

import {
    buildConnectedServiceCredentialRecord,
    type QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';

import {
    materializeFirstPartyConnectedAccountBearer,
    projectLegacyConnectedServiceBindingsToQualifiedPurposeBindings,
    resolveFirstPartyConnectedAccountBinding,
    resolveFirstPartyConnectedAccountServiceId,
} from './firstPartyConnectedAccountRequestAuthAdapter';

const codexService = {
    pluginId: 'happier.agent.codex',
    localId: 'openai-codex',
} as const;
const claudeService = {
    pluginId: 'happier.agent.claude',
    localId: 'claude-subscription',
} as const;
const geminiService = {
    pluginId: 'happier.agent.gemini',
    localId: 'gemini-account',
} as const;
const openAiService = {
    pluginId: 'happier.voice.openai',
    localId: 'openai',
} as const;
const anthropicService = {
    pluginId: 'happier.agent.claude',
    localId: 'anthropic',
} as const;
const purpose = {
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    purpose: 'openai-codex-model-request',
} as const;

describe('first-party Connected Account request-auth compatibility adapter', () => {
    it('derives all five released Agent launch identities from the generated compatibility owner', () => {
        expect(resolveFirstPartyConnectedAccountServiceId(codexService)).toBe('openai-codex');
        expect(resolveFirstPartyConnectedAccountServiceId(claudeService)).toBe('claude-subscription');
        expect(resolveFirstPartyConnectedAccountServiceId(geminiService)).toBe('gemini');
        expect(resolveFirstPartyConnectedAccountServiceId(openAiService)).toBe('openai');
        expect(resolveFirstPartyConnectedAccountServiceId(anthropicService)).toBe('anthropic');
        expect(resolveFirstPartyConnectedAccountServiceId({
            pluginId: 'happier.connected-accounts',
            localId: 'openai-codex',
        })).toBeNull();
        expect(resolveFirstPartyConnectedAccountServiceId({
            pluginId: 'happier.agent.codex',
            localId: 'openai',
        })).toBeNull();
        expect(resolveFirstPartyConnectedAccountServiceId({
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        })).toBeNull();
        expect(resolveFirstPartyConnectedAccountServiceId({
            pluginId: 'happier.scm.forge.bitbucket',
            localId: 'bitbucket-account',
        })).toBeNull();
    });

    it('projects released service-keyed Agent bindings one way into exact qualified purposes', () => {
        expect(projectLegacyConnectedServiceBindingsToQualifiedPurposeBindings({
            consumer: purpose.consumer,
            declarations: [{
                purpose: purpose.purpose,
                service: codexService,
            }, {
                purpose: 'anthropic-model-request',
                service: claudeService,
            }, {
                purpose: 'unsupported-model-request',
                service: {
                    pluginId: 'happier.agent.other',
                    localId: 'other',
                },
            }],
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'codex-profile',
                    },
                    'claude-subscription': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'claude-group',
                        // A legacy materialized member is not copied into the qualified group intent.
                        profileId: 'stale-member',
                    },
                    openai: { source: 'native' },
                },
            },
        })).toEqual([{
            purpose,
            target: {
                kind: 'account',
                account: {
                    service: codexService,
                    accountId: 'codex-profile',
                },
            },
        }, {
            purpose: {
                consumer: purpose.consumer,
                purpose: 'anthropic-model-request',
            },
            target: {
                kind: 'group',
                service: claudeService,
                groupId: 'claude-group',
            },
        }]);
    });

    it('normalizes a manifest-local service id against its declaring Agent plugin', () => {
        expect(projectLegacyConnectedServiceBindingsToQualifiedPurposeBindings({
            consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
            declarations: [{
                purpose: 'primary',
                service: 'openai-codex',
            }],
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'codex-profile',
                    },
                },
            },
        })).toEqual([{
            purpose: {
                consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                purpose: 'primary',
            },
            target: {
                kind: 'account',
                account: {
                    service: codexService,
                    accountId: 'codex-profile',
                },
            },
        }]);
    });

    it('does not synthesize qualified authority for native, missing, or unqualified legacy bindings', () => {
        expect(projectLegacyConnectedServiceBindingsToQualifiedPurposeBindings({
            consumer: purpose.consumer,
            declarations: [{
                purpose: purpose.purpose,
                service: codexService,
            }],
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': { source: 'native' },
                },
            },
        })).toEqual([]);
    });

    it('resolves fixed accounts and the current group member from the observed projection', () => {
        const projection = {
            groups: [{
                serviceId: 'openai-codex' as const,
                groupId: 'team',
                activeProfileId: 'member-b',
                generation: 7,
            }],
            resolveCredentialRevision: vi.fn((
                _serviceId: string,
                profileId: string,
            ) => profileId === 'member-b' ? 'csr_bbbbbbbbbbbbbbbbbbbbbb' : 'csr_aaaaaaaaaaaaaaaaaaaaaa'),
        };
        const fixed: QualifiedConnectedAccountPurposeBindingV1 = {
            purpose,
            target: {
                kind: 'account',
                account: { service: codexService, accountId: 'member-a' },
            },
        };
        const group: QualifiedConnectedAccountPurposeBindingV1 = {
            purpose,
            target: {
                kind: 'group',
                service: codexService,
                groupId: 'team',
            },
        };

        expect(resolveFirstPartyConnectedAccountBinding(fixed, projection)).toEqual({
            account: { service: codexService, accountId: 'member-a' },
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        });
        expect(resolveFirstPartyConnectedAccountBinding(group, projection)).toEqual({
            account: { service: codexService, accountId: 'member-b' },
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            group: { groupId: 'team', generation: 7 },
        });
    });

    it('returns only current OAuth access material and the authoritative Codex account header', async () => {
        const record = buildConnectedServiceCredentialRecord({
            serviceId: 'openai-codex',
            profileId: 'member-a',
            kind: 'oauth',
            now: 1_000,
            expiresAt: 2_000,
            oauth: {
                accessToken: 'access-secret',
                refreshToken: 'refresh-must-not-escape',
                idToken: 'id-must-not-escape',
                scope: 'openid',
                tokenType: 'Bearer',
                providerAccountId: 'acct_123',
                providerEmail: 'member@example.test',
            },
        });
        const resolveCredential = vi.fn(async () => ({
            record,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' as const,
            revisionSemantics: 'revisioned' as const,
        }));

        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved: {
                account: { service: codexService, accountId: 'member-a' },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://chatgpt.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
            transport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'openai-codex',
            },
            resolveCredential,
        })).resolves.toEqual({
            accessToken: 'access-secret',
            requiredHeaders: { 'chatgpt-account-id': 'acct_123' },
            expiresAt: 2_000,
        });
        expect(JSON.stringify(await materializeFirstPartyConnectedAccountBearer({
            resolved: {
                account: { service: codexService, accountId: 'member-a' },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://chatgpt.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
            transport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'openai-codex',
            },
            resolveCredential,
        }))).not.toContain('refresh-must-not-escape');
    });

    it('treats an omitted requested account identity as authoritative absence', async () => {
        const record = buildConnectedServiceCredentialRecord({
            serviceId: 'openai-codex',
            profileId: 'host-minted-account',
            kind: 'oauth',
            now: 1_000,
            expiresAt: null,
            oauth: {
                accessToken: 'rotated-access',
                refreshToken: 'rotated-refresh',
                idToken: 'rotated-id',
                scope: null,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved: {
                account: {
                    service: codexService,
                    accountId: 'host-minted-account',
                },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://chatgpt.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
            transport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'openai-codex',
            },
            resolveCredential: async () => ({
                record,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                revisionSemantics: 'revisioned',
            }),
        })).resolves.toEqual({
            accessToken: 'rotated-access',
        });
    });

    it('fails closed for a stale revision or non-OAuth credential', async () => {
        const tokenRecord = buildConnectedServiceCredentialRecord({
            serviceId: 'claude-subscription',
            profileId: 'member-a',
            kind: 'token',
            now: 1_000,
            token: {
                token: 'setup-token',
                providerAccountId: null,
                providerEmail: null,
            },
        });
        const resolved = {
            account: { service: claudeService, accountId: 'member-a' },
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        } as const;

        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved,
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.anthropic.com',
                headerNames: ['authorization'],
            },
            transport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'claude-subscription',
            },
            resolveCredential: async () => ({
                record: tokenRecord,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                revisionSemantics: 'revisioned',
            }),
        })).rejects.toThrow('request_auth_credential_superseded');
        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved,
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.anthropic.com',
                headerNames: ['authorization'],
            },
            transport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'claude-subscription',
            },
            resolveCredential: async () => ({
                record: tokenRecord,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                revisionSemantics: 'revisioned',
            }),
        })).rejects.toThrow('request_auth_oauth_bearer_required');
    });

    it('refuses the unfenced exact v0.2.1 compatibility peer', async () => {
        const resolveCredential = vi.fn();
        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved: {
                account: { service: codexService, accountId: 'member-a' },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://chatgpt.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
            transport: {
                kind: 'legacy',
                peerClass: 'exact_v0_2_1',
                serviceId: 'openai-codex',
            },
            resolveCredential,
        })).rejects.toThrow('request_auth_revision_fence_required');
        expect(resolveCredential).not.toHaveBeenCalled();
    });

    it('uses the advertised established runtime once and rejects stale or malformed results without legacy fallback', async () => {
        const resolveCredential = vi.fn();
        const invokeWithReceipt = vi.fn(async (): Promise<{
            result: {
                kind: 'httpHeaders';
                headers: Record<string, string>;
            };
            basis: {
                credentialRevision: string;
                isCurrent(): boolean;
            };
        }> => ({
            result: {
                kind: 'httpHeaders' as const,
                headers: {
                    Authorization: 'Bearer v4-access',
                    'ChatGPT-Account-Id': 'acct-v4',
                },
            },
            basis: {
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                isCurrent: () => true,
            },
        }));
        const base = {
            resolved: {
                account: { service: codexService, accountId: 'member-a' },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders' as const,
                origin: 'https://api.openai.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
            transport: { kind: 'v4' as const },
            establishedRuntimeOwner: { invokeWithReceipt },
            resolveCredential,
        };

        await expect(materializeFirstPartyConnectedAccountBearer(base)).resolves.toEqual({
            accessToken: 'v4-access',
            requiredHeaders: { 'chatgpt-account-id': 'acct-v4' },
        });
        expect(invokeWithReceipt).toHaveBeenCalledTimes(1);
        expect(invokeWithReceipt).toHaveBeenCalledWith({
            account: base.resolved.account,
            operation: {
                kind: 'materialize',
                request: base.materialization,
            },
        });
        expect(resolveCredential).not.toHaveBeenCalled();

        invokeWithReceipt.mockResolvedValueOnce({
            result: {
                kind: 'httpHeaders',
                headers: {
                    Authorization: 'Bearer stale-revision',
                },
            },
            basis: {
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                isCurrent: () => true,
            },
        });
        await expect(materializeFirstPartyConnectedAccountBearer(base))
            .rejects.toThrow('request_auth_credential_superseded');
        invokeWithReceipt.mockResolvedValueOnce({
            result: {
                kind: 'httpHeaders',
                headers: {
                    Authorization: 'Bearer stale-receipt',
                },
            },
            basis: {
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                isCurrent: () => false,
            },
        });
        await expect(materializeFirstPartyConnectedAccountBearer(base))
            .rejects.toThrow('request_auth_credential_superseded');
        expect(resolveCredential).not.toHaveBeenCalled();

        invokeWithReceipt.mockResolvedValueOnce({
            result: {
                kind: 'httpHeaders',
                headers: {
                    Authorization: 'Bearer v4-access',
                    authorization: 'Bearer duplicate',
                },
            },
            basis: {
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                isCurrent: () => true,
            },
        });
        await expect(materializeFirstPartyConnectedAccountBearer(base))
            .rejects.toThrow('request_auth_materialization_invalid');
        expect(resolveCredential).not.toHaveBeenCalled();

        invokeWithReceipt.mockResolvedValueOnce({
            result: {
                kind: 'httpHeaders',
                headers: {
                    Authorization: 'Bearer rotated-v4-access',
                },
            },
            basis: {
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                isCurrent: () => true,
            },
        });
        await expect(materializeFirstPartyConnectedAccountBearer(base)).resolves.toEqual({
            accessToken: 'rotated-v4-access',
        });
    });

    it('forwards request-auth cancellation to the established materializer and refuses pre-aborted legacy reads', async () => {
        const signal = new AbortController().signal;
        const invokeWithReceipt = vi.fn(async () => ({
            result: {
                kind: 'httpHeaders' as const,
                headers: { Authorization: 'Bearer v4-access' },
            },
            basis: {
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                isCurrent: () => true,
            },
        }));
        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved: {
                account: { service: codexService, accountId: 'member-a' },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.openai.com',
                headerNames: ['authorization'],
            },
            transport: { kind: 'v4' },
            signal,
            establishedRuntimeOwner: { invokeWithReceipt },
            resolveCredential: vi.fn(),
        })).resolves.toEqual({ accessToken: 'v4-access' });
        expect(invokeWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ signal }));

        const aborted = new AbortController();
        aborted.abort();
        const resolveCredential = vi.fn();
        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved: {
                account: { service: codexService, accountId: 'member-a' },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.openai.com',
                headerNames: ['authorization'],
            },
            transport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'openai-codex',
            },
            signal: aborted.signal,
            resolveCredential,
        })).rejects.toBeDefined();
        expect(resolveCredential).not.toHaveBeenCalled();
    });

    it.each([
        {
            headers: {
                authorization: 'Basic not-a-bearer',
                'chatgpt-account-id': 'acct',
            },
            error: 'request_auth_oauth_bearer_required',
        },
        {
            headers: {
                authorization: 'bearer wrong-casing',
            },
            error: 'request_auth_oauth_bearer_required',
        },
        {
            headers: {
                authorization: 'Bearer token',
                'chatgpt-account-id': 'acct',
                'x-unrequested': 'no',
            },
            error: 'request_auth_materialization_invalid',
        },
        {
            headers: {
                authorization: 'Bearer token\r\ninjected',
                'chatgpt-account-id': 'acct',
            },
            error: 'request_auth_materialization_invalid',
        },
    ])('rejects malformed advertised V4 HTTP-header materialization %#', async ({ headers, error }) => {
        await expect(materializeFirstPartyConnectedAccountBearer({
            resolved: {
                account: { service: codexService, accountId: 'member-a' },
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://api.openai.com',
                headerNames: ['authorization', 'chatgpt-account-id'],
            },
            transport: { kind: 'v4' },
            establishedRuntimeOwner: {
                invokeWithReceipt: vi.fn(async () => ({
                    result: { kind: 'httpHeaders', headers },
                    basis: {
                        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                        isCurrent: () => true,
                    },
                })),
            },
            resolveCredential: vi.fn(),
        })).rejects.toThrow(error);
    });
});
