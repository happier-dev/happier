import { describe, expect, it } from 'vitest';

import type { AccountProfile } from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import {
    resolveConnectedServiceQuotaProfileRefForSession,
} from './resolveConnectedServiceQuotaProfileRefForSession';

const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
// Novel external plugin service: no bundled enum member, no generated legacy
// mapping, and therefore no released scalar quota identity.
const NOVEL_SERVICE_KEY = 'acme.review/reviewer-service';

function metadataWithBindings(params: Readonly<{
    agentId?: string;
    targetKey?: string;
    bindingsByServiceId: Record<string, unknown>;
}>): Metadata {
    const optionStateKey = params.targetKey ?? params.agentId;
    return {
        agentNewSessionOptionStateByAgentId: {
            ...(optionStateKey
                ? {
                    [optionStateKey]: {
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: params.bindingsByServiceId,
                        },
                    },
                }
                : {}),
        },
        connectedServices: {
            v: 1,
            bindingsByServiceId: params.bindingsByServiceId,
        },
    } as unknown as Metadata;
}

const CODEX_V2_SERVICE = {
    serviceId: 'openai-codex',
    profiles: [
        { profileId: 'work', status: 'connected', kind: null, providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null },
        { profileId: 'personal', status: 'connected', kind: null, providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null },
        { profileId: 'oncall', status: 'needs_reauth', kind: null, providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null },
    ],
    groups: [{
        groupId: 'pool-1',
        displayName: 'Codex pool',
        activeProfileId: 'oncall',
        generation: 2,
        memberProfileIds: ['work', 'oncall'],
    }],
} satisfies AccountProfile['connectedServicesV2'][number];

describe('resolveConnectedServiceQuotaProfileRefForSession', () => {
    it('resolves the session-bound profile from canonical qualified bindings', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            metadata: metadataWithBindings({
                bindingsByServiceId: {
                    [CODEX_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            }),
            agentId: 'codex',
            accountProfileConnectedServicesV2: [],
        })).toEqual({
            serviceKey: CODEX_SERVICE_KEY,
            legacyServiceId: 'openai-codex',
            profileId: 'work',
        });
    });

    it('translates released bundled persisted scalar keys at the named legacy ingress', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            metadata: metadataWithBindings({
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'personal',
                    },
                },
            }),
            agentId: 'codex',
            accountProfileConnectedServicesV2: [],
        })).toEqual({
            serviceKey: CODEX_SERVICE_KEY,
            legacyServiceId: 'openai-codex',
            profileId: 'personal',
        });
    });

    it('resolves a group binding to its active V2 member profile after canonical qualified resolution', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            metadata: metadataWithBindings({
                bindingsByServiceId: {
                    [CODEX_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'pool-1',
                    },
                },
            }),
            agentId: 'codex',
            accountProfileConnectedServicesV2: [CODEX_V2_SERVICE],
        })).toEqual({
            serviceKey: CODEX_SERVICE_KEY,
            legacyServiceId: 'openai-codex',
            // The group's persisted active member is in an explicit
            // needs_reauth, so the eligible member wins instead.
            profileId: 'work',
        });
    });

    it('derives supported services from the exact projected declarations when available', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            metadata: metadataWithBindings({
                bindingsByServiceId: {
                    [CODEX_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            }),
            agentId: 'codex',
            accountProfileConnectedServicesV2: [],
            connectedAccounts: [
                { purpose: 'model_upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
            ],
        })).toEqual({
            serviceKey: CODEX_SERVICE_KEY,
            legacyServiceId: 'openai-codex',
            profileId: 'work',
        });
    });

    it('fails closed for a novel external service with no released scalar quota identity', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            metadata: metadataWithBindings({
                bindingsByServiceId: {
                    [NOVEL_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'reviewer',
                    },
                },
            }),
            agentId: 'acme.review.agent',
            accountProfileConnectedServicesV2: [],
            connectedAccounts: [
                { purpose: 'primary', service: { pluginId: 'acme.review', localId: 'reviewer-service' } },
            ],
        })).toBeNull();
    });

    it('returns null when no supported service is bound to a connected profile', () => {
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            metadata: metadataWithBindings({
                bindingsByServiceId: {
                    [CODEX_SERVICE_KEY]: { source: 'native' },
                },
            }),
            agentId: 'codex',
            accountProfileConnectedServicesV2: [],
        })).toBeNull();
        expect(resolveConnectedServiceQuotaProfileRefForSession({
            metadata: null,
            agentId: 'codex',
            accountProfileConnectedServicesV2: [],
        })).toBeNull();
    });
});
