import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { renderScreen } from '@/dev/testkit';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { renderSelectionListAccessory } from '@/components/ui/selectionList';
import { Switch } from '@/components/ui/forms/Switch';
import { ProviderModelManager, buildProviderModelManagerSections, buildProviderModelVisibilityChanges, type ProviderModelManagerGroup } from './ProviderModelManager';
import { providerModelRowKey } from './modelRowKey';
import { MODEL_ROWS_PER_SEGMENT } from './ProviderModelManagerPage';

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
    it('does not claim a per-model hidden favorite stays visible in an off source', () => {
        const projected = group(1);
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [], groups: [projected], showHidden: true, onSetVisibility: () => {},
            grouping: { nativeTitle: 'Codex', nativeDescription: 'Native models', defaultRef: null, connectionDescription: 'Shown sources',
                favoriteRefs: [projected.rows[0]!.ref], isSourceShown: () => false },
        });
        expect(sections.find(section => section.id === 'source:pc_a')?.options).toEqual([]);
    });
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
        // The Default tag stands beside the model's name, not among its controls.
        const isDefault = (option: (typeof sections)[number]['options'][number]) => option.titleAccessory != null;
        expect(sections[1]?.options.map(isDefault)).toEqual([false, true]);
        expect(sections[2]?.options.map(isDefault)).toEqual([false]);
    });

    it('groups connection-neutral catalog rows without inventing Agent compatibility status', () => {
        const source: ProviderModelManagerGroup = {
            connectionId: 'pc_a', providerName: 'Gateway', connectionName: 'Work',
            connectionRole: 'named', connectionDisplayNameMode: 'custom', modelLoadAction: 'descriptor_absent',
            rows: [{ ref: { modelId: 'catalog-model' }, descriptor: { id: 'catalog-model', name: 'Catalog model' },
                sources: { manual: false, static: true, probe: false }, catalog: { stale: false },
                loadState: 'unknown', visibility: 'visible' }],
        };
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex' },
            nativeModels: [], groups: [source], showHidden: false, onSetVisibility: () => {},
            grouping: { nativeTitle: 'Codex', nativeDescription: 'Native models',
                connectionDescription: 'Shown sources', defaultRef: null },
        });

        expect(sections[0]?.title).toBe('Gateway · Work');
        expect(sections[0]?.description).toBe('Shown sources');
        expect(sections[0]?.options.map(option => option.label)).toEqual(['Catalog model']);
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
                    { agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'), modelId: 'model-1' },
                    { agentTargetKey: 'agent:another.plugin/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_b'), modelId: 'model-1' },
                ],
            },
        });
        const native = await renderScreen(sections[0]!.options[0]!.rightAccessory as React.ReactElement);
        const favorite = await renderScreen(sections[1]!.options[1]!.rightAccessory as React.ReactElement);
        const otherSource = await renderScreen(sections[2]!.options[1]!.rightAccessory as React.ReactElement);
        const defaultTitle = await renderScreen(
            <>{renderSelectionListAccessory(sections[1]!.options[1]!.titleAccessory)}</>,
        );
        expect(favorite.findByTestId('provider-model-manager.favorite')).not.toBeNull();
        expect(defaultTitle.findByTestId('provider-model-manager.default')).not.toBeNull();
        expect(favorite.findByTestId('provider-model-manager.default')).toBeNull();
        expect(native.findByTestId('provider-model-manager.favorite')).toBeNull();
        expect(otherSource.findByTestId('provider-model-manager.favorite')).toBeNull();
    });

    it('keeps agent rows to one line with a pinnable star, and collapses a source longer than a page segment', async () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const onToggleFavorite = vi.fn();
        const onOpenConnection = vi.fn();
        const small = group(2, 'pc_a');
        const long = group(MODEL_ROWS_PER_SEGMENT + 1, 'pc_b');
        const withCatalogFacts = (source: ReturnType<typeof group>) => ({
            ...source,
            rows: source.rows.map((row) => ({
                ...row,
                descriptor: { ...row.descriptor, description: 'A long catalog description', contextWindowTokens: 200_000 },
                visibility: 'visible' as const,
            })),
        });
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey },
            nativeModels: [{ id: 'native-1', name: 'Native', description: 'Native description', hidden: false }],
            groups: [withCatalogFacts(small), withCatalogFacts(long)],
            showHidden: true,
            onSetVisibility: () => {},
            onOpenConnection,
            grouping: {
                nativeTitle: 'Codex', nativeDescription: 'Native models', connectionDescription: 'Shown sources',
                defaultRef: null,
                favoriteRefs: [{ agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('pc_b'), modelId: 'model-3' }],
                onToggleFavorite,
            },
        });
        const [native, shown, collapsed] = sections;
        // A row is its name and controls: no id or catalog description under it.
        expect(native!.options[0]!.subtitle).toBeUndefined();
        expect(shown!.options.map((option) => option.subtitle)).toEqual([undefined, undefined]);

        const row = await renderScreen(shown!.options[0]!.rightAccessory as React.ReactElement);
        expect(row.getTextContent()).toContain('200k');
        // The star is a control on every row, not only a mark on pinned ones.
        const star = row.findByTestId('provider-model-manager.favorite')!;
        await star.props.onPress();
        expect(onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({
            ref: { agentTargetKey, providerConnectionId: 'pc_a', modelId: 'model-0' },
            providerDisplaySnapshot: expect.objectContaining({ providerName: 'Gateway', connectionName: 'Work' }),
        }));

        // The long source lists only what the picker pins and leads to its own page.
        expect(collapsed!.options.map((option) => option.id)).toEqual([providerModelRowKey('pc_b', 'model-3')]);
        expect(collapsed!.footerAction?.label).toBe(`Browse ${MODEL_ROWS_PER_SEGMENT + 1} models`);
        collapsed!.footerAction?.onPress();
        expect(onOpenConnection).toHaveBeenCalledWith('pc_b');
        expect(shown!.footerAction).toBeUndefined();
    });

    it('says an Account-view source needs a computer once in its header, never per row', async () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const projected = group(2, 'pc_a');
        const accountView = {
            ...projected,
            modelLoadAction: 'machine_required' as const,
            authorization: { authorized: false as const, error: createProviderErrorV1('provider_machine_unavailable') },
            rows: projected.rows.map((row) => ({
                ...row,
                confidence: 'account_unverified' as const,
                visibility: 'visible' as const,
                endpointHealth: 'not_checked' as const,
                compatibility: {
                    result: { status: 'experimental' as const, selectedProtocol: 'openai-chat' as const,
                        reasons: ['compatibility_evidence_missing' as const], confirmationScope: { kind: 'connection' as const } },
                    compatibilityFingerprint: 'compatibility:v1:account', confirmed: false,
                },
            })),
        };
        const [, source] = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey },
            nativeModels: [{ id: 'native-1', name: 'Native', hidden: false }],
            groups: [accountView],
            showHidden: true,
            onSetVisibility: () => {},
            grouping: {
                nativeTitle: 'Codex', nativeDescription: 'Native models', connectionDescription: 'Shown sources',
                defaultRef: null,
            },
        });
        expect(source!.options.map((option) => option.subtitle)).toEqual([undefined, undefined]);
        expect(source!.description).toBe('Shown sources · Experimental · Needs a machine to confirm');
        expect(source!.description).not.toContain('Selected machine');
    });

    it('collapses a source hidden from the picker to the models it keeps and a way to browse it', async () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const onOpenConnection = vi.fn();
        const onSetVisibility = vi.fn();
        const projected = group(3, 'pc_a');
        const shownRows = (source: ReturnType<typeof group>) => ({
            ...source, rows: source.rows.map((row) => ({ ...row, visibility: 'visible' as const })),
        });
        const sections = buildProviderModelManagerSections({
            scope: { kind: 'agent', agentTargetKey },
            nativeModels: [],
            groups: [shownRows(projected), shownRows(group(2, 'pc_b'))],
            showHidden: true,
            onSetVisibility,
            onOpenConnection,
            grouping: {
                nativeTitle: 'Codex', nativeDescription: 'Native models', connectionDescription: 'Shown sources',
                defaultRef: null,
                favoriteRefs: [{ agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'), modelId: 'model-2' }],
                isSourceShown: () => false,
            },
        });
        const kept = sections.find((section) => section.id === 'source:pc_a')!;
        const empty = sections.find((section) => section.id === 'source:pc_b')!;
        // The source's header stays (its switch turns it back on); only the favorite the picker keeps is listed.
        expect(kept.options.map((option) => option.id)).toEqual([providerModelRowKey('pc_a', 'model-2')]);
        expect(kept.description).toBe('Hidden from the picker · 3 models');
        expect(empty.options).toEqual([]);
        expect(empty.description).toBe('Hidden from the picker · 2 models');
        const accessory = await renderScreen(kept.options[0]!.rightAccessory as React.ReactElement);
        expect(accessory.getTextContent()).toContain('Stays visible as a favorite');
        expect(accessory.findAllByType(Switch)).toHaveLength(0);
        expect(kept.footerAction?.label).toBe('Browse 3 models');
        kept.footerAction?.onPress();
        expect(onOpenConnection).toHaveBeenCalledWith('pc_a');
        expect(onSetVisibility).not.toHaveBeenCalled();
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
        const rowMenuActions = (screen: Awaited<ReturnType<typeof renderScreen>>): readonly PageHeaderMenuAction[] =>
            screen.findAllByType(PageHeaderMenu)[0]?.props.actions ?? [];
        const selected = await renderScreen(sections[0]!.options[1]!.rightAccessory as React.ReactElement);
        expect(rowMenuActions(selected).map((action) => action.id)).not.toContain('setDefault');
        const other = await renderScreen(sections[1]!.options[1]!.rightAccessory as React.ReactElement);
        // Setting the default is a rare operation in the row's menu, never a glyph beside the switch.
        expect(other.findAllByTestId('provider-model-manager.set-default')).toHaveLength(0);
        const setDefault = rowMenuActions(other).find((action) => action.id === 'setDefault');
        expect(setDefault?.title).toBe('Set as default');
        await setDefault?.onSelect();
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
        // Show only and Remove are rare operations in one row menu whose trigger names the model.
        expect(screen.findAllByTestId('provider-model-manager.row-menu.trigger')[0]?.props.accessibilityLabel)
            .toBe('Model 0, Gateway · Work, More actions');
        const menu = screen.findAllByType(PageHeaderMenu)[0];
        expect(menu?.props.actions.map((action: PageHeaderMenuAction) => [action.id, action.title, action.destructive === true])).toEqual([
            ['showOnly', 'Show only this model', false],
            ['remove', 'Remove model', true],
        ]);
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
