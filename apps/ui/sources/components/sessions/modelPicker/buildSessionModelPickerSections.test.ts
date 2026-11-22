import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderConnectionV1Schema} from '@happier-dev/protocol/providers/connections/v1';
import { ProviderConnectionIdSchema} from '@happier-dev/protocol/providers/ids';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/selection/v1';
import { projectAccountProviderModelsV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';

import {
    buildSessionModelPickerSections,
    resolveSessionModelSourceDescriptor,
    buildSessionModelSelectedTriggerPresentation,
    hiddenModelVisibilityKeys,
    selectSessionModelPickerSourceGroups,
    withSessionModelSourceSuffixes,
} from './buildSessionModelPickerSections';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { t } from '@/text';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readAccountAgentProviderRequirements, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';

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
    it('retains the exact sign-in choice beside the same model from a key or another endpoint', () => {
        const group = providerGroup({ connectionId: 'gateway-key', modelId: 'openai/gpt-4' });
        const row = group.rows[0]!;
        const ref = {
            source: 'connected_account' as const,
            purpose: { consumer: { pluginId: 'example.gateway', localId: 'gateway' }, purpose: 'inference' },
            endpointTemplateId: 'responses',
            agentTargetKey: row.ref.agentTargetKey,
            modelId: row.ref.modelId,
        };
        const other = { ...ref, endpointTemplateId: 'chat' };
        const providerGroups = [group,
            { ...group, connectionId: ProviderConnectionIdSchema.parse('gateway-signed-in'),
                connectionName: 'Vercel · Studio', rows: [
                    { ...row, ref: other, descriptor: { ...row.descriptor, name: 'Chat' } },
                    { ...row, ref, descriptor: { ...row.descriptor, name: 'Responses' } },
                ] }];
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: ref.agentTargetKey, nativeModels: [], providerGroups,
            hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true, selected: ref });
        const options = sections.flatMap(section => section.options);
        expect(options).toHaveLength(3);
        expect(new Set(options.map(option => sessionModelSelectionKey(option.value))).size).toBe(3);
        expect(resolveSessionModelSourceDescriptor({ selected: ref, providerGroups })?.name).toBe('Responses');
    });

    it('offers credential recovery instead of counting a gateway that rejected its API key', () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const upstreamRef = { vendor: 'openai', vendorModelId: 'gpt-4' };
        const group = providerGroup({ connectionId: 'pc_invalid_key', modelId: 'openai/gpt-4' });
        const sections = buildSessionModelPickerSections({
            declarationContext: { kind: 'account' }, agentTargetKey,
            nativeModels: [{ value: 'gpt-4', label: 'GPT-4', upstreamRef }],
            providerGroups: [{ ...group, rows: group.rows.map(row => ({
                ...row, descriptor: { ...row.descriptor, upstreamRef }, endpointHealth: 'unauthorized',
            })) }],
            hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
        });
        const model = selectSessionModelPickerSourceGroups(sections).find(candidate => candidate.upstreamRef?.vendorModelId === 'gpt-4');
        expect(model).toMatchObject({ sourceCount: 1, sources: expect.arrayContaining([
            expect.objectContaining({ providerConnectionId: group.connectionId, state: 'needs-key' }),
        ]) });
    });

    it('shows one exact native ref when the observed Account catalog also supplies it', () => {
        const group = providerGroup({ connectionId: 'connected-source:account', modelId: 'observed-model' });
        const selected = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'observed-model' };
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: selected.agentTargetKey, nativeModels: [{ value: 'observed-model', label: 'Native observed model' }],
            providerGroups: [{ ...group, rows: group.rows.map(row => ({ ...row, ref: selected })) }],
            hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true, selected,
        });
        const options = sections.flatMap(section => section.options);
        expect(options.filter(option => sessionModelSelectionKey(option.value) === sessionModelSelectionKey(selected)))
            .toMatchObject([{ label: 'Provider observed-model' }]);
    });
    it('reads an Agent model\'s own description (a consent disclosure) in full', () => {
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.muse/muse', providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            nativeModels: [{ value: 'meta/spark-contributor', label: 'Spark contributor',
                description: 'Your content, including inter-session messages, may be used for product improvement.' }],
        });
        expect(sections.flatMap(section => section.options)).toMatchObject([{ label: 'Spark contributor', descriptionLines: 0 }]);
    });

    it('keeps a selected native default in the available Agent catalog', () => {
        const selected = { agentTargetKey: 'agent:happier.agent.grok/grok', providerConnectionId: null, modelId: 'default' };
        const nativeModels = [{ value: 'default', label: 'Agent default' }, { value: 'grok-4.7', label: 'Grok 4.7' }];
        const input = { declarationContext: { kind: 'account' as const }, agentTargetKey: selected.agentTargetKey,
            nativeModels, providerGroups: [], hiddenNativeModelKeys: new Set<string>(),
            providerProjectionAuthoritative: true, selected };
        const sections = buildSessionModelPickerSections(input);
        expect(sections.map(section => section.id)).toEqual(['native']);
        expect(sections[0]?.options.find(option => sessionModelSelectionKey(option.value) === sessionModelSelectionKey(selected)))
            .toMatchObject({ label: 'Agent default', availability: 'available' });
        expect(buildSessionModelSelectedTriggerPresentation({ ...input, fallbackLabel: 'Missing', fieldLabel: 'Model' }))
            .toEqual({ subtitle: 'Agent default' });
    });
    it('keeps a selected managed model available in the closed trigger', () => {
        const group = providerGroup({ connectionId: 'connected-source:managed', modelId: 'source-model' });
        const selected = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'managed/source-model' };
        const presentation = buildSessionModelSelectedTriggerPresentation({
            declarationContext: { kind: 'account' }, agentTargetKey: selected.agentTargetKey,
            nativeModels: [], providerGroups: [{ ...group, rows: group.rows.map(row => ({ ...row, ref: selected })) }],
            hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true, selected,
            fallbackLabel: 'Unavailable selection', fieldLabel: 'Model',
        });
        expect(presentation.subtitle).toBe('Provider source-model');
        expect(presentation.detail).not.toBe(t('agentInput.model.unavailable'));
    });
    it('uses the Provider catalog descriptor for a declaration-managed native model ref', () => {
        const group = providerGroup({ connectionId: 'connected-source:managed', modelId: 'source-model' });
        const selected = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'managed/source-model' };
        const managed = { ...group, rows: group.rows.map(row => ({ ...row, ref: selected })) };
        expect(resolveSessionModelSourceDescriptor({ selected, providerGroups: [managed] })).toEqual(group.rows[0]?.descriptor);
        expect(resolveSessionModelSourceDescriptor({ selected: { ...selected, modelId: 'unrelated' }, providerGroups: [managed] })).toBeNull();
    });
    it('orders available model sources before refused ones and keeps the refusal separate from recovery actions', () => {
        const unavailable = providerGroup({ connectionId: 'pc_off', modelId: 'off' });
        const available = providerGroup({ connectionId: 'pc_ready', modelId: 'ready' });
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex', nativeModels: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true, providerGroups: [{ ...unavailable,
                authorization: { authorized: false, error: createProviderErrorV1('provider_endpoint_unreachable') } }, available],
        });
        expect(sections.flatMap(section => section.options.map(option => [option.value?.modelId, option.availability])))
            .toEqual([['ready', 'available'], ['off', 'unavailable']]);
        expect(sections[1]?.options[0]?.unavailableReason).toBe(t(presentProviderError('provider_endpoint_unreachable').titleKey));
    });
    it('allows an unloaded preference without execution readiness while preserving compatibility and visibility', () => {
        const group = providerGroup({ connectionId: 'pc_preference', modelId: 'model',
            modelLoadPreflightPolicy: 'required', loadState: 'unloaded' });
        const input = { declarationContext: { kind: 'account' as const },
            agentTargetKey: 'agent:happier.agent.codex/codex', nativeModels: [], providerGroups: [group],
            hiddenNativeModelKeys: new Set<string>(), providerProjectionAuthoritative: true };
        const options = (purpose: 'preference' | 'execution', providerGroups = [group]) =>
            buildSessionModelPickerSections({ ...input, purpose, providerGroups }).flatMap(section => section.options);
        expect(options('preference')[0]?.disabled).toBe(false);
        expect(options('execution')[0]?.disabled).toBe(true);
        expect(options('preference', [{ ...group, rows: [{ ...group.rows[0]!, visibility: 'hidden_current_selection' }] }])[0]?.disabled).toBe(true);
        const incompatible = { ...group.rows[0]!, compatibility: { ...group.rows[0]!.compatibility,
            result: { status: 'incompatible' as const, reasons: ['no_compatible_protocol' as const] } } };
        expect(buildSessionModelPickerSections({ ...input, purpose: 'preference', providerGroups: [{ ...group, rows: [incompatible] }] })
            .flatMap(section => section.options)[0]?.disabled).toBe(true);
    });
    it('keeps producer-verified rows selectable while contextual declarations are absent or change', () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const group = providerGroup({ connectionId: 'pc_independent', modelId: 'model' });
        const selected = group.rows[0]!.ref;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                providerRequirements: readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' }) },
        } });
        for (const declarationContext of [
            { kind: 'machine', projection: null }, { kind: 'machine', projection },
            { kind: 'machine', projection: null }, { kind: 'account' },
        ] satisfies ProviderDeclarationContext[]) {
            const options = buildSessionModelPickerSections({
                declarationContext, agentTargetKey, nativeModels: [], providerGroups: [group],
                hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true, selected,
            }).flatMap(section => section.options);
            expect(options.some(option => !option.disabled && option.value
                && 'providerConnectionId' in option.value && option.value.providerConnectionId === selected.providerConnectionId)).toBe(true);
        }
    });
    it.each(['agent:happier.agent.codex/codex', 'agent:happier.agent.claude/claude'])(
        'excludes unsupported tool models from Team and Provider rows for %s while keeping unknown chat models', (agentTargetKey) => {
        const declaration = readAccountProviderDeclarations({ kind: 'account' }).find(entry => entry.definition.id === 'cliproxyapi')!;
        const models = [
            { id: 'chat-model', name: 'Chat model' },
            { id: 'image-model-a', name: 'Image A', capabilities: { toolRoundTrips: 'unsupported' as const } },
            { id: 'image-model-b', name: 'Image B', capabilities: { toolRoundTrips: 'unsupported' as const } },
        ];
        const group = providerGroup({ connectionId: 'pc_work', modelId: 'chat-model' });
        const projected = projectAccountProviderModelsV1({
            catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                modelPickerVisibilityByConnectionId: { [group.connectionId]: true }, connections: [ProviderConnectionV1Schema.parse({
                v: 1, id: group.connectionId, source: { kind: 'contribution', contributionKey: declaration.contributionKey },
                role: 'named', displayName: 'Work', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
            })] },
            definitions: [{ ...declaration, definition: { ...declaration.definition,
                endpointTemplates: declaration.definition.endpointTemplates.map(endpoint => ({ ...endpoint,
                    baseUrl: 'http://127.0.0.1:8317/v1', localUrlCandidates: undefined })),
                catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [...models] } } }],
            agent: readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' }), request: { agentTargetKey },
        });
        expect(projected.status).toBe('success');
        if (projected.status !== 'success') throw new Error('Expected Account projection');
        const projectedIds = projected.groups.flatMap(group => group.rows.map(row => row.ref.modelId));
        expect(projectedIds).toContain('chat-model');
        expect(projectedIds).not.toContain('image-model-a');
        expect(projectedIds).not.toContain('image-model-b');
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Connected Pool' }, recipientEnvelope: null, legacyPlaintext: true }, resourceRevision: 3,
            readiness: { kind: 'available' }, recoveryAction: null,
            mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: ['image-model-a', 'image-model-b', 'chat-model'].map(modelId => ({
                selection: { kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey, modelId },
                descriptor: models.find(model => model.id === modelId),
                application: { agentTargetKey,
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
                sourceRevision: 'source-v1',
                compatibility: modelId.startsWith('image-model') ? {
                    ...group.rows[0]!.compatibility,
                    result: { status: 'incompatible', reasons: ['model_capability_toolRoundTrips_unsupported'] },
                    confirmed: false,
                } : group.rows[0]!.compatibility,
                availability: modelId.startsWith('image-model') ? 'policy_denied' : 'available',
                ...(modelId.startsWith('image-model') ? { deliveryUnavailableReason: 'provider_incompatible_with_agent' } : {}),
            })),
            sourcePresentation: { kind: 'provider', provider: {
                identity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, definitionRevision: 1,
            } },
        });
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey, nativeModels: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Connected Pool' },
            providerGroups: [{ ...group, rows: projected.groups.flatMap(group => group.rows)
                .filter(row => row.ref.modelId === 'chat-model').map(row => ({ ...row,
                    compatibility: group.rows[0]!.compatibility, endpointHealth: 'available' as const,
                })) }],
        });
        expect(sections.map(section => section.options.map(option => option.value?.modelId)))
            .toEqual([['chat-model'], ['chat-model']]);
        const selectedTeam = resource.providerModels.find(model => model.descriptor.id === 'chat-model')!;
        const triggerInput = { agentTargetKey, nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set<string>(),
            providerProjectionAuthoritative: true, selected: null, selectedTeamCredentialModel: selectedTeam.selection,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Connected Pool' }, fallbackLabel: 'Choose', fieldLabel: 'Model' };
        expect(buildSessionModelSelectedTriggerPresentation({ declarationContext: { kind: 'account' }, ...triggerInput })).toMatchObject({
            subtitle: selectedTeam.descriptor.name, detail: expect.stringContaining('Connected Pool'),
        });
        // Preserve an already-selected model's identity without offering a repair
        // action that could re-admit a model known to lack required capabilities.
        const refusedSelectionKey = sessionModelSelectionKey(resource.providerModels[0]!.selection);
        const retained = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey, nativeModels: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
            providerGroups: [], teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Connected Pool' },
            selectedTeamCredentialModel: resource.providerModels[0]!.selection,
            onRecoverTeamCredentialResource: vi.fn(),
        });
        const retainedOption = retained.flatMap(section => section.options)
            .find(option => sessionModelSelectionKey(option.value) === refusedSelectionKey);
        expect(retainedOption).toMatchObject({ disabled: true });
        expect(retainedOption?.onActivate).toBeUndefined();
        // The producer's hard refusal remains authoritative even if display facts
        // later contradict it; it must never become an enabled repair action.
        const contradicted = { ...resource, providerModels: resource.providerModels.map(row => ({ ...row,
            descriptor: { ...row.descriptor, capabilities: { toolRoundTrips: 'supported' as const } },
        })) };
        const refused = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey, nativeModels: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
            providerGroups: [], teamCredentialResources: [contradicted], selectedTeamCredentialModel: resource.providerModels[0]!.selection,
            onRecoverTeamCredentialResource: vi.fn(),
        });
        const refusedOption = refused.flatMap(section => section.options)
            .find(option => sessionModelSelectionKey(option.value) === refusedSelectionKey);
        expect(refusedOption).toMatchObject({ disabled: true });
        expect(refusedOption?.onActivate).toBeUndefined();
        const withoutCompatibility = { ...contradicted, providerModels: contradicted.providerModels.map(row => ({
            ...row, compatibility: undefined,
        })) };
        const unavailable = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey, nativeModels: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true,
            providerGroups: [], teamCredentialResources: [withoutCompatibility], selectedTeamCredentialModel: resource.providerModels[0]!.selection,
            onRecoverTeamCredentialResource: vi.fn(),
        });
        const unavailableOption = unavailable.flatMap(section => section.options)
            .find(option => sessionModelSelectionKey(option.value) === refusedSelectionKey);
        expect(unavailableOption).toMatchObject({ disabled: true });
        expect(unavailableOption?.onActivate).toBeUndefined();
        const verified = { ...resource, providerModels: [ { ...selectedTeam,
            descriptor: { ...selectedTeam.descriptor, capabilities: { toolRoundTrips: 'unsupported' as const } },
        } ] };
        // Producer compatibility cannot supply absent exact Agent requirements
        // or override the Agent's required model capabilities.
        for (const declarationContext of [
            { kind: 'machine', projection: null }, { kind: 'account' },
        ] satisfies ProviderDeclarationContext[]) {
            const input = { declarationContext, agentTargetKey, nativeModels: [], hiddenNativeModelKeys: new Set<string>(),
                providerProjectionAuthoritative: true, providerGroups: [], teamCredentialResources: [verified] };
            expect(buildSessionModelPickerSections(input).flatMap(section => section.options)).toEqual([]);
            const retained = buildSessionModelPickerSections({ ...input,
                selectedTeamCredentialModel: selectedTeam.selection, onRecoverTeamCredentialResource: vi.fn(),
            })[0]?.options[0];
            expect(retained).toMatchObject({ disabled: true });
            expect(retained?.onActivate).toBeUndefined();
        }
    });
    it('keeps a selected Provider model named before its demanded projection arrives, then uses the projected row', () => {
        const group = providerGroup({ connectionId: 'pc_work', modelId: 'same', connectionName: 'Work' });
        const input = {
            agentTargetKey: 'agent:happier.agent.codex/codex', nativeModels: [],
            hiddenNativeModelKeys: new Set<string>(), selected: group.rows[0]!.ref,
            fallbackLabel: t('agentInput.model.unavailable'), fieldLabel: t('newSession.selectModelTitle'),
        };
        // Closed pickers deliberately have no catalog yet; that is not a failed machine read.
        expect(buildSessionModelSelectedTriggerPresentation({ declarationContext: { kind: 'account' }, ...input,
            providerGroups: [], providerProjectionAuthoritative: false,
        })).toEqual({ subtitle: 'same' });
        expect(buildSessionModelSelectedTriggerPresentation({ declarationContext: { kind: 'account' }, ...input,
            providerGroups: [group], providerProjectionAuthoritative: true,
        })).toMatchObject({ subtitle: 'Provider same', detail: 'Gateway · Work' });
        // A settled projection that cannot recover the exact tuple retains its repair presentation.
        expect(buildSessionModelSelectedTriggerPresentation({ declarationContext: { kind: 'account' }, ...input,
            providerGroups: [], providerProjectionAuthoritative: true,
        })).toMatchObject({ subtitle: input.fallbackLabel, detail: t('settingsProviders.detail.deletedDescription') });
    });
    it('describes a missing native Agent model as unavailable, not as a removed Provider', () => {
        const selected = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'gpt-5.1-codex',
        } as const;
        const nativeModels = [{ value: 'gpt-5.4', label: 'gpt-5.4' }];
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: selected.agentTargetKey, nativeModels, providerGroups: [],
            hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true, selected,
        });
        expect(sections.find(section => section.id === 'current-selection-recovery')?.options[0]).toMatchObject({
            disabled: true, description: t('common.unavailable'), unavailableReason: t('common.unavailable'),
        });
        expect(buildSessionModelSelectedTriggerPresentation({ declarationContext: { kind: 'account' },
            agentTargetKey: selected.agentTargetKey,
            nativeModels,
            providerGroups: [],
            hiddenNativeModelKeys: new Set<string>(),
            providerProjectionAuthoritative: true,
            selected,
            fallbackLabel: t('agentInput.model.unavailable'),
            fieldLabel: t('newSession.selectModelTitle'),
        })).toMatchObject({
            subtitle: t('common.unavailable'),
            detail: t('common.unavailable'),
        });
    });
    it('keeps a missing connected-account selection on the Provider recovery path', () => {
        const selected = {
            source: 'connected_account' as const,
            purpose: { consumer: { pluginId: 'example.gateway', localId: 'gateway' }, purpose: 'inference' },
            endpointTemplateId: 'responses', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'missing',
        };
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: selected.agentTargetKey, nativeModels: [], providerGroups: [],
            hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true, selected,
        });
        expect(sections.find(section => section.id === 'current-selection-recovery')?.options[0]).toMatchObject({
            disabled: true, description: t('settingsProviders.detail.deletedDescription'),
            unavailableReason: t('agentInput.model.unavailable'),
        });
    });
    it('announces an equal-name source once using the same identity as its heading', () => {
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex', hiddenNativeModelKeys: new Set(), nativeModels: [],
            providerProjectionAuthoritative: true,
            providerGroups: [providerGroup({ connectionId: 'pc_work', modelId: 'same',
                providerName: 'QA custom live', connectionName: ' qa custom live ' })],
        });
        expect(sections[0]?.title).toBe('QA custom live');
        expect(sections[0]?.options[0]?.accessibilityLabel).toBe('QA custom live, Provider same');
    });
    it('groups a browsed gateway by the vendor slot that serves each model, and only when asked to', () => {
        const service = (localId: string) => ({ pluginId: 'happier.connected.' + localId, localId });
        const slot = (vendor: string, groupId: string) => ({
            purpose: { consumer: { pluginId: 'happier.provider.gateway', localId: 'gateway' }, purpose: vendor },
            target: { kind: 'group' as const, service: service(vendor), groupId },
        });
        const base = providerGroup({ connectionId: 'pc_gateway', modelId: 'm', connectionName: 'Main' });
        const row = (modelId: string, gatewaySlots?: ReturnType<typeof slot>[]) => ({
            ...base.rows[0]!,
            ref: { ...base.rows[0]!.ref, modelId },
            descriptor: { id: modelId, name: modelId },
            ...(gatewaySlots ? { gatewaySlots } : {}),
        });
        const group = {
            ...base,
            rows: [
                row('gpt-sol', [slot('openai', 'codex')]),
                row('fable', [slot('anthropic', 'work')]),
                // Shared by both vendors: listed once, under the first slot, never duplicated.
                row('shared', [slot('openai', 'codex'), slot('anthropic', 'work')]),
                row('manual'),
            ],
        };
        const input = {
            agentTargetKey: 'agent:happier.agent.codex/codex', hiddenNativeModelKeys: new Set<string>(), nativeModels: [],
            providerProjectionAuthoritative: true, providerGroups: [group],
        };
        const titles: Record<string, string> = { codex: 'ChatGPT · Codex pool', work: 'Claude · Work pool' };
        const grouped = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            ...input,
            gatewaySlotTitle: (candidate) => candidate.target.kind === 'group' ? titles[candidate.target.groupId] ?? null : null,
        });
        expect(grouped.map(section => [section.title, section.options.map(option => option.value?.modelId)])).toEqual([
            ['ChatGPT · Codex pool', ['gpt-sol', 'shared']],
            ['Claude · Work pool', ['fable']],
            ['Gateway · Main', ['manual']],
        ]);
        // Without a slot resolver (the unscoped picker) the source stays one section.
        expect(buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, ...input }).map(section => section.options.length)).toEqual([4]);
        // A slot the resolver cannot name does not become a heading; its model stays under the source.
        const unnamed = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, ...input, gatewaySlotTitle: () => null });
        expect(unnamed.map(section => section.options.length)).toEqual([4]);
    });
    it('keeps same-name source labels after Favorites move out of their original sections', () => {
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        // The Favorites row says its source on its description line; the source section's row keeps its suffix.
        expect(displayed.flatMap(section => section.options.map(option => option.labelSuffix))).toEqual([
            undefined,
            t('agentInput.model.viaSource', { source: 'Gateway · Work' }),
        ]);
        expect(displayed[0]!.options[0]!.description).toMatch(new RegExp(`^${t('agentInput.model.viaSourceFact', { source: 'Work pool' })}`));
    });
    it('retains source identity when same-name model rows are flattened into search or favorites', () => {
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex', nativeModels: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            providerGroups: [providerGroup({ connectionId: 'pc_work', modelId: 'same', connectionName: 'Work' }),
                providerGroup({ connectionId: 'pc_lab', modelId: 'same', connectionName: 'Lab' })],
        });
        const options = sections.flatMap(section => section.options);
        expect(options).toHaveLength(2);
        expect(options.map(option => option.value && sessionModelSelectionKey(option.value))).toEqual([
            sessionModelSelectionKey({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'same' }),
            sessionModelSelectionKey({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_lab'), modelId: 'same' }),
        ]);
        const suffixed = withSessionModelSourceSuffixes(sections, 'favorites').flatMap(section => section.options);
        expect(suffixed.map(option => option.labelSuffix)).toEqual([
            t('agentInput.model.viaSource', { source: 'Gateway · Work' }),
            t('agentInput.model.viaSource', { source: 'Gateway · Lab' }),
        ]);
    });
    it('says "via" only where a heading cannot: ambiguous names and Provider favorites', () => {
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        // A favourite says its source on its description line, leaving its title for its saved Thinking.
        expect(suffixOf('Provider only-here', 'favorites')).toBeUndefined();
        expect(suffixed.find(section => section.id === 'favorites')?.options
            .find(option => option.label === 'Provider only-here')?.description)
            .toMatch(new RegExp(`^${t('agentInput.model.viaSourceFact', { source: 'Gateway · Lab' })}`));
        expect(suffixOf('Provider only-here', 'connection:pc_lab')).toBeUndefined();
        expect(suffixOf('Provider same', 'native')).toBe(t('agentInput.model.viaSource', { source: 'Claude: Work pool' }));
        expect(suffixOf('Provider same', 'connection:pc_work')).toBe(t('agentInput.model.viaSource', { source: 'Gateway · Work' }));
    });
    it('names a Team model\'s source once, in its description, and still tells the native same-name row apart', () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Connected Pool' }, recipientEnvelope: null, legacyPlaintext: true }, resourceRevision: 3,
            readiness: { kind: 'available' }, recoveryAction: null,
            mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [{
                selection: {
                    kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey, modelId: 'gpt-5.4',
                },
                descriptor: { id: 'gpt-5.4', name: 'gpt-5.4' },
                application: {
                    agentTargetKey,
                    implementationIdentity: { pluginId: 'provider.openai', localId: 'openai' },
                    endpointTemplateId: 'responses', protocol: 'openai-responses',
                },
                sourceRevision: 'source-v1',
                availability: 'available',
            }],
            sourcePresentation: {
                kind: 'provider',
                provider: { identity: { pluginId: 'provider.openai', localId: 'openai' }, definitionRevision: 1 },
            },
        });
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey, hiddenNativeModelKeys: new Set(),
            nativeModels: [{ value: 'gpt-5.4', label: 'gpt-5.4' }], nativeSourceLabel: 'Codex',
            providerProjectionAuthoritative: true, providerGroups: [], teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Connected Pool' },
        });
        const favorites = { id: 'favorites', title: 'Favorites', options: sections.flatMap(section => section.options) };
        const displayed = withSessionModelSourceSuffixes([favorites, ...sections], 'favorites');
        const options = (id: string) => displayed.find(section => section.id === id)!.options;
        // The native row is told apart by its suffix; the Team row says its source in its description, never twice.
        expect(options('native')[0]?.labelSuffix).toBe(t('agentInput.model.viaSource', { source: 'Codex' }));
        expect(options('team-resource:team-1:resource-1')[0]?.labelSuffix).toBeUndefined();
        expect(options('favorites').map(option => option.labelSuffix)).toEqual([undefined, undefined]);
        expect(options('favorites')[0]?.description).toMatch(new RegExp(`^${t('agentInput.model.viaSourceFact', { source: 'Codex' })}`));
        expect(options('team-resource:team-1:resource-1')[0]?.description).toContain('Connected Pool');
    });
    it('projects an entitled direct Team resource into the canonical picker without exposing source authority', () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Claude Enterprise' }, recipientEnvelope: null, legacyPlaintext: true },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Claude Enterprise' },
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

        const limited = { ...resource,
            readiness: { kind: 'limit_reached' as const, metric: 'total_tokens' as const, resetsAtUtc: '2026-09-15T00:00:00.000Z' },
            recoveryAction: 'retry' as const,
        };
        const build = (entry: typeof resource, current = true) => buildSessionModelPickerSections({
            declarationContext: { kind: 'account' }, agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set<string>(),
            providerProjectionAuthoritative: true, teamCredentialResources: [entry],
            teamCredentialResourceStatusByKey: new Map((current ? ['team-1:resource-1'] : []).map(key => [key, { kind: 'current' as const }])),
            onRecoverTeamCredentialResource: vi.fn(),
        })[0]!.options[0]!;
        const direct = build(limited);
        expect(direct.disabled).toBe(false);
        expect(direct.onActivate).toBeUndefined();
        expect(direct.description).not.toContain(t('teams.credentials.limits.reached'));
        const brokered = build({ ...limited, providerModels: limited.providerModels.map(row => ({
            ...row, selection: { ...row.selection, deliveryMode: 'brokered' as const },
        })) });
        expect(brokered.onActivate).toBeTypeOf('function');
        expect(brokered.description).toContain(t('teams.credentials.limits.reached'));
        const reconnect = build({ ...limited, readiness: {
            kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required',
        }, recoveryAction: 'source_owner_action' });
        expect(reconnect.onActivate).toBeTypeOf('function');
        expect(build(limited, false).onActivate).toBeTypeOf('function');
        expect(build({ ...limited, providerModels: limited.providerModels.map(row => ({
            ...row, availability: 'source_owner_required' as const, direct: null,
        })) }).onActivate).toBeTypeOf('function');

        const unverified = build({ ...resource, providerModels: resource.providerModels.map(row => ({
            ...row, confidence: 'account_unverified' as const,
            sources: { manual: false, static: true, probe: false },
            compatibility: {
                result: { status: 'experimental' as const, selectedProtocol: 'anthropic-messages' as const,
                    reasons: ['compatibility_evidence_missing' as const],
                    confirmationScope: { kind: 'model' as const, modelId: row.selection.modelId } },
                compatibilityFingerprint: 'compatibility:v1:experimental', confirmed: false,
            },
        })) });
        expect(unverified.description).toContain(t('settingsProviders.status.notChecked'));
        expect(unverified.accessibilityLabel).toContain(t('settingsProviders.status.notChecked'));
        expect(unverified.titleAccessory).toMatchObject({ props: {
            label: t('settingsProviders.models.experimental'), variant: 'neutral', hideDot: true,
        } });
        expect(unverified.accessibilityLabel).toContain(t('settingsProviders.models.experimental'));
        expect(unverified.disabled).toBe(false);
        expect(unverified.onActivate).toBeUndefined();

        const unsupported = build({ ...resource, providerModels: resource.providerModels.map(row => ({
            ...row, availability: 'policy_denied' as const, deliveryUnavailableReason: 'provider_machine_unavailable' as const,
        })) });
        expect(unsupported.description).toContain(t(presentProviderError('provider_machine_unavailable').descriptionKey));
        expect(unsupported.description).not.toContain(t('teams.credentials.forbidden'));
        const recover = vi.fn();
        const staleSections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Claude Enterprise' },
            teamCredentialResourceStatusByKey: new Map([['team-1:resource-1', { kind: 'homeUnreachable' }]]),
            onRecoverTeamCredentialResource: recover,
        });
        expect(staleSections[0]?.options[0]).toMatchObject({
            disabled: false,
            description: expect.stringContaining(t('teams.unavailable.offline')),
        });
        staleSections[0]?.options[0]?.onActivate?.();
        expect(recover).toHaveBeenCalledWith(resource);
    });

    it('keeps an unavailable native selection and presents its Machine transport refusal without suggesting missing source keys', () => {
        const selection = { kind: 'team_credential_provider_model' as const, teamId: 'team-1', resourceId: 'resource-1',
            expectedResourceRevision: 7, deliveryMode: 'vendor-native' as const,
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'retained-model' };
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Gateway' }, recipientEnvelope: null, legacyPlaintext: true }, resourceRevision: 7,
            readiness: { kind: 'source_unavailable' }, deliveryUnavailableReason: 'provider_credential_transport_unavailable',
            recoveryAction: 'choose_another_resource', mayBroker: false, mayReceiveDirect: false,
            allowedRoutes: ['vendor-native'], directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
            sourcePresentation: { kind: 'provider', provider: { identity: { pluginId: 'provider.gateway', localId: 'gateway' }, definitionRevision: 1 } },
        });
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: selection.agentTargetKey, nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true, selectedTeamCredentialModel: selection, teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Gateway' },
        });
        expect(sections[0]?.options[0]?.value).toEqual(selection);
        expect(sections[0]?.options[0]?.disabled).toBe(true);
        expect(sections[0]?.options[0]?.description).toContain(t('teams.credentials.errors.nativeDeliveryUnavailable'));
        expect(sections[0]?.options[0]?.description).not.toContain(t('teams.credentials.errors.sourceMissing'));

        const unselected = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: selection.agentTargetKey, nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true, teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Gateway' },
        });
        expect(unselected[0]?.options[0]?.description).toContain(t('teams.credentials.errors.nativeDeliveryUnavailable'));
    });

    it.each([undefined, 'connected_service_credential_reconnect_required'] as const)(
        'keeps an unavailable selected Team model named with its resource, Team, Home, route, and recovery (%s)', reason => {
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
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Acme Claude access' }, recipientEnvelope: null, legacyPlaintext: true },
            resourceRevision: 8,
            readiness: { kind: 'source_unavailable', ...(reason ? { reason } : {}) }, recoveryAction: 'source_owner_action',
            mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'stale', sessionUsePolicy: 'personal_allowed',
            providerModels: [],
            sourcePresentation: {
                kind: 'provider',
                provider: { identity: { pluginId: 'provider.anthropic', localId: 'anthropic' }, definitionRevision: 1 },
            },
        });
        const recover = vi.fn();

        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            selectedTeamCredentialModel: selection,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Acme Claude access' },
            teamNameById: { 'team-1': 'Acme' },
            homeNameByTeamId: { 'team-1': 'Work Home' },
            teamCredentialResourceStatusByKey: new Map(),
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
        if (reason) {
            expect(sections[0]?.options[0]?.description).toContain(t('connectedServices.diagnostics.title.connected_service_credential_reconnect_required'));
            expect(sections[0]?.options[0]?.description).not.toContain(t('teams.credentials.errors.sourceMissing'));
        }
        sections[0]?.options[0]?.onActivate?.();
        expect(recover).toHaveBeenCalledWith(resource);
    });

    it('never presents source-owner-required Team models as available or as a raw status code', () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Acme Claude access' }, recipientEnvelope: null, legacyPlaintext: true },
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

        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Acme Claude access' },
            teamCredentialResourceStatusByKey: new Map([['team-1:resource-1', { kind: 'current' as const }]]),
        });

        expect(sections[0]?.options[0]).toMatchObject({ disabled: true });
        expect(sections[0]?.options[0]?.description).toContain(t('teams.credentials.errors.sourceOwnerRequired'));
        expect(sections[0]?.options[0]?.accessibilityLabel).not.toContain('source_owner_required');
    });

    it('names the exhausted allowance and when it reopens instead of a bare "Limit reached"', () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Acme Claude access' }, recipientEnvelope: null, legacyPlaintext: true },
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

        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set(),
            providerProjectionAuthoritative: true,
            teamCredentialResources: [resource], teamCredentialDisplayNames: { [resource.id]: 'Acme Claude access' },
            teamCredentialResourceStatusByKey: new Map([['team-1:resource-1', { kind: 'current' as const }]]),
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
            'Gateway A · Work, Provider shared',
            'Gateway B · Work, Provider shared',
        ]);
    });

    it('applies Agent-scoped native visibility without fabricating fallback rows', () => {
        const hiddenKey = serializeModelVisibilityRefV1({
            scope: 'agent',
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'hidden-native',
        });
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
        const values = (allowAutomatic: boolean) => buildSessionModelPickerSections({ declarationContext: { kind: 'account' },
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
