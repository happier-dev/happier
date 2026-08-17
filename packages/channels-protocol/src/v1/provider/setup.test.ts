import { describe, expect, it } from 'vitest';

import {
    ConversationProviderSetupOutcomeV1Schema,
    ConversationProviderSetupRemediationResultV1Schema,
    ConversationProviderSetupResultV1Schema,
} from './setup.js';

describe('Channels V1 provider setup outcomes', () => {
    it('keeps setup facts structural while setup admission owns durable transport compatibility', () => {
        const durablePush = {
            v: 1,
            credentialRef: {
                service: { pluginId: 'happier.channel.example', localId: 'account' },
                accountId: 'account-1',
            },
            providerConnectionKey: 'provider:account-1',
            providerConfigVersion: 1,
            providerConfig: { installation: 'installation-1' },
            integrationPrincipal: { id: 'integration-1', label: 'Example integration' },
            supportedTransports: ['checkpointedPull', 'durablePush'],
            recommendedTransport: 'checkpointedPull',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            webhookContributionRef: { pluginId: 'happier.channel.example', localId: 'webhook' },
        } as const;

        expect(ConversationProviderSetupResultV1Schema.parse(durablePush)).toEqual(durablePush);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            supportedTransports: ['checkpointedPull'],
        }).success).toBe(true);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            overlapSafety: 'destructive',
        }).success).toBe(true);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            webhookEndpointSetup: { kind: 'legacy-owner' },
        }).success).toBe(false);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            credentialRef: { service: 'not canonical', accountId: 'account-1' },
        }).success).toBe(false);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            supportedTransports: ['checkpointedPull', 'checkpointedPull'],
        }).success).toBe(false);
        expect(ConversationProviderSetupResultV1Schema.jsonSchema).toMatchObject({
            properties: {
                supportedTransports: { uniqueItems: true },
            },
        });
    });

    it('keeps a remediation result separate from setup identity and transport facts', () => {
        const remediation = {
            kind: 'requiresRemediation',
        } as const;

        expect(ConversationProviderSetupOutcomeV1Schema.parse(remediation)).toEqual(remediation);
        expect(ConversationProviderSetupOutcomeV1Schema.safeParse({
            ...remediation,
            providerConnectionKey: 'must not be emitted before setup succeeds',
        }).success).toBe(false);
        expect(ConversationProviderSetupOutcomeV1Schema.safeParse({
            kind: 'requiresRemediation',
            remediation: 'providerDefined',
        }).success).toBe(false);
    });

    it('keeps a provider-neutral remediation mutation outcome explicit', () => {
        expect(ConversationProviderSetupRemediationResultV1Schema.parse({
            kind: 'remediated',
        })).toEqual({ kind: 'remediated' });
        expect(ConversationProviderSetupRemediationResultV1Schema.parse({
            kind: 'outcomeUnknown',
        })).toEqual({ kind: 'outcomeUnknown' });
        expect(ConversationProviderSetupRemediationResultV1Schema.safeParse({
            kind: 'remediated',
            provider: 'telegram',
        }).success).toBe(false);
    });
});
