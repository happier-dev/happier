import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import {
    createProviderErrorV1,
    ProviderConnectionIdSchema,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { SessionModelProjectionGroup } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedPickerProps = Readonly<{
    agentTargetKey: string;
    nativeModels: readonly unknown[];
    selected: ProviderBoundModelRef | null;
    showTitle?: boolean;
    maxHeight?: number;
    heightBehavior?: string;
    autoFocusInputOnWeb?: boolean;
    onRequestClose?: () => void;
    onSelect: (ref: ProviderBoundModelRef | null) => void;
    favoriteEntries?: readonly Readonly<{ ref: ProviderBoundModelRef }>[];
    favoriteKeys?: ReadonlySet<string>;
    favoriteActionVisibility?: string;
    onToggleFavorite?: (ref: ProviderBoundModelRef) => void;
}>;

const captured = vi.hoisted(() => ({
    pickerProps: null as CapturedPickerProps | null,
}));

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/sessions/modelPicker/SessionModelPicker', () => ({
    SessionModelPicker: (props: Record<string, unknown>) => {
        // The mock captures only the public picker props exercised by this adapter contract.
        captured.pickerProps = props as CapturedPickerProps;
        return React.createElement('SessionModelPicker', props);
    },
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: {
        open: boolean;
        content: React.ReactNode | ((args: { maxHeight: number; requestClose: () => void }) => React.ReactNode);
        onRequestClose: () => void;
    }) => props.open
        ? React.createElement(
            'AgentInputContentPopover',
            props,
            typeof props.content === 'function'
                ? props.content({ maxHeight: 312, requestClose: props.onRequestClose })
                : props.content,
        )
        : null,
}));

const { NewSessionModelSelectionContent } = await import('./NewSessionModelSelectionContent');
const CODEX_BACKEND_ENTRY: ResolvedBackendCatalogEntry = {
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    backendTargetKey: 'backend:codex',
    kind: 'builtInAgent',
    backendId: 'codex',
    agentId: 'codex',
    catalogAgentId: 'codex',
    builtInAgentId: 'codex',
    iconAgentId: 'codex',
    title: 'Codex',
    subtitle: 'Codex',
};

function requirePickerProps(): CapturedPickerProps {
    if (!captured.pickerProps) throw new Error('Expected SessionModelPicker to render');
    return captured.pickerProps;
}

function sameModelProviderGroup(input: Readonly<{
    connectionId: string;
    connectionName: string;
}>): SessionModelProjectionGroup {
    const connectionId = ProviderConnectionIdSchema.parse(input.connectionId);
    return {
        connectionId,
        providerName: 'Gateway',
        connectionName: input.connectionName,
        connectionRole: 'named',
        connectionDisplayNameMode: 'custom',
        connectionRevision: 1,
        authorization: { authorized: true },
        manualModelPolicy: 'allowed',
        supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: [],
        modelLoadAction: 'descriptor_absent',
        rows: [{
            ref: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: connectionId,
                modelId: 'shared-provider-model',
            },
            descriptor: {
                id: 'shared-provider-model',
                name: 'Shared Provider model',
            },
            sources: { manual: false, static: true, probe: false },
            confidence: 'verified_static',
            compatibility: {
                result: {
                    status: 'verified',
                    selectedProtocol: 'openai-responses',
                    evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-26' },
                },
                compatibilityFingerprint: `compatibility:v1:${input.connectionId}`,
                confirmed: true,
            },
            endpointHealth: 'available',
            catalog: { stale: false },
            loadState: 'unknown',
            visibility: 'visible',
        }],
    };
}

describe('NewSessionModelSelectionContent', () => {
    it('fails closed instead of projecting a fake target while backend identity is unavailable', async () => {
        captured.pickerProps = null;
        await renderScreen(
            <NewSessionModelSelectionContent
                providerProjectionAuthoritative={false}
                modelOptions={[{ value: 'model-a', label: 'Model A', description: '' }]}
                selectedModelId="model-a"
                selectedIndicatorColor="#fff"
                onSelectModel={() => {}}
            />,
        );

        expect(requirePickerProps()).toMatchObject({
            agentTargetKey: '',
            nativeModels: [],
            selected: null,
        });
    });

    it('opens the compact canonical picker with the popover-owned list height contract', async () => {
        captured.pickerProps = null;
        const screen = await renderScreen(
            <NewSessionModelSelectionContent
                presentation="compact"
                providerProjectionAuthoritative
                modelOptions={[
                    { value: 'default', label: 'Use CLI settings', description: '' },
                    { value: 'model-a', label: 'Model A', description: 'A model' },
                ]}
                selectedModelId="model-a"
                selectedIndicatorColor="#fff"
                selectedBackendEntry={CODEX_BACKEND_ENTRY}
                onSelectModel={() => {}}
            />,
        );

        const trigger = screen.findAll((row) => (
            row.props.testID === 'new-session-model-dropdown-trigger'
            && row.props.title === 'newSession.selectModelTitle'
            && typeof row.props.onPress === 'function'
        )).at(-1);
        expect(trigger?.props.subtitle).toBe('Model A');
        expect(trigger?.props.detail).toBeUndefined();
        expect(captured.pickerProps).toBeNull();

        await screen.pressByTestIdAsync('new-session-model-dropdown-trigger');

        expect(requirePickerProps()).toMatchObject({
            showTitle: false,
            maxHeight: 312,
            heightBehavior: undefined,
            autoFocusInputOnWeb: true,
        });
        expect(typeof requirePickerProps().onRequestClose).toBe('function');
    });

    it('keeps the exact Provider connection distinguishable in the closed compact summary', async () => {
        captured.pickerProps = null;
        const work = sameModelProviderGroup({
            connectionId: 'pc_work',
            connectionName: 'Work',
        });
        const personal = sameModelProviderGroup({
            connectionId: 'pc_personal',
            connectionName: 'Personal',
        });
        const selected = personal.rows[0]!.ref;
        const screen = await renderScreen(
            <NewSessionModelSelectionContent
                presentation="compact"
                providerProjectionAuthoritative
                modelOptions={[{
                    value: 'shared-provider-model',
                    label: 'Native shared model',
                    description: '',
                }]}
                selectedModelId="shared-provider-model"
                selectedModelSelection={{ v: 1, updatedAt: 1, ref: selected }}
                selectedIndicatorColor="#fff"
                selectedBackendEntry={CODEX_BACKEND_ENTRY}
                providerGroups={[work, personal]}
                onSelectModel={() => {}}
            />,
        );

        const trigger = screen.findAll((row) => (
            row.props.testID === 'new-session-model-dropdown-trigger'
            && row.props.title === 'newSession.selectModelTitle'
            && typeof row.props.onPress === 'function'
        )).at(-1);
        expect(trigger?.props.subtitle).toBe('Shared Provider model');
        expect(trigger?.props.detail).toContain('Personal');
        expect(trigger?.props.detail).not.toContain('Work');
        expect(trigger?.props.accessibilityLabel).toBe(
            'newSession.selectModelTitle. Gateway, Personal, Shared Provider model',
        );
    });

    it('keeps a missing exact Provider selection truthful in the closed compact summary', async () => {
        captured.pickerProps = null;
        const selected = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_deleted'),
            modelId: 'missing-model',
        };
        const screen = await renderScreen(
            <NewSessionModelSelectionContent
                presentation="compact"
                providerProjectionAuthoritative
                modelOptions={[]}
                selectedModelId="missing-model"
                selectedModelSelection={{ v: 1, updatedAt: 1, ref: selected }}
                selectedIndicatorColor="#fff"
                selectedBackendEntry={CODEX_BACKEND_ENTRY}
                providerGroups={[]}
                currentSelectionRecovery={{
                    kind: 'connection_deleted',
                    ref: selected,
                    error: createProviderErrorV1('provider_connection_not_found', {
                        connectionId: selected.providerConnectionId,
                    }),
                    displaySnapshot: {
                        providerName: 'Gateway',
                        connectionName: 'Retired connection',
                        modelName: 'Previous model',
                    },
                }}
                onSelectModel={() => {}}
            />,
        );

        const trigger = screen.findAll((row) => (
            row.props.testID === 'new-session-model-dropdown-trigger'
            && row.props.title === 'newSession.selectModelTitle'
            && typeof row.props.onPress === 'function'
        )).at(-1);
        expect(trigger?.props.subtitle).toBe('Previous model');
        expect(trigger?.props.detail).toBe('settingsProviders.errors.notFoundDescription');
        expect(trigger?.props.accessibilityLabel).toBe(
            'newSession.selectModelTitle. Gateway, Retired connection, Previous model. settingsProviders.errors.notFoundDescription',
        );
    });

    it('forwards one exact Provider selection through the canonical picker and closes compact presentation', async () => {
        captured.pickerProps = null;
        vi.useFakeTimers();
        const onSelectSelection = vi.fn();
        const connectionId = ProviderConnectionIdSchema.parse('pc_work');
        const ref = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: connectionId,
            modelId: 'shared-id',
        };
        const screen = await renderScreen(
            <NewSessionModelSelectionContent
                presentation="compact"
                providerProjectionAuthoritative
                modelOptions={[{ value: 'shared-id', label: 'Native shared id', description: '' }]}
                selectedModelId="default"
                selectedIndicatorColor="#fff"
                selectedBackendEntry={CODEX_BACKEND_ENTRY}
                providerGroups={[]}
                onSelectModel={() => {}}
                onSelectSelection={onSelectSelection}
            />,
        );

        await screen.pressByTestIdAsync('new-session-model-dropdown-trigger');
        act(() => requirePickerProps().onSelect(ref));
        expect(onSelectSelection).toHaveBeenCalledWith(ref);
        expect(screen.tree.root.findAllByType('AgentInputContentPopover')).toHaveLength(1);

        await act(async () => {
            vi.runAllTimers();
        });
        expect(screen.tree.root.findAllByType('AgentInputContentPopover')).toHaveLength(0);
        vi.useRealTimers();
    });

    it('keeps native and Provider same-id favorites distinct and delegates exact toggles to the stored owner', async () => {
        captured.pickerProps = null;
        const onFavoriteModelSelectionsChange = vi.fn();
        const providerFavorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 123,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'shared-id',
                },
            },
            modelLabel: 'Provider shared id',
        });
        await renderScreen(
            <NewSessionModelSelectionContent
                providerProjectionAuthoritative
                modelOptions={[{ value: 'shared-id', label: 'Native shared id', description: '' }]}
                selectedModelId="default"
                selectedIndicatorColor="#fff"
                selectedBackendEntry={CODEX_BACKEND_ENTRY}
                providerGroups={[]}
                favoriteModelSelections={[providerFavorite]}
                onFavoriteModelSelectionsChange={onFavoriteModelSelectionsChange}
                onSelectModel={() => {}}
            />,
        );

        expect(requirePickerProps().favoriteEntries).toHaveLength(1);
        expect(requirePickerProps().favoriteKeys).toEqual(new Set([
            sessionModelSelectionKey(providerFavorite.selection.ref),
        ]));
        expect(requirePickerProps().favoriteActionVisibility).toBe('all');

        act(() => requirePickerProps().onToggleFavorite?.(providerFavorite.selection.ref));
        expect(onFavoriteModelSelectionsChange).toHaveBeenCalledWith([]);
    });
});
