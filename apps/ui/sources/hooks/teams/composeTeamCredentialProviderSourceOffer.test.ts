import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema} from '@happier-dev/protocol/providers/ids';
import { ProviderConnectionSecurityFingerprintV1Schema } from '@happier-dev/protocol/providers/fingerprints';

import {
    composeTeamCredentialProviderSourceOffer,
    isTeamCredentialProviderSourceOfferCurrent,
} from './composeTeamCredentialProviderSourceOffer';
import type { TeamCredentialProviderSourceOfferV1 } from './useTeamCredentialProviderSourceOffers';

/** The daemon route witness carries branded Provider identities; fixtures parse them once. */
function providerOffer(input: Readonly<{
    machineId: string;
    serverId: string | null;
    machineDisplayName: string | null;
    connectionId: string;
    connectionSecurityFingerprint: string;
    credentialSlotId: string;
    label: string;
}>): TeamCredentialProviderSourceOfferV1 {
    return {
        ...input,
        connectionId: ProviderConnectionIdSchema.parse(input.connectionId),
        connectionSecurityFingerprint:
            ProviderConnectionSecurityFingerprintV1Schema.parse(input.connectionSecurityFingerprint),
    };
}

describe('composeTeamCredentialProviderSourceOffer', () => {
    it('projects only the exact content-free Provider source witness', () => {
        const result = composeTeamCredentialProviderSourceOffer([], [providerOffer({
            machineId: 'machine-work',
            serverId: 'server-home',
            machineDisplayName: 'Workstation',
            connectionId: 'pc-work',
            connectionSecurityFingerprint: 'connection-security:v1:current',
            credentialSlotId: 'apiKey',
            label: 'Work gateway',
        })]);
        expect(result).toEqual([{
            selectionId: '["provider-source-offer",1,"server-home","machine-work","pc-work","apiKey","connection-security:v1:current"]',
            candidate: {
                candidateId: '["provider_connection","pc-work","apiKey","connection-security:v1:current"]',
                source: {
                    v: 1,
                    kind: 'provider_connection',
                    connectionId: 'pc-work',
                    connectionSecurityFingerprint: 'connection-security:v1:current',
                    credentialSlotId: 'apiKey',
                },
                label: 'Work gateway',
                memberCount: null,
                directExportSupport: 'supported',
                offeredByResourceId: null,
            },
            providerSourceOffer: {
                machineId: 'machine-work',
                serverId: 'server-home',
                machineDisplayName: 'Workstation',
                connectionId: 'pc-work',
                connectionSecurityFingerprint: 'connection-security:v1:current',
                credentialSlotId: 'apiKey',
                label: 'Work gateway',
            },
        }]);
        expect(JSON.stringify(result)).not.toMatch(/secret|endpoint|header|configuration/i);
    });

    it('withdraws unavailable/revoked offers and does not duplicate daemon candidates', () => {
        expect(composeTeamCredentialProviderSourceOffer([], [])).toEqual([]);
        const offer = providerOffer({
            machineId: 'machine-work', serverId: 'server-home', machineDisplayName: 'Workstation',
            connectionId: 'pc-work',
            connectionSecurityFingerprint: 'connection-security:v1:current',
            credentialSlotId: 'apiKey',
            label: 'Work gateway',
        });
        const first = composeTeamCredentialProviderSourceOffer([], [offer]);
        const recomposed = composeTeamCredentialProviderSourceOffer([first[0]!.candidate], [offer]);
        expect(recomposed).toHaveLength(1);
        expect(recomposed[0]!.selectionId).toBe(first[0]!.selectionId);
    });

    it('projects every current Provider offer from the daemon-owned collection', () => {
        const offers = [providerOffer({
            machineId: 'machine-work', serverId: 'server-home', machineDisplayName: 'Workstation',
            connectionId: 'pc-work',
            connectionSecurityFingerprint: 'connection-security:v1:work',
            credentialSlotId: 'apiKey',
            label: 'Work gateway',
        }), providerOffer({
            machineId: 'machine-personal', serverId: 'server-home', machineDisplayName: 'Personal laptop',
            connectionId: 'pc-personal',
            connectionSecurityFingerprint: 'connection-security:v1:personal',
            credentialSlotId: 'token',
            label: 'Personal gateway',
        })] as const;

        const result = composeTeamCredentialProviderSourceOffer([], offers);

        expect(result.map((row) => row.candidate.label)).toEqual(['Work gateway', 'Personal gateway']);
        expect(result.every((row) => row.candidate.source.kind === 'provider_connection')).toBe(true);
    });

    it('keeps duplicate connection incarnations from different Machines as exact selectable routes', () => {
        const shared = {
            connectionId: 'pc-shared',
            connectionSecurityFingerprint: 'connection-security:v1:same',
            credentialSlotId: 'apiKey',
            label: 'Shared gateway',
        } as const;

        const result = composeTeamCredentialProviderSourceOffer([], [
            providerOffer({ ...shared, serverId: 'server-home', machineId: 'machine-a', machineDisplayName: 'Laptop' }),
            providerOffer({ ...shared, serverId: 'server-home', machineId: 'machine-b', machineDisplayName: 'Studio' }),
        ]);

        expect(result).toHaveLength(2);
        expect(new Set(result.map((row) => row.selectionId)).size).toBe(2);
        expect(result.map((row) => row.providerSourceOffer?.machineId)).toEqual(['machine-a', 'machine-b']);
    });

    it('accepts only the current exact Provider connection witness before create', () => {
        const offer = providerOffer({
            machineId: 'machine-work', serverId: 'server-home', machineDisplayName: 'Workstation',
            connectionId: 'pc-work',
            connectionSecurityFingerprint: 'connection-security:v1:current',
            credentialSlotId: 'apiKey',
            label: 'Work gateway',
        });
        const source = composeTeamCredentialProviderSourceOffer([], [offer])[0]!.candidate.source;
        if (source.kind !== 'provider_connection') throw new Error('expected Provider source');

        expect(isTeamCredentialProviderSourceOfferCurrent(offer, [offer])).toBe(true);
        expect(isTeamCredentialProviderSourceOfferCurrent(offer, [providerOffer({
            ...offer,
            connectionSecurityFingerprint: 'connection-security:v1:rotated',
        })])).toBe(false);
        expect(isTeamCredentialProviderSourceOfferCurrent(offer, [providerOffer({
            ...offer,
            credentialSlotId: 'otherSlot',
        })])).toBe(false);
        expect(isTeamCredentialProviderSourceOfferCurrent(offer, null)).toBe(false);
        expect(isTeamCredentialProviderSourceOfferCurrent(offer, [
            providerOffer({ ...offer, connectionSecurityFingerprint: 'connection-security:v1:rotated' }),
            offer,
        ])).toBe(true);
        expect(isTeamCredentialProviderSourceOfferCurrent(offer, [
            providerOffer({ ...offer, machineId: 'machine-other' }),
        ])).toBe(false);
        expect(isTeamCredentialProviderSourceOfferCurrent(offer, [
            providerOffer({ ...offer, serverId: 'server-other' }),
        ])).toBe(false);
    });
});
