import { describe, expect, it } from 'vitest';

import {
    ConversationTransportFactReportInputV1Schema,
    ConversationTransportFactReportResultV1Schema,
} from './transportFacts.js';

describe('Channels V1 transport fact reports', () => {
    it('admits only host-authorized history, readiness, and stop facts through a closed projection', () => {
        const providerHistoryGap = {
            connectionId: 'connection-1',
            authorityEpoch: 2,
            fact: {
                kind: 'historyGap',
                reason: 'providerHistoryUnavailable',
                diagnostic: 'The upstream retained history no longer includes the current checkpoint.',
            },
        } as const;
        const applicationAdmissionLoss = {
            connectionId: 'connection-1',
            authorityEpoch: 2,
            fact: {
                kind: 'historyGap',
                reason: 'applicationAdmissionLost',
            },
        } as const;
        const stopConfirmed = {
            connectionId: 'connection-1',
            authorityEpoch: 2,
            fact: {
                kind: 'stopConfirmed',
                reason: 'notRunningOnReconcile',
            },
        } as const;
        const providerPermissionMissing = {
            connectionId: 'connection-1',
            authorityEpoch: 2,
            fact: {
                kind: 'providerReadiness',
                status: 'attention',
                code: 'providerPermissionMissing',
                diagnostic: 'The provider requires a permission that must be enabled remotely.',
            },
        } as const;
        const providerConfigurationInvalid = {
            connectionId: 'connection-1',
            authorityEpoch: 2,
            fact: {
                kind: 'providerReadiness',
                status: 'attention',
                code: 'providerConfigurationInvalid',
            },
        } as const;
        const providerReady = {
            connectionId: 'connection-1',
            authorityEpoch: 2,
            fact: {
                kind: 'providerReadiness',
                status: 'ready',
            },
        } as const;
        for (const valid of [
            providerHistoryGap,
            applicationAdmissionLoss,
            stopConfirmed,
            providerPermissionMissing,
            providerConfigurationInvalid,
            providerReady,
        ]) {
            expect(ConversationTransportFactReportInputV1Schema.parse(valid)).toEqual(valid);
        }
        expect(ConversationTransportFactReportInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['connectionId', 'authorityEpoch', 'fact'],
            properties: { fact: { anyOf: expect.any(Array) } },
        });

        const malformed = [
            {
                ...applicationAdmissionLoss,
                fact: {
                    ...applicationAdmissionLoss.fact,
                    diagnostic: 'application faults must not disclose provider diagnostics',
                },
            },
            {
                ...stopConfirmed,
                fact: {
                    ...stopConfirmed.fact,
                    diagnostic: 'stop confirmation is not a history fact',
                },
            },
            {
                ...providerHistoryGap,
                authorityEpoch: 0,
            },
            {
                ...providerHistoryGap,
                providerPluginId: 'untrusted-caller-authority',
            },
            {
                ...providerHistoryGap,
                fact: {
                    kind: 'historyGap',
                    reason: 'providerSessionExpired',
                },
            },
            {
                ...providerPermissionMissing,
                fact: {
                    kind: 'providerReadiness',
                    status: 'attention',
                    code: 'discordMessageContentMissing',
                },
            },
            {
                ...providerReady,
                fact: {
                    kind: 'providerReadiness',
                    status: 'ready',
                    diagnostic: 'a ready report cannot carry provider detail',
                },
            },
        ] as const;

        for (const invalid of malformed) {
            expect(ConversationTransportFactReportInputV1Schema.safeParse(invalid).success).toBe(false);
        }
    });

    it('keeps the core result vocabulary closed in its emitted projection', () => {
        const valid = { kind: 'rejoined' } as const;

        expect(ConversationTransportFactReportResultV1Schema.parse(valid)).toEqual(valid);
        expect(ConversationTransportFactReportResultV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
        });

        for (const invalid of [
            { kind: 'recorded', authorityEpoch: 2 },
            { kind: 'retrying' },
        ] as const) {
            expect(ConversationTransportFactReportResultV1Schema.safeParse(invalid).success).toBe(false);
        }
    });
});
