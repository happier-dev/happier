import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema, serializeModelVisibilityRefV1 } from '@happier-dev/protocol';

import {
    buildSessionModelPickerSections,
    hiddenModelVisibilityKeys,
    withSessionModelSourceSuffixes,
} from './buildSessionModelPickerSections';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { t } from '@/text';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

function providerGroup(input: Readonly<{
    connectionId: string;
    modelId: string;
    providerName?: string;
    connectionName?: string;
    visibility?: 'visible' | 'hidden_agent' | 'hidden_all_agents' | 'hidden_current_selection';
    modelLoadPreflightPolicy?: 'advisory' | 'required' | null;
    loadState?: 'unknown' | 'loaded' | 'unloaded';
}>) {
    const connectionId = ProviderConnectionIdSchema.parse(input.connectionId);
    return {
        connectionId,
        providerName: input.providerName ?? 'Gateway',
        connectionName: input.connectionName ?? input.connectionId,
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
        connectionRevision: 1,
        authorization: { authorized: true as const },
        manualModelPolicy: 'allowed' as const,
        supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: [],
        modelLoadAction: 'descriptor_absent' as const,
        modelLoadPreflightPolicy: input.modelLoadPreflightPolicy ?? null,
        rows: [{
            ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: input.modelId },
            descriptor: { id: input.modelId, name: `Provider ${input.modelId}` },
            sources: { manual: false, static: true, probe: false },
            confidence: 'verified_static' as const,
            compatibility: {
                result: {
                    status: 'verified' as const,
                    selectedProtocol: 'openai-responses' as const,
                    evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' },
                },
                compatibilityFingerprint: `compatibility:v1:${input.connectionId}`,
                confirmed: true,
            },
            endpointHealth: 'available' as const,
            catalog: { stale: false },
            loadState: input.loadState ?? 'unknown' as const,
            visibility: input.visibility ?? 'visible',
        }],
    };
}

describe('buildSessionModelPickerSections', () => {
    it('keeps same-name source labels after Favorites move out of their original sections', () => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex', hiddenNativeModelKeys: new Set(),
            nativeModels: [{ value: 'same', label: 'Provider same' }],
            nativeSourceLabel: 'Work pool', providerProjectionAuthoritative: true,
            providerGroups: [providerGroup({ connectionId: 'pc_work', modelId: 'same', connectionName: 'Work' })],
        });
        const [native, provider] = sections;
        const displayed = withSessionModelSourceSuffixes([
            { id: 'favorites', title: 'Favorites', options: native!.options },
            provider!,
        ], 'favorites');
        expect(displayed.flatMap(section => section.options.map(option => option.labelSuffix))).toEqual([
            t('agentInput.model.viaSource', { source: 'Work pool' }),
            t('agentInput.model.viaSource', { source: 'Gateway · Work' }),
        ]);
    });
    it('retains source identity when same-name model rows are flattened into search or favorites', () => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex', nativeModels: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            providerGroups: [providerGroup({ connectionId: 'pc_work', modelId: 'same', connectionName: 'Work' }),
                providerGroup({ connectionId: 'pc_lab', modelId: 'same', connectionName: 'Lab' })],
        });
        const options = sections.flatMap(section => section.options);
        expect(options).toHaveLength(2);
        expect(options.map(option => option.value && sessionModelSelectionKey(option.value))).toEqual([
            sessionModelSelectionKey({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_work', modelId: 'same' }),
            sessionModelSelectionKey({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_lab', modelId: 'same' }),
        ]);
        const suffixed = withSessionModelSourceSuffixes(sections, 'favorites').flatMap(section => section.options);
        expect(suffixed.map(option => option.labelSuffix)).toEqual([
            t('agentInput.model.viaSource', { source: 'Gateway · Work' }),
            t('agentInput.model.viaSource', { source: 'Gateway · Lab' }),
        ]);
    });
    it('says "via" only where a heading cannot: ambiguous names and Provider favorites', () => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex', hiddenNativeModelKeys: new Set(),
            nativeModels: [{ value: 'unique-native', label: 'Opus' }, { value: 'shared', label: 'Provider same' }],
            nativeSourceLabel: 'Claude: Work pool',
            providerProjectionAuthoritative: true,
            providerGroups: [providerGroup({ connectionId: 'pc_work', modelId: 'same', connectionName: 'Work' }),
                providerGroup({ connectionId: 'pc_lab', modelId: 'only-here', connectionName: 'Lab' })],
        });
        expect(sections.map(section => section.title)).toEqual(['Claude: Work pool', 'Gateway · Work', 'Gateway · Lab']);
        const nativeRow = sections[0]!.options[0]!;
        const favorites = { id: 'favorites', title: 'Favorites', options: [nativeRow, sections[2]!.options[0]!] };
        const suffixed = withSessionModelSourceSuffixes([favorites, ...sections], 'favorites');
        const suffixOf = (label: string, sectionId: string) => suffixed.find(section => section.id === sectionId)
            ?.options.find(option => option.label === label)?.labelSuffix;
        expect(suffixOf('Opus', 'native')).toBeUndefined();
        expect(suffixOf('Opus', 'favorites')).toBeUndefined();
        expect(suffixOf('Provider only-here', 'favorites')).toBe(t('agentInput.model.viaSource', { source: 'Gateway · Lab' }));
        expect(suffixOf('Provider only-here', 'connection:pc_lab')).toBeUndefined();
        expect(suffixOf('Provider same', 'native')).toBe(t('agentInput.model.viaSource', { source: 'Claude: Work pool' }));
        expect(suffixOf('Provider same', 'connection:pc_work')).toBe(t('agentInput.model.viaSource', { source: 'Gateway · Work' }));
    });
    it('projects an entitled direct Team resource into the canonical picker without exposing source authority', () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: 'Claude Enterprise',
            resourceRevision: 7,
            readiness: { kind: 'available' }, recoveryAction: null,
            mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'current', sessionUsePolicy: 'personal_allowed',
            providerModels: [{
                selection: {
                    kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'direct', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'claude-sonnet',
                },
                descriptor: { id: 'claude-sonnet', name: 'Claude Sonnet' },
                application: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'provider.anthropic', localId: 'anthropic' },
                    endpointTemplateId: 'messages',
                    protocol: 'anthropic-messages',
                },
                sourceRevision: 'direct-source-v1',
                direct: {
                    sourceMemberKey: 'provider-slot',
                    sourceVersion: 'direct-source-v1',
                },
                availability: 'available',
            }],
            sourcePresentation: {
                kind: 'provider',
                provider: { identity: { pluginId: 'provider.anthropic', localId: 'anthropic' }, definitionRevision: 1 },
            },
        });
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            homeNameByTeamId: { 'team-1': 'Work Home' },
        });

        expect(sections).toHaveLength(1);
        expect(sections[0]).toMatchObject({
            id: 'team-resource:team-1:resource-1',
            title: 'Shared credentials · Acme · Work Home',
            options: [{
                value: resource.providerModels[0]?.selection,
                label: 'Claude Sonnet',
                disabled: false,
            }],
        });
        expect(JSON.stringify(sections)).not.toContain('custodianAccountId');
        expect(JSON.stringify(sections)).not.toContain('brokerMachineId');

        const recover = vi.fn();
        const staleSections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource],
            currentTeamCredentialResourceKeys: new Set(),
            onRecoverTeamCredentialResource: recover,
        });
        expect(staleSections[0]?.options[0]).toMatchObject({
            disabled: false,
            description: expect.stringContaining(t('teams.unavailable.offline')),
        });
        staleSections[0]?.options[0]?.onActivate?.();
        expect(recover).toHaveBeenCalledWith(resource);
    });

    it('keeps an unavailable selected Team model named with its resource, Team, Home, route, and recovery', () => {
        const selection = {
            kind: 'team_credential_provider_model' as const,
            resourceId: 'resource-1',
            teamId: 'team-1',
            expectedResourceRevision: 7,
            deliveryMode: 'direct' as const,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'claude-sonnet',
        };
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: 'Acme Claude access',
            resourceRevision: 8,
            readiness: { kind: 'source_unavailable' }, recoveryAction: 'source_owner_action',
            mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'stale', sessionUsePolicy: 'personal_allowed',
            providerModels: [],
            sourcePresentation: {
                kind: 'provider',
                provider: { identity: { pluginId: 'provider.anthropic', localId: 'anthropic' }, definitionRevision: 1 },
            },
        });
        const recover = vi.fn();

        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            selectedTeamCredentialModel: selection,
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            homeNameByTeamId: { 'team-1': 'Work Home' },
            currentTeamCredentialResourceKeys: new Set(),
            onRecoverTeamCredentialResource: recover,
        });

        expect(sections[0]?.options[0]).toMatchObject({
            value: selection,
            label: 'claude-sonnet',
            disabled: false,
            description: expect.stringContaining('Acme Claude access'),
            accessibilityLabel: expect.stringContaining('Acme'),
        });
        expect(sections[0]?.options[0]?.description).toContain('Work Home');
        expect(sections[0]?.options[0]?.description).toContain(t('teams.credentials.delivery.direct'));
        expect(sections[0]?.options[0]?.description).toContain(t('teams.credentials.recovery.ownerHandoff'));
        expect(sections[0]?.options[0]?.description).not.toContain('source_unavailable');
        sections[0]?.options[0]?.onActivate?.();
        expect(recover).toHaveBeenCalledWith(resource);
    });

    it('never presents source-owner-required Team models as available or as a raw status code', () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: 'Acme Claude access',
            resourceRevision: 7,
            readiness: { kind: 'available' }, recoveryAction: 'source_owner_action',
            mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [{
                selection: {
                    kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'claude-sonnet',
                },
                descriptor: { id: 'claude-sonnet', name: 'Claude Sonnet' },
                application: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'provider.anthropic', localId: 'anthropic' },
                    endpointTemplateId: 'messages', protocol: 'anthropic-messages',
                },
                sourceRevision: 'source-v1',
                availability: 'source_owner_required',
            }],
            sourcePresentation: {
                kind: 'provider',
                provider: { identity: { pluginId: 'provider.anthropic', localId: 'anthropic' }, definitionRevision: 1 },
            },
        });

        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource],
            currentTeamCredentialResourceKeys: new Set(['team-1:resource-1']),
        });

        expect(sections[0]?.options[0]).toMatchObject({ disabled: true });
        expect(sections[0]?.options[0]?.description).toContain(t('teams.credentials.errors.sourceOwnerRequired'));
        expect(sections[0]?.options[0]?.accessibilityLabel).not.toContain('source_owner_required');
    });

    it('names the exhausted allowance and when it reopens instead of a bare "Limit reached"', () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: 'Acme Claude access',
            resourceRevision: 7,
            readiness: { kind: 'limit_reached', metric: 'total_tokens', resetsAtUtc: '2026-09-15T00:00:00.000Z' },
            recoveryAction: 'retry',
            mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [{
                selection: {
                    kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'claude-sonnet',
                },
                descriptor: { id: 'claude-sonnet', name: 'Claude Sonnet' },
                application: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'provider.anthropic', localId: 'anthropic' },
                    endpointTemplateId: 'messages', protocol: 'anthropic-messages',
                },
                sourceRevision: 'source-v1',
                availability: 'available',
            }],
            sourcePresentation: {
                kind: 'provider',
                provider: { identity: { pluginId: 'provider.anthropic', localId: 'anthropic' }, definitionRevision: 1 },
            },
        });

        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource],
            currentTeamCredentialResourceKeys: new Set(['team-1:resource-1']),
        });

        const description = sections[0]?.options[0]?.description ?? '';
        expect(description).toContain(t('teams.credentials.limits.reached'));
        expect(description).toContain(t('teams.credentials.limits.metric.tokens'));
        expect(description).toContain('UTC');
        expect(description).not.toContain('total_tokens');
        expect(description).not.toContain('2026-09-15T00:00:00.000Z');
    });

    it('fails closed to native parity when the Providers feature decision is not enabled', () => {
        const hiddenKey = serializeModelVisibilityRefV1({
            scope: 'agent',
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'hidden-native',
        });
        const settings = { modelVisibilityByRef: { [hiddenKey]: 'hidden' as const } };

        // @ts-expect-error Runtime hardening: stale or untyped callers that omit the required decision must fail closed.
        expect(hiddenModelVisibilityKeys(settings)).toEqual(new Set());
        expect(hiddenModelVisibilityKeys(settings, { providersFeatureEnabled: false })).toEqual(new Set());
        expect(hiddenModelVisibilityKeys(settings, { providersFeatureEnabled: true })).toEqual(new Set([hiddenKey]));
    });

    it('keeps native and Provider refs with identical vendor model ids distinct', () => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [{ value: 'shared', label: 'Native shared', description: 'Native' }],
            providerGroups: [
                providerGroup({ connectionId: 'pc_work', modelId: 'shared' }),
                providerGroup({ connectionId: 'pc_personal', modelId: 'shared' }),
            ],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set(),
        });

        const keys = sections.flatMap((section) => section.options.map((option) => sessionModelSelectionKey(option.value)));
        expect(new Set(keys).size).toBe(3);
    });

    it('blocks only verified unloaded models whose Provider requires preflight loading', () => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [],
            providerGroups: [
                providerGroup({
                    connectionId: 'pc_required',
                    modelId: 'required-unloaded',
                    modelLoadPreflightPolicy: 'required',
                    loadState: 'unloaded',
                }),
                providerGroup({
                    connectionId: 'pc_advisory',
                    modelId: 'advisory-unloaded',
                    modelLoadPreflightPolicy: 'advisory',
                    loadState: 'unloaded',
                }),
                providerGroup({
                    connectionId: 'pc_required_unknown',
                    modelId: 'required-unknown',
                    modelLoadPreflightPolicy: 'required',
                    loadState: 'unknown',
                }),
            ],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set(),
        });

        const optionsByModelId = new Map(sections.flatMap((section) => (
            section.options.map((option) => [option.value?.modelId, option] as const)
        )));
        expect(optionsByModelId.get('required-unloaded')).toMatchObject({
            disabled: true,
        });
        expect(optionsByModelId.get('advisory-unloaded')?.disabled).toBe(false);
        expect(optionsByModelId.get('required-unknown')?.disabled).toBe(false);
    });

    it('gives duplicate Provider connection/model names collision-safe accessible names', () => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [],
            providerGroups: [
                providerGroup({
                    connectionId: 'pc_gateway_a',
                    providerName: 'Gateway A',
                    connectionName: 'Work',
                    modelId: 'shared',
                }),
                providerGroup({
                    connectionId: 'pc_gateway_b',
                    providerName: 'Gateway B',
                    connectionName: 'Work',
                    modelId: 'shared',
                }),
            ],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set(),
        });

        expect(sections.flatMap((section) => section.options.map((option) => option.accessibilityLabel))).toEqual([
            'Gateway A, Work, Provider shared',
            'Gateway B, Work, Provider shared',
        ]);
    });

    it('applies Agent-scoped native visibility without fabricating fallback rows', () => {
        const hiddenKey = serializeModelVisibilityRefV1({
            scope: 'agent',
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'hidden-native',
        });
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [
                { value: 'hidden-native', label: 'Hidden', description: '' },
                { value: 'visible-native', label: 'Visible', description: '' },
            ],
            providerGroups: [],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set([hiddenKey]),
        });

        expect(sections.flatMap((section) => section.options).map((option) => option.label)).toEqual(['Visible']);
    });

    it('keeps the exact hidden current Provider selection as one labeled recovery row', () => {
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [],
            providerGroups: [providerGroup({
                connectionId: 'pc_hidden',
                modelId: 'hidden-current',
                visibility: 'hidden_current_selection',
            })],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set(),
        });

        expect(sections).toHaveLength(1);
        expect(sections[0]?.options).toHaveLength(1);
        expect(sections[0]?.options[0]).toMatchObject({
            label: 'Provider hidden-current',
            disabled: true,
        });
        expect(sections[0]?.options[0]?.description).toContain('Hidden');
    });

    it('keeps the exact hidden current native selection as one labeled recovery row', () => {
        const selected = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'hidden-native',
        } as const;
        const hiddenKey = serializeModelVisibilityRefV1({
            scope: 'agent',
            ...selected,
        });
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [{ value: 'hidden-native', label: 'Hidden native', description: 'Native' }],
            providerGroups: [],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set([hiddenKey]),
            selected,
        });

        expect(sections).toHaveLength(1);
        expect(sections[0]?.options).toEqual([expect.objectContaining({
            value: selected,
            label: 'Hidden native',
            disabled: true,
        })]);
        expect(sections[0]?.options[0]?.description).toContain('Hidden');
    });

    it('does not classify a selected Provider model as deleted before its projection settles', () => {
        const selected = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_loading'),
            modelId: 'pending-model',
        };
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [],
            providerGroups: [],
            hiddenNativeModelKeys: new Set(),
            selected,
            providerProjectionAuthoritative: false,
        });

        expect(sections).toEqual([]);
    });

    it('renders one disabled recovery row when the exact selected connection/model disappeared', () => {
        const selected = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_deleted'),
            modelId: 'missing-model',
        };
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [],
            providerGroups: [],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set(),
            selected,
        });

        expect(sections).toHaveLength(1);
        expect(sections[0]?.options).toEqual([expect.objectContaining({
            value: selected,
            label: 'missing-model',
            disabled: true,
        })]);
    });

    it.each([
        ['contribution_unavailable', 'provider_contribution_unavailable'],
        ['connection_deleted', 'provider_connection_not_found'],
        ['model_not_found', 'provider_model_not_found'],
    ] as const)('presents %s current-selection recovery from the daemon typed reason', (kind, code) => {
        const selected = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_recovery'),
            modelId: 'missing-model',
        };
        const error = createProviderErrorV1(code, {
            connectionId: selected.providerConnectionId,
            machineId: 'machine-a',
        });
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [],
            providerGroups: [],
            providerProjectionAuthoritative: true,
            hiddenNativeModelKeys: new Set(),
            selected,
            currentSelectionRecovery: {
                kind,
                ref: selected,
                error,
                displaySnapshot: {
                    providerName: 'Gateway', connectionName: 'Work', modelName: 'Previous model',
                },
            },
        });

        expect(sections[0]?.options[0]).toMatchObject({
            label: 'Previous model',
            description: t(presentProviderError(error).descriptionKey),
            accessibilityLabel: 'Gateway, Work, Previous model',
            disabled: true,
        });
    });

    it('drops the automatic option when the embed restricts models (allowAutomatic: false)', () => {
        const nativeModels = [
            { value: 'default', label: 'Automatic' },
            { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
        ];
        const values = (allowAutomatic: boolean) => buildSessionModelPickerSections({
            agentTargetKey: 'agent:happier.agent.claude/claude',
            nativeModels, providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            allowAutomatic,
        }).flatMap((section) => section.options.map((option) => option.value));

        expect(values(true)).toContain(null);
        expect(values(false)).not.toContain(null);
        expect(values(false)).toContainEqual({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-sonnet-4-5' });
    });
});
