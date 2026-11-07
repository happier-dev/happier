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
import { resourceStateLabel } from '@/components/settings/teams/credentials/readinessPresentation';
import { teamCredentialCatalogConfidenceLabel } from '@/components/settings/teams/credentials/catalogConfidencePresentation';
import { describeDirectDeliveryVisibility, readDirectDeliveryVisibility } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import { formatLimitResetUtc, limitMetricLabel, teamCredentialRecoveryLabel, teamCredentialRecoveryPresentation } from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { StatusPill } from '@/components/ui/status/StatusPill';
import type { buildSessionModelPickerSections, SessionModelPickerOption, SessionModelPickerSection } from './buildSessionModelPickerSections';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

function teamCredentialDeliveryUnavailableReason(reason: ProviderErrorCodeV1, deliveryMode?: TeamCredentialProviderModelSelectionV1['deliveryMode']): string {
    if (deliveryMode === 'vendor-native' && reason === 'provider_credential_transport_unavailable') {
        return t('teams.credentials.errors.nativeDeliveryUnavailable');
    }
    return t(presentProviderError(reason).descriptionKey);
}

export function teamCredentialUnavailableReason(
    resource: TeamCredentialResourceCatalogEntryV1,
    deliveryMode?: TeamCredentialProviderModelSelectionV1['deliveryMode'],
): string | null {
    if (resource.deliveryUnavailableReason) return teamCredentialDeliveryUnavailableReason(resource.deliveryUnavailableReason, deliveryMode);
    const readiness = deliveryMode ? readTeamCredentialDeliveryReadinessV1(resource.readiness, deliveryMode) : resource.readiness;
    switch (readiness.kind) {
        case 'available': return null;
        case 'broker_unavailable': return t('teams.credentials.errors.brokerUnavailable');
        case 'source_unavailable': return resourceStateLabel(readiness);
        case 'update_required': return t('teams.unavailable.updateRequired');
        case 'policy_denied': return t('teams.credentials.forbidden');
        case 'limit_reached': return [
            t('teams.credentials.limits.reached'), limitMetricLabel(readiness.metric), formatLimitResetUtc(readiness.resetsAtUtc),
        ].filter((part): part is string => Boolean(part)).join(' · ');
        case 'resource_corrupt':
        case 'resource_unavailable': return t('teams.credentials.detail.notFound');
    }
}

function teamCredentialModelUnavailableReason(
    resource: TeamCredentialResourceCatalogEntryV1,
    row: TeamCredentialResourceCatalogEntryV1['providerModels'][number],
): string | null {
    if (row.deliveryUnavailableReason) return teamCredentialDeliveryUnavailableReason(row.deliveryUnavailableReason, row.selection.deliveryMode);
    switch (row.availability) {
        case 'available': return teamCredentialUnavailableReason(resource, row.selection.deliveryMode);
        case 'source_owner_required': return t('teams.credentials.errors.sourceOwnerRequired');
        case 'resource_corrupt': return t('teams.credentials.detail.notFound');
        case 'policy_denied': return t('teams.credentials.forbidden');
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
        !isTeamCredentialModelIncompatible(row)
        && !resolveProviderModelCapabilityCompatibilityV1({
            required: requirements.requirements.required, model: row.descriptor,
        }).incompatible
    ));
}

export function buildTeamCredentialModelPickerSections(
    input: Parameters<typeof buildSessionModelPickerSections>[0],
    modelEligible = createTeamCredentialModelEligibility(input),
): SessionModelPickerSection[] {
    return (input.teamCredentialResources ?? []).flatMap((resource): SessionModelPickerSection[] => {
        const options = resource.providerModels.flatMap((row): SessionModelPickerOption[] => {
            if (row.selection.agentTargetKey !== input.agentTargetKey || !modelEligible(row)) return [];
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
                label: row.descriptor.name || row.selection.modelId,
                searchText: row.selection.modelId,
                ...(experimental ? { titleAccessory: createElement(StatusPill, {
                    testID: `team-provider-model-experimental:${sessionModelSelectionKey(row.selection)}`,
                    variant: 'neutral', hideDot: true, label: experimental,
                }) } : {}),
                source: { label: resource.displayName, native: false, inDescription: true },
                description: [resource.displayName, delivery, confidence, unavailableReason, recovery, directDisclosure]
                    .filter((value): value is string => Boolean(value)).join(' · '),
                ...(directDisclosure ? { descriptionLines: 0 } : {}),
                disabled: !available && !input.onRecoverTeamCredentialResource,
                ...(!available && input.onRecoverTeamCredentialResource
                    ? { onActivate: () => input.onRecoverTeamCredentialResource?.(resource) } : {}),
                accessibilityLabel: [
                    input.teamNameById?.[resource.teamId] ?? t('teams.title'), input.homeNameByTeamId?.[resource.teamId],
                    resource.displayName, row.descriptor.name || row.selection.modelId, delivery, confidence, experimental, directDisclosure,
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
                label: resource.displayName,
                description: [unavailableReason, recovery]
                    .filter((value): value is string => Boolean(value)).join(' · '),
                disabled: !input.onRecoverTeamCredentialResource,
                ...(input.onRecoverTeamCredentialResource
                    ? { onActivate: () => input.onRecoverTeamCredentialResource?.(resource) } : {}),
                accessibilityLabel: [teamName, homeName, resource.displayName, unavailableReason, recovery]
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
