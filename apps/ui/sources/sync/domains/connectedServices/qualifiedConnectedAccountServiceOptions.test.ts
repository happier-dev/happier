import { describe, expect, it } from 'vitest';

import type { ConnectedServicesProfileOption } from '@happier-dev/agents';

import {
    applyProjectedCredentialKindRestrictions,
    resolveProjectedConnectedAccountServiceKeys,
} from './qualifiedConnectedAccountServiceOptions';

// Canonical qualified Connected Account service keys.
const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';
// Novel external plugin service: no bundled enum member and no generated
// legacy mapping — a bundled Agent author fact cannot exist for it.
const NOVEL_SERVICE_KEY = 'acme.review/reviewer-service';

const CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE = [{
    purpose: 'primary',
    service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
    credentialKinds: ['token'],
}] as const;

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

describe('applyProjectedCredentialKindRestrictions', () => {
    it('marks a bundled service option unsupported from its public purpose declaration', () => {
        const restricted = applyProjectedCredentialKindRestrictions({
            optionsByServiceId: {
                [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: [
                    profileOption({ profileId: 'max', kind: 'oauth' }),
                    profileOption({ profileId: 'api', kind: 'token' }),
                ],
            },
            connectedAccounts: CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE,
        });

        expect(restricted[CLAUDE_SUBSCRIPTION_SERVICE_KEY]).toEqual([
            expect.objectContaining({ profileId: 'max', status: 'unsupported_kind', kind: 'oauth' }),
            expect.objectContaining({ profileId: 'api', status: 'connected', kind: 'token' }),
        ]);
    });

    it('applies the same restriction to a novel external purpose declaration', () => {
        const restricted = applyProjectedCredentialKindRestrictions({
            optionsByServiceId: {
                [NOVEL_SERVICE_KEY]: [
                    profileOption({ profileId: 'reviewer', kind: 'oauth' }),
                ],
            },
            connectedAccounts: [{
                purpose: 'primary',
                service: { pluginId: 'acme.review', localId: 'reviewer-service' },
                credentialKinds: ['token'],
            }],
        });

        expect(restricted[NOVEL_SERVICE_KEY]?.[0]?.status).toBe('unsupported_kind');
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

        const restricted = applyProjectedCredentialKindRestrictions({
            optionsByServiceId: options,
            connectedAccounts: CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE,
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

        expect(applyProjectedCredentialKindRestrictions({
            optionsByServiceId: options,
            connectedAccounts: [],
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
