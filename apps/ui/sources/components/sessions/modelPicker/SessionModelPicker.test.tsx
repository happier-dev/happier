import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import {
    buildSessionModelPickerNotes,
    SessionModelPicker,
    type SessionModelPickerExperimentalConfirmationController,
} from './SessionModelPicker';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';

/**
 * Committing a freeform model id is a SUBMIT, not a keystroke: the overlay's custom
 * input only stores the draft on change and commits on `onSubmitEditing`/blur. A test
 * that stopped at `changeText` asserted the binding without ever exercising it.
 */
function submitCustomModelValue(screen: Readonly<{
    findByTestId: (testID: string) => { props: Record<string, unknown> } | null;
}>): void {
    const input = screen.findByTestId('model-picker-overlay-custom-input');
    const onSubmitEditing = input?.props.onSubmitEditing;
    if (typeof onSubmitEditing !== 'function') {
        throw new Error('Custom model input is not wired for submit');
    }
    act(() => { (onSubmitEditing as () => void)(); });
}

describe('SessionModelPicker', () => {
    it('keeps selection styling on the requested model and marks the reported runtime model separately', async () => {
        const requested = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'gpt-5.6-sol',
        } as const;
        const reported = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'gpt-5.6-terra',
        } as const;
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[
                    { value: 'gpt-5.6-terra', label: '5.6 Terra' },
                    { value: 'gpt-5.6-sol', label: '5.6 Sol' },
                ]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={requested}
                effectiveLabel="5.6 Sol"
                reportedModel={{ ref: reported, status: 'last_used' }}
                onSelect={() => {}}
            />,
        );

        expect(screen.findByType(SelectionList).props.selectedOptionId).toBe(
            JSON.stringify([requested.agentTargetKey, requested.providerConnectionId, requested.modelId]),
        );
        expect(screen.findByTestId(
            `model-picker-overlay-option-selected-indicator:${JSON.stringify([
                requested.agentTargetKey,
                requested.providerConnectionId,
                requested.modelId,
            ])}`,
        )).toBeTruthy();
        expect(screen.findByTestId(
            `model-picker-overlay-option-selected-indicator:${JSON.stringify([
                reported.agentTargetKey,
                reported.providerConnectionId,
                reported.modelId,
            ])}`,
        )).toBeNull();
        const reportedIcon = screen.findByTestId(
            `model-picker-overlay-option-status-icon:${JSON.stringify([
                reported.agentTargetKey,
                reported.providerConnectionId,
                reported.modelId,
            ])}`,
        );
        expect(reportedIcon).toBeTruthy();
        expect(reportedIcon?.findByProps({ name: 'clock' })).toBeTruthy();
        expect(screen.findByTestId(
            `model-picker-overlay-option-icon:${JSON.stringify([
                reported.agentTargetKey,
                reported.providerConnectionId,
                reported.modelId,
            ])}`,
        )).toBeNull();
        expect(screen.getTextContent()).toContain('Last used: 5.6 Terra');
    });

    it('explains connected-service suppression without changing selection identity', () => {
        const connectionId = ProviderConnectionIdSchema.parse('pc_suppression');
        expect(buildSessionModelPickerNotes({
            notes: ['Existing'],
            groups: [{ connectionId, suppressedConnectedServiceIds: ['openai-codex'] }],
            selected: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'm' },
            suppressionNote: 'Native sign-in is not used.',
        })).toEqual(['Existing', 'Native sign-in is not used.']);
    });

    it('gives experimental confirmation ownership of the exact selection commit', async () => {
        const connectionId = ProviderConnectionIdSchema.parse('pc_experimental');
        const selected = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: connectionId,
            modelId: 'experimental-model',
        } as const;
        const providerGroups = [{
            connectionId,
            providerName: 'Gateway',
            connectionName: 'Work',
            connectionRole: 'named' as const,
            connectionDisplayNameMode: 'custom' as const,
            connectionRevision: 3,
            authorization: { authorized: true as const },
            manualModelPolicy: 'catalog-only' as const,
            supportsFreeformModelIds: false,
            suppressedConnectedServiceIds: [],
            modelLoadAction: 'descriptor_absent' as const,
            rows: [{
                ref: selected,
                descriptor: { id: selected.modelId, name: 'Experimental model' },
                sources: { manual: false, static: true, probe: false },
                confidence: 'verified_static' as const,
                compatibility: {
                    result: {
                        status: 'experimental' as const,
                        selectedProtocol: 'openai-responses' as const,
                        reasons: ['compatibility_evidence_missing' as const],
                        confirmationScope: { kind: 'model' as const, modelId: selected.modelId },
                    },
                    compatibilityFingerprint: 'compatibility:v1:experimental',
                    confirmed: false,
                },
                endpointHealth: 'available' as const,
                catalog: { stale: false },
                loadState: 'unknown' as const,
                visibility: 'visible' as const,
            }],
        }];
        const onSelect = vi.fn();
        const confirm = vi.fn<SessionModelPickerExperimentalConfirmationController['confirm']>(async () => true);
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[]}
                providerGroups={providerGroups}
                providerProjectionAuthoritative
                selected={null}
                effectiveLabel="Automatic"
                experimentalConfirmation={{
                    confirm,
                    pending: false,
                    error: null,
                    retry: null,
                    clear: vi.fn(),
                }}
                onSelect={onSelect}
            />,
        );

        await screen.pressByTestIdAsync(`model-picker-overlay-option:${JSON.stringify([
            selected.agentTargetKey,
            connectionId,
            selected.modelId,
        ])}`);

        expect(confirm).toHaveBeenCalledOnce();
        const commitSelection = confirm.mock.calls[0]?.[1];
        expect(commitSelection).toBeTypeOf('function');
        expect(onSelect).not.toHaveBeenCalled();

        act(() => commitSelection?.());

        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith(selected);
    });

    it('emits an exact native structured ref for native freeform entry', async () => {
        const onSelect = vi.fn();
        const clear = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[{ value: 'default', label: 'Automatic' }]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={null}
                effectiveLabel="Automatic"
                canEnterCustomNativeValue
                experimentalConfirmation={{
                    confirm: vi.fn(async () => false),
                    pending: false,
                    error: createProviderErrorV1('provider_endpoint_unavailable'),
                    retry: vi.fn(async () => false),
                    clear,
                }}
                onSelect={onSelect}
            />,
        );
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        act(() => screen.changeTextByTestId('model-picker-overlay-custom-input', 'native-unlisted'));
        submitCustomModelValue(screen);
        expect(onSelect).toHaveBeenCalledWith({
            agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'native-unlisted',
        });
        expect(clear).toHaveBeenCalledOnce();
    });

    const freeformProviderGroup = (freeformPolicy: Readonly<{
        manualModelPolicy: 'allowed' | 'catalog-only';
        supportsFreeformModelIds: boolean;
    }>) => {
        const connectionId = ProviderConnectionIdSchema.parse('pc_freeform');
        const selected = { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'listed' } as const;
        return {
            connectionId,
            selected,
            group: {
                connectionId, providerName: 'Gateway', connectionName: 'Work',
                connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const, connectionRevision: 1,
                authorization: { authorized: true as const },
                manualModelPolicy: freeformPolicy.manualModelPolicy,
                supportsFreeformModelIds: freeformPolicy.supportsFreeformModelIds,
                suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent' as const,
                rows: [{
                    ref: selected, descriptor: { id: 'listed', name: 'Listed' },
                    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static' as const,
                    compatibility: {
                        result: { status: 'verified' as const, selectedProtocol: 'openai-responses' as const, evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' } },
                        compatibilityFingerprint: 'compatibility:v1:freeform', confirmed: true,
                    },
                    endpointHealth: 'available' as const, catalog: { stale: false }, loadState: 'unknown' as const, visibility: 'visible' as const,
                }],
            },
        };
    };

    it('binds freeform entry to the exact selected Provider connection', async () => {
        const { connectionId, selected, group } = freeformProviderGroup({
            manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
        });
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[]}
                providerGroups={[group]}
                providerProjectionAuthoritative
                selected={selected}
                effectiveLabel="Listed"
                onSelect={onSelect}
            />,
        );
        await screen.pressByTestIdAsync('model-picker-overlay-custom');
        act(() => screen.changeTextByTestId('model-picker-overlay-custom-input', 'provider/unlisted'));
        submitCustomModelValue(screen);
        expect(onSelect).toHaveBeenCalledWith({
            agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'provider/unlisted',
        });
    });

    // Offering the entry is a promise the launch owner has to keep: an id the
    // two-sided policy refuses is rejected at spawn as `provider_model_not_found`,
    // so the picker must not offer custom entry when either side is closed.
    it.each([
        ['the Provider refuses manual ids', { manualModelPolicy: 'catalog-only' as const, supportsFreeformModelIds: true }],
        ['the Agent refuses unverifiable ids', { manualModelPolicy: 'allowed' as const, supportsFreeformModelIds: false }],
    ])('offers no freeform entry on the selected connection when %s', async (_label, freeformPolicy) => {
        const { selected, group } = freeformProviderGroup(freeformPolicy);
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[]}
                providerGroups={[group]}
                providerProjectionAuthoritative
                selected={selected}
                effectiveLabel="Listed"
                onSelect={() => {}}
            />,
        );

        expect(screen.findAllByProps({ testID: 'model-picker-overlay-custom' })).toHaveLength(0);
    });

    it('does not guess a freeform target when multiple Provider connections are eligible', async () => {
        const makeGroup = (connectionId: string) => ({
            connectionId: ProviderConnectionIdSchema.parse(connectionId),
            providerName: 'Gateway', connectionName: connectionId,
            connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const, connectionRevision: 1,
            authorization: { authorized: true as const }, manualModelPolicy: 'allowed' as const,
            supportsFreeformModelIds: true, suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent' as const,
            rows: [],
        });
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[]}
                providerGroups={[makeGroup('pc_work'), makeGroup('pc_personal')]}
                providerProjectionAuthoritative
                selected={null}
                effectiveLabel="Automatic"
                onSelect={() => {}}
            />,
        );

        expect(screen.findAllByProps({ testID: 'model-picker-overlay-custom' })).toHaveLength(0);
    });

    it('presents a first-load Provider projection error through the canonical retry owner', async () => {
        const retryProjection = vi.fn(async () => {});
        const error = createProviderErrorV1('provider_endpoint_unreachable', {
            machineId: 'machine-a',
        });
        const selected = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_unreachable'),
            modelId: 'provider-only-model',
        } as const;
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[{ value: 'default', label: 'Automatic' }]}
                providerGroups={[]}
                providerProjectionAuthoritative={false}
                projectionError={error}
                retryProjection={retryProjection}
                selected={selected}
                effectiveLabel="provider-only-model"
                onSelect={() => {}}
            />,
        );

        const errorItems = screen.findByType(ProviderErrorItems.type);
        expect(errorItems.props.error).toBe(error);
        expect(errorItems.props.retry).toBeTypeOf('function');
        await act(async () => { await errorItems.props.retry(); });
        expect(retryProjection).toHaveBeenCalledOnce();
    });

    it('presents every connection refresh failure through the same retry owner', async () => {
        const retryProjection = vi.fn(async () => {});
        const failures = [
            {
                connectionId: ProviderConnectionIdSchema.parse('pc_secret'),
                error: createProviderErrorV1('provider_secret_missing', {
                    machineId: 'machine-a', connectionId: 'pc_secret',
                }),
            },
            {
                connectionId: ProviderConnectionIdSchema.parse('pc_endpoint'),
                error: createProviderErrorV1('provider_endpoint_unavailable', {
                    machineId: 'machine-a', connectionId: 'pc_endpoint',
                }),
            },
        ] as const;
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[]}
                providerGroups={[]}
                providerProjectionAuthoritative
                projectionFailures={failures}
                retryProjection={retryProjection}
                selected={null}
                effectiveLabel="Automatic"
                onSelect={() => {}}
            />,
        );

        const errorItems = screen.findAllByType(ProviderErrorItems.type);
        expect(errorItems.map((item) => item.props.error)).toEqual(failures.map((failure) => failure.error));
        await act(async () => { await errorItems[1]!.props.retry(); });
        expect(retryProjection).toHaveBeenCalledOnce();
    });

    it('projects exact favorites as the first canonical section and keeps unavailable favorites removable', async () => {
        const available = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'available',
        } as const;
        const unavailable = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_removed'),
            modelId: 'unavailable',
        } as const;
        const onToggleFavorite = vi.fn();
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[{ value: 'available', label: 'Available model' }]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={available}
                effectiveLabel="Available model"
                favoriteEntries={[
                    { ref: available, label: 'Stored available' },
                    { ref: unavailable, label: 'Stored unavailable' },
                ]}
                favoriteKeys={new Set([
                    JSON.stringify([available.agentTargetKey, available.providerConnectionId, available.modelId]),
                    JSON.stringify([unavailable.agentTargetKey, unavailable.providerConnectionId, unavailable.modelId]),
                ])}
                onToggleFavorite={onToggleFavorite}
                favoriteActionVisibility="all"
                onSelect={() => {}}
            />,
        );

        const rootStep = screen.findByType(SelectionList).props.rootStep;
        expect(rootStep.sections[0]).toMatchObject({
            id: 'favorites',
            title: 'Favorites',
            options: [
                { label: 'Available model', disabled: undefined },
                { label: 'Stored unavailable', disabled: true },
            ],
        });
        await screen.pressByTestIdAsync(
            `model-picker-overlay-option-favorite:${JSON.stringify([
                unavailable.agentTargetKey,
                unavailable.providerConnectionId,
                unavailable.modelId,
            ])}`,
        );
        expect(onToggleFavorite).toHaveBeenCalledWith(unavailable);
    });

    it('preserves the list scope when only experimental-confirmation state changes', async () => {
        await withPopoverWebGlobals(async () => {
            const nativeModels = Array.from({ length: 100 }, (_, index) => ({
                value: `model-${index}`,
                label: `Model ${index}`,
            }));
            const providerGroups = [] as const;
            const confirm = vi.fn(async () => false);
            const clear = vi.fn();
            const renderPicker = (pending: boolean) => (
                <SessionModelPicker
                    agentTargetKey="backend:codex"
                    nativeModels={nativeModels}
                    providerGroups={providerGroups}
                    providerProjectionAuthoritative
                    selected={null}
                    effectiveLabel={pending ? 'Checking confirmation' : 'Automatic'}
                    experimentalConfirmation={{
                        confirm,
                        pending,
                        error: null,
                        retry: null,
                        clear,
                    }}
                    onSelect={() => {}}
                />
            );
            const screen = await renderScreen(renderPicker(false));
            const rootStepBefore = screen.findByType(SelectionList).props.rootStep;

            await act(async () => {
                screen.tree.update(renderPicker(true));
            });

            expect(screen.findByType(SelectionList).props.rootStep).toBe(rootStepBefore);
        });
    });
});
