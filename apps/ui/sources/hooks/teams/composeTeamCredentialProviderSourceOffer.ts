import {
    TeamCredentialSourceBindingV1Schema,
    TeamCredentialSourceCandidateV1Schema,
    teamCredentialSourceCandidateIdV1,
    type TeamCredentialSourceCandidateV1,
} from '@happier-dev/protocol/teams';
import { projectProviderRequestAuthBrokerPurposes } from '@happier-dev/protocol/providers/catalog/brokerApplicationProjectionV1';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';

import type { TeamCredentialProviderSourceOfferV1 } from './useTeamCredentialProviderSourceOffers';

export type TeamCredentialSourceCandidatePresentationV1 = Readonly<{
    /** Collision-safe transient identity for the exact selectable UI row. */
    selectionId: string;
    candidate: TeamCredentialSourceCandidateV1;
    /** Exact daemon route witness; never written into the Protocol source binding. */
    providerSourceOffer: TeamCredentialProviderSourceOfferV1 | null;
    providerPurposeLabel?: string;
}>;

const accountProviderPurposes = readAccountProviderDeclarations({ kind: 'account' }).flatMap(declaration => {
    const provider = parseProviderContributionIdentityV1(declaration.contributionKey);
    if (!provider) return [];
    return projectProviderRequestAuthBrokerPurposes({ definition: declaration.definition, identity: provider.identity })
        .map(family => ({
            serviceKey: buildQualifiedPluginContributionKey(family.service),
            purpose: { consumer: provider.identity, purpose: family.purpose },
            label: family.title?.fallback ?? declaration.definition.name,
        }));
});

function providerOfferSelectionId(offer: TeamCredentialProviderSourceOfferV1): string {
    return JSON.stringify([
        'provider-source-offer', 1, offer.serverId, offer.machineId,
        offer.connectionId, offer.credentialSlotId, offer.connectionSecurityFingerprint,
    ]);
}

function homeCandidateSelectionId(candidate: TeamCredentialSourceCandidateV1): string {
    return JSON.stringify(['home-source-candidate', 1, candidate.candidateId]);
}

export function isTeamCredentialProviderSourceOfferCurrent(
    selected: TeamCredentialProviderSourceOfferV1,
    offers: readonly TeamCredentialProviderSourceOfferV1[] | null,
): boolean {
    return offers?.some((offer) => (
        offer.serverId === selected.serverId
        && offer.machineId === selected.machineId
        && offer.connectionId === selected.connectionId
        && offer.connectionSecurityFingerprint === selected.connectionSecurityFingerprint
        && offer.credentialSlotId === selected.credentialSlotId
    )) === true;
}

/**
 * Composes the creator's daemon-owned Provider witness into the Home-owned
 * Account/Pool answer. The daemon is the only reader of Plain or E2EE Provider
 * Settings; this adapter only wraps its strict content-free witness in the
 * existing source-candidate contract.
 */
export function composeTeamCredentialProviderSourceOffer(
    candidates: readonly TeamCredentialSourceCandidateV1[],
    offers: readonly TeamCredentialProviderSourceOfferV1[],
): readonly TeamCredentialSourceCandidatePresentationV1[] {
    const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const offeredCandidateIds = new Set<string>();
    const providerRows = offers.map((offer) => {
        const source = TeamCredentialSourceBindingV1Schema.parse({
            v: 1,
            kind: 'provider_connection',
            connectionId: offer.connectionId,
            connectionSecurityFingerprint: offer.connectionSecurityFingerprint,
            credentialSlotId: offer.credentialSlotId,
        });
        const candidateId = teamCredentialSourceCandidateIdV1(source);
        offeredCandidateIds.add(candidateId);
        const candidate = candidateById.get(candidateId) ?? TeamCredentialSourceCandidateV1Schema.parse({
            source,
            candidateId,
            label: offer.label,
            memberCount: null,
            directExportSupport: 'supported',
            offeredByResourceId: null,
        });
        return Object.freeze({
            selectionId: providerOfferSelectionId(offer),
            candidate,
            providerSourceOffer: offer,
        });
    });
    const homeRows = candidates
        .filter((candidate) => candidate.source.kind !== 'provider_connection'
            && !offeredCandidateIds.has(candidate.candidateId))
        .flatMap((candidate) => {
            const selectionId = homeCandidateSelectionId(candidate);
            const homeRow = { selectionId, candidate, providerSourceOffer: null };
            if (candidate.source.kind !== 'connected_account' || candidate.source.providerPurpose) return [homeRow];
            const source = candidate.source;
            const serviceKey = buildQualifiedPluginContributionKey(source.target.account.service);
            const qualifiedRows = accountProviderPurposes.filter(family => family.serviceKey === serviceKey).map(family => ({
                selectionId: JSON.stringify([selectionId, family.purpose]),
                candidate: { ...candidate, source: { ...source, providerPurpose: family.purpose } },
                providerSourceOffer: null,
                providerPurposeLabel: family.label,
            }));
            return [...qualifiedRows, homeRow];
        }).map(row => Object.freeze(row));
    return Object.freeze([...homeRows, ...providerRows]);
}
