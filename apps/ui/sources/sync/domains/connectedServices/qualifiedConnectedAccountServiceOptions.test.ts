import { describe, expect, it } from 'vitest';

import type { ConnectedServicesProfileOption } from '@happier-dev/agents';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { connectedServiceProfileKey } from './connectedServiceProfilePreferences';
import { presentConnectedAccountIdentity } from './maskAccountEmail';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

import {
    applyProjectedCredentialKindRestrictions,
    buildQualifiedConnectedAccountProfileOptionsByServiceId,
    buildQualifiedConnectedAccountGroupOptionsByServiceId,
    resolveProjectedConnectedAccountServiceKeys,
} from './qualifiedConnectedAccountServiceOptions';

// Canonical qualified Connected Account service keys.
const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';
// Novel external plugin service: no bundled enum member and no generated
// legacy mapping — a bundled Agent author fact cannot exist for it.
const NOVEL_SERVICE_KEY = 'acme.review/reviewer-service';

it('projects the qualified Account pool label into choices without changing its definition', () => {
    const service = { pluginId: 'acme.review', localId: 'reviewer-service' };
    const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'primary' },
        displayName: 'Definition name', incarnation: 'primary:1', generation: 2, runtimeStateRevision: 3,
        policy: { quotaLimitSelection: { mode: 'selected', providerLimitIds: ['weekly'] } }, activeConnectedAccountId: null, state: {}, createdAt: 0, updatedAt: 0, members: [] });
    const input = { groups: [group], supportedServiceIds: [NOVEL_SERVICE_KEY],
        labelsByKey: { [connectedEntitySubjectKeyV1({ kind: 'group', ...group.ref })]: 'Personal name' } };
    expect(buildQualifiedConnectedAccountGroupOptionsByServiceId(input)[NOVEL_SERVICE_KEY]?.[0]?.label).toBe('Personal name');
    expect(buildQualifiedConnectedAccountGroupOptionsByServiceId({ ...input, labelsByKey: {} })[NOVEL_SERVICE_KEY]?.[0]?.label).toBe('Definition name');
    expect(group.displayName).toBe('Definition name');
    expect(buildQualifiedConnectedAccountGroupOptionsByServiceId(input)[NOVEL_SERVICE_KEY]?.[0]).toMatchObject({
        quotaLimitSelection: group.policy.quotaLimitSelection,
    });
});

describe('buildQualifiedConnectedAccountProfileOptionsByServiceId privacy', () => {
    it('keeps colliding account names distinct in the composer options using the list identity owner', () => {
        const service = { pluginId: 'acme.review', localId: 'reviewer-service' };
        const account = {
            ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
            configurationReady: true, configurationRevision: null, scopes: [],
            displayName: 'Leeroy Brun', providerIdentity: { email: 'work@example.com' },
        } satisfies QualifiedConnectedAccountProfileV4;
        const options = buildQualifiedConnectedAccountProfileOptionsByServiceId({
            accounts: [account, { ...account, ref: { service, accountId: 'personal' }, providerIdentity: { email: 'personal@example.com' } }],
            supportedServiceIds: [NOVEL_SERVICE_KEY], labelsByKey: {},
            presentIdentity: input => presentConnectedAccountIdentity({ ...input, hidden: false,
                label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null }),
        });
        expect(options[NOVEL_SERVICE_KEY]?.[0]).toMatchObject({ label: 'Leeroy Brun', providerEmail: 'work@example.com' });
        expect(options[NOVEL_SERVICE_KEY]?.[1]).toMatchObject({ label: 'Leeroy Brun', providerEmail: 'personal@example.com' });
    });

    it('uses the canonical user name before a provider display name and masks derived identities', () => {
        const service = { pluginId: 'acme.review', localId: 'reviewer-service' };
        const account = {
            ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
            configurationReady: true, configurationRevision: null, scopes: [],
            displayName: 'Provider workspace', providerIdentity: { email: 'work@example.com' },
        } satisfies QualifiedConnectedAccountProfileV4;
        const params = {
            accounts: [account, { ...account, ref: { service, accountId: 'backup' }, displayName: undefined, providerIdentity: { accountId: 'provider-account-42' } }],
            supportedServiceIds: [NOVEL_SERVICE_KEY],
            labelsByKey: { [connectedServiceProfileKey({ serviceId: NOVEL_SERVICE_KEY, profileId: 'work' })]: 'Work' },
        } satisfies Parameters<typeof buildQualifiedConnectedAccountProfileOptionsByServiceId>[0];
        const options = buildQualifiedConnectedAccountProfileOptionsByServiceId({
            ...params,
            presentIdentity: (input) => presentConnectedAccountIdentity({
                ...input, hidden: true, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
            }),
        });
        expect(options[NOVEL_SERVICE_KEY]).toEqual([
            expect.objectContaining({ profileId: 'work', label: 'Work', providerEmail: 'wo•••@e•••.com' }),
            // P8 label contract: missing identity is named for its service, never a generic service.
            expect.objectContaining({ profileId: 'backup', label: 'Reviewer Service account', providerEmail: null }),
        ]);
        // Agent actions and passive inventory consume raw structured facts, not device text:
        // a provider ID must not acquire the meaning of a saved user name there.
        expect(buildQualifiedConnectedAccountProfileOptionsByServiceId(params)[NOVEL_SERVICE_KEY]).toEqual([
            expect.objectContaining({ profileId: 'work', label: 'Work', providerEmail: 'work@example.com' }),
            expect.objectContaining({ profileId: 'backup', label: null, providerEmail: null }),
        ]);
    });

    it('names an account with neither a name nor an email after its service, never a generic service', () => {
        const service = { pluginId: 'acme.review', localId: 'reviewer-service' };
        const account = {
            ref: { service, accountId: 'backup' }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
            configurationReady: true, configurationRevision: null, scopes: [],
        } satisfies QualifiedConnectedAccountProfileV4;
        const options = buildQualifiedConnectedAccountProfileOptionsByServiceId({
            accounts: [account], supportedServiceIds: [NOVEL_SERVICE_KEY], labelsByKey: {},
            presentIdentity: (input) => presentConnectedAccountIdentity({
                ...input, hidden: false, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
            }),
            resolveServiceTitle: (serviceKey) => (serviceKey === NOVEL_SERVICE_KEY ? 'Reviewer' : serviceKey),
        });
        expect(options[NOVEL_SERVICE_KEY]?.[0]?.label).toBe('Reviewer account');
    });
});

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
    it('offers the credential kinds of every purpose using the same service regardless of declaration order', () => {
        const declarations = [
            ...CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE,
            { ...CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE[0], purpose: 'oauth', credentialKinds: ['oauth'] as const },
        ];
        const options = { [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: [
            profileOption({ profileId: 'max', kind: 'oauth' }),
            profileOption({ profileId: 'api', kind: 'token' }),
        ] };
        for (const connectedAccounts of [declarations, [...declarations].reverse()]) {
            expect(applyProjectedCredentialKindRestrictions({ optionsByServiceId: options, connectedAccounts })).toEqual(options);
        }
    });

    it('marks a bundled service option unsupported from its public purpose declaration', () => {
        const restricted = applyProjectedCredentialKindRestrictions({
            optionsByServiceId: {
                [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: [
                    profileOption({ profileId: 'max', kind: 'oauth' }),
                    profileOption({ profileId: 'api', kind: 'token' }),
                    profileOption({ profileId: 'unclassified', kind: null }),
                ],
            },
            connectedAccounts: CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE,
        });

        expect(restricted[CLAUDE_SUBSCRIPTION_SERVICE_KEY]).toEqual([
            expect.objectContaining({ profileId: 'max', status: 'unsupported_kind', kind: 'oauth' }),
            expect.objectContaining({ profileId: 'api', status: 'connected', kind: 'token' }),
            expect.objectContaining({ profileId: 'unclassified', status: 'connected', kind: null }),
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
                profileOption({ profileId: 'unclassified', kind: null }),
            ],
        } as const;

        expect(applyProjectedCredentialKindRestrictions({
            optionsByServiceId: options,
            connectedAccounts: [],
        })).toEqual(options);
        const unrestricted = { service: CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE[0].service };
        for (const connectedAccounts of [[...CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE, unrestricted],
            [unrestricted, ...CLAUDE_SUBSCRIPTION_TOKEN_ONLY_PURPOSE]]) {
            expect(applyProjectedCredentialKindRestrictions({ optionsByServiceId: options, connectedAccounts })).toEqual(options);
        }
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
