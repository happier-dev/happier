import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { ProviderModelManager, buildProviderModelManagerSections, buildProviderModelVisibilityChanges } from './ProviderModelManager';
import { providerModelRowKey } from './modelRowKey';

function group(
    modelCount = 1,
    rawConnectionId = 'pc_a',
    modelIdForIndex: (index: number) => string = (index) => `model-${index}`,
    modelLoadAction: 'available' | 'descriptor_absent' | 'feature_disabled' = 'available',
) {
    const connectionId = ProviderConnectionIdSchema.parse(rawConnectionId);
    return {
        connectionId, providerName: 'Gateway', connectionName: 'Work',
        connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const, connectionRevision: 2,
        authorization: { authorized: true as const }, manualModelPolicy: 'allowed' as const,
        supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: [],
        modelLoadAction,
        rows: Array.from({ length: modelCount }, (_, index) => ({
            ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: modelIdForIndex(index) },
            descriptor: { id: `model-${index}`, name: `Model ${index}` },
            sources: { manual: index === 0, static: index !== 0, probe: false },
            confidence: index === 0 ? 'manual' as const : 'verified_static' as const,
            compatibility: {
                result: {
                    status: 'verified' as const,
                    selectedProtocol: 'openai-chat' as const,
                    evidence: { sourceUrls: ['https://example.com/compatibility'], verifiedAt: '2026-07-13' },
                },
                compatibilityFingerprint: `compatibility:v1:${index}`, confirmed: true,
            },
            endpointHealth: 'available' as const, catalog: { stale: false }, loadState: 'unknown' as const,
            visibility: index === 0 ? 'hidden_all_agents' as const : 'visible' as const,
        })),
    };
}

describe('ProviderModelManager', () => {
    it('uses only Available, Hidden, and Manual sections while retaining connection identity in rows', () => {
        const projected = group(3);
        const groups = [{
            ...projected,
            rows: projected.rows.map((row, index) => index === 2
                ? { ...row, sources: { manual: true, static: false, probe: false } }
                : row),
        }];
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [
                { id: 'native-visible', name: 'Native Visible', hidden: false },
                { id: 'native-hidden', name: 'Native Hidden', hidden: true },
            ],
            groups,
            showHidden: true,
            onSetVisibility: () => {},
            onOpenConnection: () => {},
        });

        expect(sections.map((section) => section.title)).toEqual(['Available', 'Hidden', 'Manual']);
        expect(sections.map((section) => section.options.map((option) => option.label))).toEqual([
            ['Native Visible', 'Model 1'],
            ['Native Hidden', 'Model 0'],
            ['Model 2'],
        ]);
        expect(sections[0]?.options.find((option) => option.label === 'Model 1')?.subtitle)
            .toContain('Gateway · Work');
        expect(sections.map((section) => section.id)).not.toContain('current');
    });

    it('groups an agent list by source in picker order, keeping hidden models in their source and tagging the default', () => {
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [
                { id: 'native-visible', name: 'Native Visible', hidden: false },
                { id: 'native-hidden', name: 'Native Hidden', hidden: true },
            ],
            groups: [group(2, 'pc_a'), group(1, 'pc_b')],
            showHidden: false,
            onSetVisibility: () => {},
            grouping: {
                nativeTitle: 'Codex',
                nativeDescription: 'Codex’s own models.',
                connectionDescription: 'Shown in every agent that can run it.',
                defaultRef: { providerConnectionId: 'pc_a', modelId: 'model-1' },
            },
        });

        expect(sections.map((section) => section.id)).toEqual(['source:native', 'source:pc_a', 'source:pc_b']);
        // A hidden model stays in its source, switched off, instead of moving to a Hidden group.
        expect(sections.map((section) => section.options.map((option) => option.label))).toEqual([
            ['Native Visible', 'Native Hidden'],
            ['Model 0', 'Model 1'],
            ['Model 0'],
        ]);
        expect(sections[1]?.title).toBe('Gateway · Work');
        expect(sections[1]?.description).toBe('Shown in every agent that can run it.');
        // The source header names the connection once; its rows do not repeat it.
        expect(sections[1]?.options[1]?.subtitle ?? '').not.toContain('Gateway · Work');
        const isDefault = (option: (typeof sections)[number]['options'][number]) =>
            (option.rightAccessory as React.ReactElement<{ isDefault?: boolean }>).props.isDefault === true;
        expect(sections[1]?.options.map(isDefault)).toEqual([false, true]);
        expect(sections[2]?.options.map(isDefault)).toEqual([false]);
    });

    it('does not repeat the connection on every row of that connection\'s own list', () => {
        const [available] = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' },
            nativeModels: [],
            groups: [group(2)],
            showHidden: false,
            onSetVisibility: () => {},
        });
        const subtitle = available?.options.find((option) => option.label === 'Model 1')?.subtitle ?? '';
        expect(subtitle).toContain('model-1');
        expect(subtitle).not.toContain('Gateway · Work');
    });

    it('shows favorite stars only for exact Agent, source and model refs beside the default tag', async () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey },
            nativeModels: [{ id: 'model-1', name: 'Native model', hidden: false }],
            groups: [group(2, 'pc_a'), group(2, 'pc_b')],
            showHidden: true,
            onSetVisibility: () => {},
            grouping: {
                nativeTitle: 'Codex', nativeDescription: 'Native models', connectionDescription: 'Shown sources',
                defaultRef: { providerConnectionId: 'pc_a', modelId: 'model-1' },
                favoriteRefs: [
                    { agentTargetKey, providerConnectionId: 'pc_a', modelId: 'model-1' },
                    { agentTargetKey: 'agent:another.plugin/codex', providerConnectionId: 'pc_b', modelId: 'model-1' },
                ],
            },
        });
        const native = await renderScreen(sections[0]!.options[0]!.rightAccessory as React.ReactElement);
        const favorite = await renderScreen(sections[1]!.options[1]!.rightAccessory as React.ReactElement);
        const otherSource = await renderScreen(sections[2]!.options[1]!.rightAccessory as React.ReactElement);
        expect(favorite.getTextContent()).toContain('★');
        expect(favorite.findByTestId('provider-model-manager.default')).not.toBeNull();
        expect(native.getTextContent()).not.toContain('★');
        expect(otherSource.getTextContent()).not.toContain('★');
    });

    it('sets a default from the source row without changing model visibility', async () => {
        const onSetDefault = vi.fn();
        const onSetVisibility = vi.fn();
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [], groups: [group(2, 'pc_a'), group(2, 'pc_b')], showHidden: true,
            onSetVisibility,
            grouping: {
                nativeTitle: 'Codex', nativeDescription: 'Native models', connectionDescription: 'Shown sources',
                defaultRef: { providerConnectionId: 'pc_a', modelId: 'model-1' },
                onSetDefault,
            },
        });
        const selected = await renderScreen(sections[0]!.options[1]!.rightAccessory as React.ReactElement);
        expect(selected.findByTestId('provider-model-manager.set-default')).toBeNull();
        const other = await renderScreen(sections[1]!.options[1]!.rightAccessory as React.ReactElement);
        const control = other.findAllByTestId('provider-model-manager.set-default')
            .find(node => typeof node.props.onPress === 'function');
        expect(control).toBeDefined();
        await other.pressByTestId('provider-model-manager.set-default');
        expect(onSetDefault).toHaveBeenCalledWith({
            agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_b', modelId: 'model-1',
        });
        expect(onSetVisibility).not.toHaveBeenCalled();
    });

    it('announces the action each model row will perform, including connection identity', () => {
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [
                { id: 'native-visible', name: 'Native Visible', hidden: false },
                { id: 'native-hidden', name: 'Native Hidden', hidden: true },
            ],
            groups: [group(2)],
            showHidden: true,
            onSetVisibility: () => {},
            onOpenConnection: () => {},
        });
        const options = sections.flatMap((section) => section.options);

        expect(options.find((option) => option.id === 'native:native-visible')?.accessibilityLabel)
            .toContain('Hide model');
        expect(options.find((option) => option.id === 'native:native-hidden')?.accessibilityLabel)
            .toContain('Show model');
        expect(options.find((option) => option.label === 'Model 0')?.accessibilityLabel)
            .toContain('Hidden for all agents');
        expect(options.find((option) => option.label === 'Model 1')?.accessibilityLabel)
            .toBe('Model 1, Work, Hide model');
    });

    it('uses collision-safe visibility scopes and honestly omits hidden rows until requested', () => {
        const onSetVisibility = vi.fn();
        const onRemoveManualModel = vi.fn();
        const onShowOnly = vi.fn();
        const hidden = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [{ id: 'native-a', name: 'Native A', hidden: false }],
            groups: [group()], showHidden: false, onSetVisibility,
        });
        expect(hidden.flatMap((section) => section.options).map((row) => row.label)).toEqual(['Native A']);

        const shown = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' },
            nativeModels: [], groups: [group()], showHidden: true, onSetVisibility, onRemoveManualModel, onShowOnly,
        });
        const providerRow = shown[0]?.options[0];
        providerRow?.onSelect?.();
        expect(onSetVisibility).toHaveBeenCalledWith({
            scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'model-0',
        }, false);
        const accessory = providerRow?.rightAccessory;
        expect(React.isValidElement(accessory)).toBe(true);
        (accessory as React.ReactElement<{ onRemove?: () => void }>).props.onRemove?.();
        expect(onRemoveManualModel).toHaveBeenCalledWith('pc_a', 'model-0');
        (accessory as React.ReactElement<{ onShowOnly?: () => void }>).props.onShowOnly?.();
        expect(onShowOnly).toHaveBeenCalledWith({
            scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'model-0',
        });
    });

    it('does not offer show-only for a row locked by all-agent visibility', () => {
        const onShowOnly = vi.fn();
        const onOpenConnection = vi.fn();
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [], groups: [group()], showHidden: true,
            onSetVisibility: () => {}, onShowOnly, onOpenConnection,
        });

        const accessory = sections[0]?.options[0]?.rightAccessory as React.ReactElement<{ onShowOnly?: () => void }>;
        expect(accessory.props.onShowOnly).toBeUndefined();
        expect(sections[0]?.options[0]?.disabled).toBe(false);
        sections[0]?.options[0]?.onSelect?.();
        expect(onOpenConnection).toHaveBeenCalledWith('pc_a');
        expect(onShowOnly).not.toHaveBeenCalled();
    });

    it('leaves 5,000-row virtualization to the canonical automatic SelectionList policy', () => {
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' }, nativeModels: [], groups: [group(5_000)],
            showHidden: true, onSetVisibility: () => {},
        });
        expect(sections.flatMap((section) => section.options)).toHaveLength(5_000);
        expect(sections.every((section) => section.virtualization === 'auto')).toBe(true);
    });

    it('uses collision-safe option identities when connection and model ids contain delimiters', () => {
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [],
            groups: [
                group(1, 'a:b', () => 'c'),
                group(1, 'a', () => 'b:c'),
            ],
            showHidden: true,
            onSetVisibility: () => {},
        });
        const ids = sections.flatMap((section) => section.options.map((option) => option.id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('offers Load only for an unloaded model with an authorized descriptor-backed action', () => {
        const onLoadModel = vi.fn();
        const available = group(1);
        const unloaded = {
            ...available,
            rows: available.rows.map((row) => ({ ...row, loadState: 'unloaded' as const })),
        };
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' }, nativeModels: [], groups: [unloaded],
            showHidden: true, onSetVisibility: () => {}, onLoadModel,
        });
        const accessory = sections[0]?.options[0]?.rightAccessory as React.ReactElement<{ onLoad?: () => void }>;
        expect(sections[0]?.options[0]?.subtitle).toContain('Not loaded');
        accessory.props.onLoad?.();
        expect(onLoadModel).toHaveBeenCalledWith('pc_a', 'model-0');

        const unavailable = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' }, nativeModels: [],
            groups: [{ ...unloaded, modelLoadAction: 'feature_disabled' as const }],
            showHidden: true, onSetVisibility: () => {}, onLoadModel,
        });
        expect((unavailable[0]?.options[0]?.rightAccessory as React.ReactElement<{ onLoad?: () => void }>).props.onLoad).toBeUndefined();
    });

    it('uses the shared row truth for exact ids and endpoint health', () => {
        const unavailable = group(1);
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' },
            nativeModels: [],
            groups: [{
                ...unavailable,
                rows: unavailable.rows.map((row) => ({
                    ...row,
                    descriptor: { ...row.descriptor, description: 'Useful description' },
                    endpointHealth: 'unreachable' as const,
                })),
            }],
            showHidden: true,
            onSetVisibility: () => {},
        });

        expect(sections[0]?.options[0]?.subtitle).toContain('model-0');
        expect(sections[0]?.options[0]?.subtitle).toContain('Unreachable');
    });

    it('qualifies every separately focusable model accessory action with the model identity', async () => {
        const available = group(1);
        const unloaded = {
            ...available,
            rows: available.rows.map((row) => ({ ...row, loadState: 'unloaded' as const })),
        };
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' },
            nativeModels: [],
            groups: [unloaded],
            showHidden: true,
            onSetVisibility: () => {},
            onRemoveManualModel: () => {},
            onShowOnly: () => {},
            onLoadModel: () => {},
        });
        const accessory = sections[0]?.options[0]?.rightAccessory;
        expect(React.isValidElement(accessory)).toBe(true);

        const screen = await renderScreen(accessory as React.ReactElement);
        expect(screen.findAllByTestId('provider-model-manager.load')[0]?.props.accessibilityLabel)
            .toBe('Model 0, Gateway · Work, Load model');
        expect(screen.findAllByTestId('provider-model-manager.show-only')[0]?.props.accessibilityLabel)
            .toBe('Model 0, Gateway · Work, Show only this model');
        expect(screen.findAllByTestId('provider-model-manager.remove')[0]?.props.accessibilityLabel)
            .toBe('Model 0, Gateway · Work, Remove model');
    });

    it('replaces the exact loading row action with an accessible cancel control', async () => {
        const available = group(1);
        const unloaded = {
            ...available,
            rows: available.rows.map((row) => ({ ...row, loadState: 'unloaded' as const })),
        };
        const onCancelModelLoad = vi.fn();
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'connection', connectionId: 'pc_a' },
            nativeModels: [],
            groups: [unloaded],
            showHidden: true,
            onSetVisibility: () => {},
            onLoadModel: () => {},
            onCancelModelLoad,
            loadingModelKey: providerModelRowKey('pc_a', 'model-0'),
        });
        const accessory = sections[0]?.options[0]?.rightAccessory;
        expect(React.isValidElement(accessory)).toBe(true);

        const screen = await renderScreen(accessory as React.ReactElement);
        expect(screen.findAllByTestId('provider-model-manager.load')).toHaveLength(0);
        const cancel = screen.findAllByTestId('provider-model-manager.cancel-load')[0];
        expect(cancel?.props.accessibilityLabel)
            .toBe('Model 0, Gateway · Work, Cancel load');
        await cancel?.props.onPress?.();
        expect(onCancelModelLoad).toHaveBeenCalledOnce();
    });

    it('builds one exact atomic visibility change set for show all, hide all, and show only', () => {
        const groups = [group(2, 'pc_a', (index) => index === 0 ? 'same' : 'other')];
        const input = {
            scope: { kind: 'agent' as const, agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [{ id: 'same', name: 'Native same', hidden: false }],
            groups,
        };
        const showAll = buildProviderModelVisibilityChanges({ ...input, action: 'showAll' });
        expect(showAll).toHaveLength(3);
        expect(showAll.every((change) => change.hidden === false)).toBe(true);

        const hideAll = buildProviderModelVisibilityChanges({ ...input, action: 'hideAll' });
        expect(hideAll.every((change) => change.hidden === true)).toBe(true);

        const selected = {
            scope: 'agent' as const,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'),
            modelId: 'same',
        };
        const showOnly = buildProviderModelVisibilityChanges({ ...input, action: 'showOnly', selected });
        expect(showOnly).toEqual(expect.arrayContaining([
            { ref: selected, hidden: false },
            { ref: expect.objectContaining({ providerConnectionId: null, modelId: 'same' }), hidden: true },
            { ref: expect.objectContaining({ providerConnectionId: 'pc_a', modelId: 'other' }), hidden: true },
        ]));
    });

    it('exposes explicit accessible bulk toolbar actions', async () => {
        const onShowAll = vi.fn();
        const onHideAll = vi.fn();
        const onResetVisibility = vi.fn();
        const screen = await renderScreen(
            <ProviderModelManager
                scope={{ kind: 'connection', connectionId: 'pc_a' }}
                nativeModels={[]}
                groups={[group()]}
                showHidden
                onSetVisibility={() => {}}
                onShowAll={onShowAll}
                onHideAll={onHideAll}
                onResetVisibility={onResetVisibility}
                onRequestClose={() => {}}
            />,
        );
        screen.pressByTestId('provider-model-manager.show-all');
        screen.pressByTestId('provider-model-manager.hide-all');
        screen.pressByTestId('provider-model-manager.reset');
        expect(onShowAll).toHaveBeenCalledTimes(1);
        expect(onHideAll).toHaveBeenCalledTimes(1);
        expect(onResetVisibility).toHaveBeenCalledTimes(1);
    });
});
