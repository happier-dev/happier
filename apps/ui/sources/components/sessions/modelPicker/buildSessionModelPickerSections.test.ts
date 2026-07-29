import { describe, expect, it } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema, serializeModelVisibilityRefV1 } from '@happier-dev/protocol';

import {
    buildSessionModelPickerSections,
    hiddenModelVisibilityKeys,
} from './buildSessionModelPickerSections';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { t } from '@/text';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

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
            ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: input.modelId },
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
    it('fails closed to native parity when the Providers feature decision is not enabled', () => {
        const hiddenKey = serializeModelVisibilityRefV1({
            scope: 'agent',
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'hidden-native',
        });
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'hidden-native',
        } as const;
        const hiddenKey = serializeModelVisibilityRefV1({
            scope: 'agent',
            ...selected,
        });
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_loading'),
            modelId: 'pending-model',
        };
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_deleted'),
            modelId: 'missing-model',
        };
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'backend:codex',
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
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_recovery'),
            modelId: 'missing-model',
        };
        const error = createProviderErrorV1(code, {
            connectionId: selected.providerConnectionId,
            machineId: 'machine-a',
        });
        const sections = buildSessionModelPickerSections({
            agentTargetKey: 'backend:codex',
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
});
