import { describe, expect, it } from 'vitest';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

import { t } from '@/text';
import { resourceShortUnavailableLabel } from '@/components/settings/teams/credentials/readinessPresentation';
import { buildTeamCredentialModelPickerSections } from './buildTeamCredentialModelPickerSections';

describe('Team resource refusals without model projections', () => {
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'codex-pool', teamId: 'work-team', displayName: 'Codex pool', resourceRevision: 1,
        readiness: { kind: 'broker_unavailable' }, recoveryAction: 'source_owner_action',
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
        sessionUsePolicy: 'personal_allowed', providerModels: [], sourcePresentation: null,
    });
    const input = {
        declarationContext: { kind: 'account' as const }, agentTargetKey: 'agent:happier.agent.codex/codex',
        nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set<string>(),
        providerProjectionAuthoritative: true, teamCredentialResources: [resource],
        teamNameById: { 'work-team': 'Work' }, homeNameByTeamId: { 'work-team': 'This Home' },
    };

    it('keeps the unavailable resource visible with its refusal and owner recovery, without a model selection', () => {
        const sections = buildTeamCredentialModelPickerSections(input);
        expect(sections).toHaveLength(1);
        expect(sections[0]?.options).toHaveLength(1);
        const option = sections[0]?.options[0];
        expect(option).toMatchObject({ value: null, label: resource.displayName, disabled: true,
            availability: 'unavailable', unavailableReason: resourceShortUnavailableLabel(resource.readiness) });
        expect(option?.onActivate).toBeUndefined();
        expect(option?.description).toContain(t('teams.credentials.errors.brokerUnavailable'));
        expect(option?.description).toContain(t('teams.credentials.recovery.ownerHandoff'));
        expect(option?.accessibilityLabel).toContain(t('teams.credentials.errors.brokerUnavailable'));
    });

    it('opens recovery for the actual resource when the consumer provides it', () => {
        const recovered: typeof resource[] = [];
        const option = buildTeamCredentialModelPickerSections({
            ...input, onRecoverTeamCredentialResource: entry => recovered.push(entry),
        })[0]?.options[0];
        expect(option).toMatchObject({ value: null, disabled: false, availability: 'unavailable' });
        option?.onActivate?.();
        expect(recovered).toEqual([resource]);
    });

    it('keeps an available resource with no models empty', () => {
        const available = TeamCredentialResourceCatalogEntryV1Schema.parse({
            ...resource, readiness: { kind: 'available' }, recoveryAction: null,
            sourcePresentation: { kind: 'provider', provider: {
                identity: { pluginId: 'provider.openai', localId: 'openai' }, definitionRevision: 1,
            } },
        });
        expect(buildTeamCredentialModelPickerSections({ ...input, teamCredentialResources: [available] })).toEqual([]);
    });

    it('omits wrong-Agent resources instead of turning their filtered models into a refusal placeholder', () => {
        const wrongAgent = 'agent:happier.agent.claude/claude';
        const other = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
            providerModels: [{
                selection: { kind: 'team_credential_provider_model', resourceId: resource.id, teamId: resource.teamId,
                    expectedResourceRevision: resource.resourceRevision, deliveryMode: 'brokered', agentTargetKey: wrongAgent, modelId: 'model' },
                descriptor: { id: 'model', name: 'Other Agent model' },
                application: { agentTargetKey: wrongAgent,
                    implementationIdentity: { pluginId: 'provider.anthropic', localId: 'anthropic' },
                    endpointTemplateId: 'messages', protocol: 'anthropic-messages' },
                sourceRevision: 'source-v1', availability: 'available',
            }],
        });
        expect(buildTeamCredentialModelPickerSections({ ...input, teamCredentialResources: [other] })).toEqual([]);
    });

});
