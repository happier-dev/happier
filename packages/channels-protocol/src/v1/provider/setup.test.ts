import { describe, expect, it } from 'vitest';
import { ConversationProviderDescriptorV1Schema } from './descriptor.js';

import {
    ConversationProviderSetupOutcomeV1Schema,
    ConversationProviderSetupRemediationResultV1Schema,
    ConversationProviderSetupResultV1Schema,
    ConversationProviderSetupGuidanceV1ProtocolSchema,
} from './setup.js';

describe('Channels V1 provider setup outcomes', () => {
    it('reads ordered provider-authored setup steps and derives the same strict manifest shape', () => {
        const guidance = {
            externalUrl: 'https://provider.example.test/install',
            requiredPermissionsLabel: 'Read messages',
            steps: [
                { title: 'Create an application', externalUrl: 'https://provider.example.test/apps' },
                { title: 'Configure its scope', copyableValues: [{ label: 'Scope', value: 'messages:read' }] },
                { title: 'Store the credential in Connected Accounts' },
            ],
        };
        expect(ConversationProviderSetupGuidanceV1ProtocolSchema.parse(guidance)).toEqual(guidance);
        expect(ConversationProviderDescriptorV1Schema.parse({ v: 1, displayName: 'Provider', setupGuidance: guidance }))
            .toEqual({ v: 1, displayName: 'Provider', setupGuidance: guidance });
        for (const step of [
            { title: '' },
            { title: 'Open setup', externalUrl: 'javascript:alert(1)' },
            { title: 'Open setup', token: 'undeclared' },
            { title: 'Configure', copyableValues: [{ label: 'Scope', value: 'read', secret: true }] },
        ]) {
            expect(ConversationProviderSetupGuidanceV1ProtocolSchema.safeParse({ ...guidance, steps: [step] }).success).toBe(false);
            expect(ConversationProviderDescriptorV1Schema.safeParse({ v: 1, displayName: 'Provider',
                setupGuidance: { ...guidance, steps: [step] } }).success).toBe(false);
        }
        expect(ConversationProviderSetupGuidanceV1ProtocolSchema.jsonSchema).toMatchObject({
            additionalProperties: false,
            properties: { steps: { type: 'array', items: {
                additionalProperties: false,
                required: ['title'],
                properties: { copyableValues: { items: { additionalProperties: false } } },
            } } },
        });
    });

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
            setupGuidance: {
                externalUrl: 'https://provider.example.test/install',
                requiredPermissionsLabel: 'Read messages, Send messages',
            },
            webhookContributionRef: { pluginId: 'happier.channel.example', localId: 'webhook' },
        } as const;

        expect(ConversationProviderSetupResultV1Schema.parse(durablePush)).toEqual(durablePush);
        const longFreshness = { ...durablePush, };
        expect(ConversationProviderSetupResultV1Schema.parse(longFreshness)).toEqual(longFreshness);
        const { outboundTextLimit: _nativeLimit, ...unlimited } = durablePush;
        expect(ConversationProviderSetupResultV1Schema.parse(unlimited)).toEqual(unlimited);
        for (const outboundTextLimit of [
            null,
            { maximum: 0, unit: 'unicodeCodePoints' },
            { maximum: 1.5, unit: 'unicodeCodePoints' },
            { maximum: 4_000, unit: 'unknown' },
            { maximum: 4_000, unit: 'unicodeCodePoints', formatting: 'mayExpand' },
        ]) {
            expect(ConversationProviderSetupResultV1Schema.safeParse({ ...unlimited, outboundTextLimit }).success).toBe(false);
        }
        expect(ConversationProviderSetupResultV1Schema.parse({ ...durablePush,
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' },
        })).toMatchObject({ outboundTextLimit: { formatting: 'preservesNativeUnits' } });
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            supportedTransports: ['checkpointedPull'],
        }).success).toBe(true);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            overlapSafety: 'providerExclusive',
        }).success).toBe(true);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            overlapSafety: 'destructive',
        }).success).toBe(false);
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
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            setupGuidance: {
                externalUrl: 'javascript:alert(1)',
                requiredPermissionsLabel: 'Read messages',
            },
        }).success).toBe(false);
        expect(ConversationProviderSetupResultV1Schema.safeParse({
            ...durablePush,
            setupGuidance: {
                externalUrl: 'https://provider.example.test/install',
                requiredPermissionsLabel: '',
            },
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
