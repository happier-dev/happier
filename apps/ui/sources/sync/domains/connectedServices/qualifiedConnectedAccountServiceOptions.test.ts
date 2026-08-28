import { describe, expect, it } from 'vitest';

import type { ConnectedServicesProfileOption } from '@happier-dev/agents';

import {
    applyAgentKindRestrictionsToQualifiedProfileOptions,
    resolveProjectedConnectedAccountServiceKeys,
} from './qualifiedConnectedAccountServiceOptions';

// Canonical qualified Connected Account service keys.
const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';
// Novel external plugin service: no bundled enum member and no generated
// legacy mapping — a bundled Agent author fact cannot exist for it.
const NOVEL_SERVICE_KEY = 'acme.review/reviewer-service';

/** Released bundled Agent fact shape (cf. opencode/ohMyPi: token-only subscription auth). */
const CLAUDE_SUBSCRIPTION_TOKEN_ONLY_CORE = {
    connectedServices: {
        supportedServiceIds: ['claude-subscription'],
        supportedKindsByServiceId: {
            'claude-subscription': ['token'],
        },
    },
} as const;

function profileOption(params: Readonly<{
    profileId: string;
    kind: 'oauth' | 'token' | null;
    status?: ConnectedServicesProfileOption['status'];
}>): ConnectedServicesProfileOption {
    return {
        profileId: params.profileId,
        status: params.status ?? 'connected',
        kind: params.kind,
        providerEmail: null,
        label: null,
    };
}

describe('applyAgentKindRestrictionsToQualifiedProfileOptions', () => {
    it('marks a bundled service option unsupported when the Agent core restricts its credential kind', () => {
        const restricted = applyAgentKindRestrictionsToQualifiedProfileOptions({
            optionsByServiceId: {
                [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: [
                    profileOption({ profileId: 'max', kind: 'oauth' }),
                    profileOption({ profileId: 'api', kind: 'token' }),
                ],
            },
            agentCore: CLAUDE_SUBSCRIPTION_TOKEN_ONLY_CORE,
        });

        expect(restricted[CLAUDE_SUBSCRIPTION_SERVICE_KEY]).toEqual([
            expect.objectContaining({ profileId: 'max', status: 'unsupported_kind', kind: 'oauth' }),
            expect.objectContaining({ profileId: 'api', status: 'connected', kind: 'token' }),
        ]);
    });

    it('resolves the bundled kind restriction without consulting the live projection registry', () => {
        // Deliberately no `installConnectedAccountDescriptorProjection` in this
        // suite: the released bundled kind fact is a generated catalog
        // compatibility fact, not a live registry entry, so a loading/retired
        // registry snapshot must never silently drop the restriction.
        const restricted = applyAgentKindRestrictionsToQualifiedProfileOptions({
            optionsByServiceId: {
                [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: [
                    profileOption({ profileId: 'max', kind: 'oauth' }),
                ],
            },
            agentCore: CLAUDE_SUBSCRIPTION_TOKEN_ONLY_CORE,
        });

        expect(restricted[CLAUDE_SUBSCRIPTION_SERVICE_KEY]?.[0]?.status).toBe('unsupported_kind');
    });

    it('keeps a novel external service option unrestricted while the same Agent core restricts bundled kinds', () => {
        const options = {
            [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: [
                profileOption({ profileId: 'max', kind: 'oauth' }),
            ],
            [NOVEL_SERVICE_KEY]: [
                profileOption({ profileId: 'reviewer', kind: 'oauth' }),
            ],
        } as const;

        const restricted = applyAgentKindRestrictionsToQualifiedProfileOptions({
            optionsByServiceId: options,
            agentCore: CLAUDE_SUBSCRIPTION_TOKEN_ONLY_CORE,
        });

        expect(restricted[CLAUDE_SUBSCRIPTION_SERVICE_KEY]?.[0]?.status).toBe('unsupported_kind');
        expect(restricted[NOVEL_SERVICE_KEY]).toEqual(options[NOVEL_SERVICE_KEY]);
    });

    it('leaves every option unrestricted when the Agent core declares no kind restriction', () => {
        const options = {
            [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: [
                profileOption({ profileId: 'max', kind: 'oauth' }),
            ],
        } as const;

        expect(applyAgentKindRestrictionsToQualifiedProfileOptions({
            optionsByServiceId: options,
            agentCore: null,
        })).toEqual(options);
    });
});

describe('resolveProjectedConnectedAccountServiceKeys', () => {
    it('builds deduped canonical qualified keys from exact declarations', () => {
        expect(resolveProjectedConnectedAccountServiceKeys([
            { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } },
            { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } },
            { service: { pluginId: 'acme.review', localId: 'reviewer-service' } },
        ])).toEqual([
            'happier.agent.claude/anthropic',
            'acme.review/reviewer-service',
        ]);
    });
});
