import { createElement } from 'react';
import { teamCredentialCatalogStatusLabel } from '@/components/settings/teams/credentials/catalogStatusPresentation';
import type { TeamCredentialResourceStatus } from '@/sync/domains/teams/teamCredentialResourceStatus';
import type { TeamCredentialProviderModelSelectionV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import type { ProviderErrorCodeV1 } from '@happier-dev/protocol/providers/errors';
import { resolveProviderModelCapabilityCompatibilityV1 } from '@happier-dev/protocol/providers/binding-compatibility';

import { t } from '@/text';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { resolveAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';
import { deliveryModeLabel as teamCredentialDeliveryLabel } from '@/sync/domains/teams/teamCredentialDeliveryPresentation';
export { teamCredentialDeliveryLabel };
import { resourceShortUnavailableLabel, resourceStateLabel } from '@/components/settings/teams/credentials/readinessPresentation';
import { teamCredentialCatalogConfidenceLabel } from '@/components/settings/teams/credentials/catalogConfidencePresentation';
import { describeDirectDeliveryVisibility, readDirectDeliveryVisibility } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import { formatLimitResetUtc, limitMetricLabel, sourceKindLabel, teamCredentialRecoveryLabel, teamCredentialRecoveryPresentation } from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { StatusPill } from '@/components/ui/status/StatusPill';
import type { buildSessionModelPickerSections, SessionModelPickerOption, SessionModelPickerSection } from './buildSessionModelPickerSections';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

function teamCredentialDeliveryUnavailableReason(reason: ProviderErrorCodeV1, deliveryMode?: TeamCredentialProviderModelSelectionV1['deliveryMode'], short = false): string {
    if (short) return t(presentProviderError(reason).titleKey);
    if (deliveryMode === 'vendor-native' && reason === 'provider_credential_transport_unavailable') {
        return t('teams.credentials.errors.nativeDeliveryUnavailable');
    }
    return t(presentProviderError(reason).descriptionKey);
}

export function teamCredentialUnavailableReason(
    resource: TeamCredentialResourceCatalogEntryV1,
    deliveryMode?: TeamCredentialProviderModelSelectionV1['deliveryMode'],
    short = false,
): string | null {
    if (resource.deliveryUnavailableReason) {
        const unavailableMode = deliveryMode ?? (resource.allowedRoutes?.includes('vendor-native') ? 'vendor-native' : undefined);
        return teamCredentialDeliveryUnavailableReason(resource.deliveryUnavailableReason, unavailableMode, short);
    }
    const readiness = deliveryMode ? readTeamCredentialDeliveryReadinessV1(resource.readiness, deliveryMode) : resource.readiness;
    if (short) return readiness.kind === 'available' ? null : resourceShortUnavailableLabel(readiness);
    switch (readiness.kind) {
        case 'available': return null;
        case 'broker_unavailable': return t('teams.credentials.errors.brokerUnavailable');
        case 'source_unavailable': return resourceStateLabel(readiness);
        case 'update_required': return t('teams.unavailable.updateRequired');
        case 'policy_denied': return t('teams.credentials.forbidden');
        case 'limit_reached': return [
            t('teams.credentials.limits.reached'), limitMetricLabel(readiness.metric), formatLimitResetUtc(readiness.resetsAtUtc),
        ].filter((part): part is string => Boolean(part)).join(' · ');
        case 'resource_corrupt': return resourceStateLabel(readiness);
        case 'resource_unavailable': return t('teams.credentials.detail.notFound');
    }
}

function teamCredentialModelUnavailableReason(
    resource: TeamCredentialResourceCatalogEntryV1,
    row: TeamCredentialResourceCatalogEntryV1['providerModels'][number],
    short = false,
): string | null {
    if (row.deliveryUnavailableReason) return teamCredentialDeliveryUnavailableReason(row.deliveryUnavailableReason, row.selection.deliveryMode, short);
    switch (row.availability) {
        case 'available': return teamCredentialUnavailableReason(resource, row.selection.deliveryMode, short);
        case 'source_owner_required': return t(short ? 'teams.credentials.unavailableShort.askOwner' : 'teams.credentials.errors.sourceOwnerRequired');
        case 'resource_corrupt': return short ? resourceShortUnavailableLabel({ kind: 'resource_corrupt' }) : resourceStateLabel({ kind: 'resource_corrupt' });
        case 'policy_denied': return short ? resourceShortUnavailableLabel({ kind: 'policy_denied' }) : t('teams.credentials.forbidden');
    }
}

/** Read the worker's refusal, including failures that could not produce compatibility. */
function isTeamCredentialModelIncompatible(row: TeamCredentialResourceCatalogEntryV1['providerModels'][number]): boolean {
    return row.compatibility?.result.status === 'incompatible'
        || row.deliveryUnavailableReason === 'provider_incompatible_with_agent';
}

/** Share exact-Agent admission between offered rows and retained-selection recovery. */
export function createTeamCredentialModelEligibility(
    input: Pick<Parameters<typeof buildSessionModelPickerSections>[0], 'agentTargetKey' | 'declarationContext'>,
): (row: TeamCredentialResourceCatalogEntryV1['providerModels'][number] | null) => boolean {
    const requirements = resolveAccountAgentProviderRequirements(input.agentTargetKey, input.declarationContext);
    return row => requirements.kind === 'known' && (!row || (
        row.selection.agentTargetKey === input.agentTargetKey
        && !isTeamCredentialModelIncompatible(row)
        && !resolveProviderModelCapabilityCompatibilityV1({
            required: requirements.requirements.required, model: row.descriptor,
        }).incompatible
    ));
}

/**
 * A shared credential's name in a picker. Its label is private and may not be readable here; then it is named by
 * what it shares ("Connected account"), never by the word "Unavailable", which would read as its state.
 */
export function presentTeamCredentialPickerName(
    resource: Pick<TeamCredentialResourceCatalogEntryV1, 'id' | 'sourcePresentation'>,
    displayNames: Readonly<Record<string, string | null>> | undefined,
): string {
    return displayNames?.[resource.id]?.trim()
        || (resource.sourcePresentation ? sourceKindLabel(resource.sourcePresentation) : t('teams.credentials.title'));
}

export function buildTeamCredentialModelPickerSections(
    input: Parameters<typeof buildSessionModelPickerSections>[0],
    modelEligible = createTeamCredentialModelEligibility(input),
): SessionModelPickerSection[] {
    if (!input.teamCredentialResources?.length) return [];
    return input.teamCredentialResources.flatMap((resource): SessionModelPickerSection[] => {
        // Filtering every model must not create a generic refusal placeholder for another Agent.
        const displayName = presentTeamCredentialPickerName(resource, input.teamCredentialDisplayNames);
        const eligibleModels = resource.providerModels.filter(modelEligible);
        if (resource.providerModels.length > 0 && eligibleModels.length === 0) return [];
        const options = eligibleModels.flatMap((row): SessionModelPickerOption[] => {
            const status: TeamCredentialResourceStatus = input.teamCredentialResourceStatusByKey?.get(`${resource.teamId}:${resource.id}`)
                ?? { kind: input.teamCredentialResourceStatusByKey ? 'pending' : 'current' };
            const current = status.kind === 'current';
            const available = current
                && readTeamCredentialDeliveryReadinessV1(resource.readiness, row.selection.deliveryMode).kind === 'available'
                && row.availability === 'available';
            const delivery = teamCredentialDeliveryLabel(row.selection.deliveryMode);
            const confidence = teamCredentialCatalogConfidenceLabel(row);
            const experimental = row.compatibility?.result.status === 'experimental'
                ? t('settingsProviders.models.experimental') : null;
            const directDisclosure = row.selection.deliveryMode === 'direct'
                ? describeDirectDeliveryVisibility(readDirectDeliveryVisibility()) : null;
            const unavailableReason = current ? teamCredentialModelUnavailableReason(resource, row) : teamCredentialCatalogStatusLabel(status);
            // Recovery remains a description unless this consumer can open the resource.
            const recoveryPresentation = available ? null : teamCredentialRecoveryPresentation(
                resource.recoveryAction, { isSourceCustodian: false },
            );
            const recovery = recoveryPresentation === null ? null : teamCredentialRecoveryLabel(recoveryPresentation);
            return [{
                value: row.selection,
                upstreamRef: row.descriptor.upstreamRef,
                label: row.descriptor.name || row.selection.modelId,
                searchText: row.selection.modelId,
                ...(experimental ? { titleAccessory: createElement(StatusPill, {
                    testID: `team-provider-model-experimental:${sessionModelSelectionKey(row.selection)}`,
                    variant: 'neutral', hideDot: true, label: experimental,
                }) } : {}),
                source: { label: displayName, native: false, inDescription: true },
                description: [displayName, delivery, confidence, unavailableReason, recovery, directDisclosure]
                    .filter((value): value is string => Boolean(value)).join(' · '),
                ...(directDisclosure ? { descriptionLines: 0 } : {}),
                disabled: !available && !input.onRecoverTeamCredentialResource,
                availability: available ? 'available' : 'unavailable',
                unavailableReason: available ? null
                    : current ? teamCredentialModelUnavailableReason(resource, row, true) ?? t('common.unavailable')
                        : resourceShortUnavailableLabel(resource.readiness, status),
                ...(!available && input.onRecoverTeamCredentialResource
                    ? { onActivate: () => input.onRecoverTeamCredentialResource?.(resource) } : {}),
                accessibilityLabel: [
                    input.teamNameById?.[resource.teamId] ?? t('teams.title'), input.homeNameByTeamId?.[resource.teamId],
                    displayName, row.descriptor.name || row.selection.modelId, delivery, confidence, experimental, directDisclosure,
                    available ? undefined : unavailableReason, available ? undefined : recovery,
                ].filter((value): value is string => Boolean(value)).join(', '),
            }];
        });
        const teamName = input.teamNameById?.[resource.teamId] ?? t('teams.title');
        const homeName = input.homeNameByTeamId?.[resource.teamId];
        if (options.length === 0) {
            const unavailableReason = teamCredentialUnavailableReason(resource);
            if (!unavailableReason) return [];
            const recoveryPresentation = teamCredentialRecoveryPresentation(
                resource.recoveryAction, { isSourceCustodian: false },
            );
            const recovery = recoveryPresentation === null ? null : teamCredentialRecoveryLabel(recoveryPresentation);
            options.push({
                value: null,
                key: `team-resource:${resource.teamId}:${resource.id}`,
                label: displayName,
                description: [unavailableReason, recovery]
                    .filter((value): value is string => Boolean(value)).join(' · '),
                disabled: !input.onRecoverTeamCredentialResource,
                availability: 'unavailable',
                unavailableReason: teamCredentialUnavailableReason(resource, undefined, true)
                    ?? resourceShortUnavailableLabel(resource.readiness,
                        input.teamCredentialResourceStatusByKey?.get(`${resource.teamId}:${resource.id}`)),
                ...(input.onRecoverTeamCredentialResource
                    ? { onActivate: () => input.onRecoverTeamCredentialResource?.(resource) } : {}),
                accessibilityLabel: [teamName, homeName, displayName, unavailableReason, recovery]
                    .filter((value): value is string => Boolean(value)).join(', '),
            });
        }
        return [{
            id: `team-resource:${resource.teamId}:${resource.id}`,
            title: `${t('teams.credentials.title')} · ${teamName}${homeName ? ` · ${homeName}` : ''}`,
            options,
        }];
    });
}
