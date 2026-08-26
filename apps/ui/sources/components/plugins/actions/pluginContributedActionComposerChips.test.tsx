import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { Platform } from 'react-native';
import { ComposerControlStateV1Schema } from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/plugins/ui';
import type {
    PluginComposerControlContributionV1,
    PluginProjectedComposerControlEntryV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => vi.fn());

vi.mock('@/log', () => ({ log: { log: logSpy } }));

import type { SelectionListStep } from '@/components/ui/selectionList';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';

import type {
    PluginContributedActionController,
    PluginContributedActionDescriptor,
} from './pluginContributedActionController';
import {
    createPluginContributedActionComposerChips,
    type PluginComposerControlHost,
} from './pluginContributedActionComposerChips';

/**
 * The host's admitted translator boundary for `acme.channels`. Its values
 * differ from every declared fallback, so a fallback-only reader and a
 * projection-backed reader cannot produce the same string. The component under
 * test receives this narrow host contract directly; translation-catalog
 * projection has its own owner-level coverage.
 */
const CHANNELS_TRANSLATIONS: Readonly<Record<string, string>> = {
    'acme.mode.label': 'Delivery mode',
    'acme.mode.fast': 'Fastest',
};

function localizeChannelsText(_pluginId: string, value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const candidate = value as Readonly<{ key?: unknown; fallback?: unknown }>;
    const key = typeof candidate.key === 'string' ? candidate.key : null;
    return key === null
        ? typeof candidate.fallback === 'string' ? candidate.fallback : ''
        : CHANNELS_TRANSLATIONS[key] ?? (typeof candidate.fallback === 'string' ? candidate.fallback : '');
}

function descriptor(input: Readonly<{
    localId: string;
    placement: 'composer.primary' | 'composer.more';
}>): PluginContributedActionDescriptor {
    return {
        identity: { pluginId: 'acme.channels', localId: input.localId },
        qualifiedActionId: `acme.channels/${input.localId}`,
        title: input.localId === 'configure' ? 'Configure channels' : 'Refresh channels',
        description: null,
        icon: null,
        priority: 0,
        placement: input.placement,
        slash: null,
        scope: 'session',
        scopes: ['session'],
        inputHints: null,
        kind: 'direct',
    };
}

function composerControl(input: Readonly<{
    localId: string;
    definition?: Omit<PluginComposerControlContributionV1, 'id'>;
}>): PluginProjectedComposerControlEntryV1 {
    return {
        id: `acme.channels/${input.localId}`,
        pluginId: 'acme.channels',
        identity: { pluginId: 'acme.channels', localId: input.localId },
        immutableGenerationId: 'channels-generation-7',
        definition: {
            id: input.localId,
            label: input.localId,
            icon: 'add',
            interaction: { kind: 'action', action: 'refresh' },
            ...input.definition,
        },
    };
}

function createComposerControlHost(
    overrides: Partial<Pick<
        PluginComposerControlHost,
        'scope' | 'isCurrent' | 'renderControlResourceState' | 'renderSurfaceContent' | 'canMutateComposer'
    >> = {},
) {
    const openAction = vi.fn<(input: Parameters<PluginComposerControlHost['openAction']>[0]) => void>();
    const applyComposer = vi.fn<PluginComposerControlHost['applyComposer']>(
        () => ({ status: 'applied', revision: 1 }),
    );
    const openDestination = vi.fn<(input: Parameters<PluginComposerControlHost['openDestination']>[0]) => void>();
    const renderSurfaceContent = vi.fn<(
        presentation: Parameters<PluginComposerControlHost['renderSurfaceContent']>[0],
    ) => React.ReactNode>(() => <React.Fragment>surface</React.Fragment>);
    const openSurfaceDialog = vi.fn<(
        presentation: Parameters<PluginComposerControlHost['openSurfaceDialog']>[0],
    ) => void>();
    const renderControlResourceState = vi.fn<PluginComposerControlHost['renderControlResourceState']>((input) => (
        input.children(null, null)
    ));
    return {
        scope: 'session',
        isCurrent: () => true,
        canMutateComposer: () => true,
        localize: localizeChannelsText,
        renderControlResourceState,
        openAction,
        applyComposer,
        openDestination,
        renderSurfaceContent,
        openSurfaceDialog,
        ...overrides,
    } satisfies PluginComposerControlHost;
}

function unwrapDiagnosticContent<Props extends object>(node: React.ReactNode): React.ReactElement<Props> {
    if (!React.isValidElement(node)) throw new Error('expected a rendered Composer control node');
    if (node.type !== React.Fragment) return node as React.ReactElement<Props>;
    const children = React.Children.toArray((node.props as Readonly<{ children: React.ReactNode }>).children);
    const content = children[children.length - 1];
    if (!React.isValidElement<Props>(content)) throw new Error('expected diagnostic content node');
    return content;
}

describe('plugin contributed composer Action chips', () => {
    it('uses the incumbent content, list, and split popover shells for each declared surface layout', () => {
        const controls = (['content', 'list', 'split'] as const).map((layout) => composerControl({
            localId: `surface-${layout}`,
            definition: {
                label: `Surface ${layout}`,
                icon: 'preview',
                state: { resource: `surface-${layout}` },
                interaction: {
                    kind: 'surface',
                    renderer: { renderer: `surface-${layout}-renderer` },
                    presentation: 'popover',
                    layout,
                },
            },
        }));
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: controls,
            composerControlHost: createComposerControlHost({
                renderControlResourceState: (input) => input.children(null, null),
            }),
        });
        const renderPopover = (index: number): React.ReactElement => {
            const node = chips[index]?.renderCollapsedPopover?.({
                anchorRef: React.createRef(),
                onRequestClose: vi.fn(),
            });
            if (!React.isValidElement(node)) throw new Error('expected a surface popover');
            return node;
        };

        expect(renderPopover(0).type).toBe(AgentInputContentPopover);
        expect(renderPopover(1).type).toBe(AgentInputSelectionListPopover);
        expect(renderPopover(2).type).toBe(AgentInputChipPickerPopover);
    });

    it('keeps an authored collapsed accessibility label separate from its visible overflow label', () => {
        const control = composerControl({
            localId: 'accessible-overflow',
            definition: {
                label: 'Inline label',
                icon: 'preview',
                overflow: {
                    label: 'Visible overflow label',
                    icon: 'more',
                    accessibilityLabel: 'Open the accessible overflow control',
                },
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chip = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [control],
            composerControlHost: createComposerControlHost(),
        })[0];
        const collapsed = chip?.collapsedAction?.({
            tint: '#fff',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        if (!collapsed || Array.isArray(collapsed)) throw new Error('expected one collapsed action');
        const collapsedItem = collapsed as ActionListItem;

        expect(collapsedItem.label).toBe('Visible overflow label');
        expect(collapsedItem.accessibilityLabel)
            .toBe('Open the accessible overflow control');
    });

    it('takes declared Resource control state only through the nested resource boundary for both chip and collapsed-row rendering', () => {
        const staticControl = composerControl({
            localId: 'static-control',
            definition: {
                label: 'Static control',
                icon: 'add',
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        const dynamicControl = composerControl({
            localId: 'resource-control',
            definition: {
                label: 'Fallback control',
                icon: 'add',
                state: { resource: 'control-state' },
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        const renderControlResourceState = vi.fn<PluginComposerControlHost['renderControlResourceState']>((input) => input.children({
            label: 'Live control',
            enabled: true,
            selected: true,
        }, null));
        const composerControlHost = createComposerControlHost({
            renderControlResourceState,
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [staticControl, dynamicControl],
            composerControlHost,
        });
        const renderContext = {
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        };

        const staticNode = chips[0]?.render(renderContext);
        expect(staticNode).not.toBeNull();
        expect(renderControlResourceState).not.toHaveBeenCalled();

        const dynamicNode = chips[1]?.render(renderContext);
        if (!React.isValidElement<Readonly<{ accessibilityLabel?: string }>>(dynamicNode)) {
            throw new Error('expected a dynamic Composer control chip');
        }
        expect(dynamicNode.props.accessibilityLabel).toBe('Live control');
        expect(renderControlResourceState).toHaveBeenCalledWith(expect.objectContaining({
            control: dynamicControl,
            children: expect.any(Function),
        }));

        const collapsed = chips[1]?.collapsedAction?.({
            tint: '#fff',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        if (!collapsed || !('id' in collapsed)) throw new Error('expected a collapsed control action');
        const renderItem = (collapsed as unknown as Readonly<{
            renderItem?: (
                item: Readonly<{ id: string; label: string; disabled?: boolean }>,
                renderDefaultItem: (item: Readonly<{ id: string; label: string; disabled?: boolean }>) => React.ReactNode,
            ) => React.ReactNode;
        }>).renderItem;
        expect(renderItem).toEqual(expect.any(Function));
        const renderDefaultItem = vi.fn((item: Readonly<{ id: string; label: string; disabled?: boolean }>) => (
            <React.Fragment>{item.label}</React.Fragment>
        ));
        renderItem?.({
            id: collapsed.id,
            label: collapsed.label,
            ...(collapsed.disabled === undefined ? {} : { disabled: collapsed.disabled }),
        }, renderDefaultItem);
        expect(renderDefaultItem).toHaveBeenLastCalledWith(expect.objectContaining({
            label: 'Live control',
            disabled: false,
        }));
        expect(renderControlResourceState).toHaveBeenCalledTimes(2);
    });

    it('projects only current-scope controls in normalized order, then routes Resource-state Actions through the supplied dispatcher owner', () => {
        const staticControl = composerControl({
            localId: 'static-action',
            definition: {
                label: 'Static action',
                icon: 'add',
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        const dynamicControl = composerControl({
            localId: 'dynamic-action',
            definition: {
                label: 'Default dynamic action',
                icon: 'add',
                state: { resource: 'channel-state' },
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        const otherScopeControl = composerControl({
            localId: 'new-session-only',
            definition: {
                label: 'New session only',
                icon: 'add',
                scopes: ['newSession'],
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        let current = true;
        const renderControlResourceState = vi.fn<PluginComposerControlHost['renderControlResourceState']>((input) => (
            input.children(input.control.id === dynamicControl.id
                ? { label: 'Live dynamic action', count: 2, selected: true }
                : null, null)
        ));
        const composerControlHost = createComposerControlHost({
            isCurrent: () => current,
            renderControlResourceState,
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;

        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [staticControl, dynamicControl, otherScopeControl],
            composerControlHost,
        });

        expect(chips.map((chip) => chip.controlId)).toEqual([
            'plugin:acme.channels/static-action',
            'plugin:acme.channels/dynamic-action',
        ]);
        expect(renderControlResourceState).not.toHaveBeenCalled();

        const dynamicChip = chips[1]!;
        const rendered = dynamicChip.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        });
        if (!React.isValidElement<Readonly<{
            accessibilityLabel?: string;
            disabled?: boolean;
            onPress: () => void;
        }>>(rendered)) throw new Error('expected a dynamic Composer control chip');
        expect(rendered.props.accessibilityLabel).toBe('Live dynamic action');
        expect(rendered.props.disabled).toBe(false);
        rendered.props.onPress();
        expect(composerControlHost.openAction).toHaveBeenCalledWith({
            control: dynamicControl,
            action: { pluginId: 'acme.channels', localId: 'refresh' },
        });
        current = false;
        rendered.props.onPress();
        expect(composerControlHost.openAction).toHaveBeenCalledTimes(1);

        const collapsed = dynamicChip.collapsedAction?.({
            tint: '#fff',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        if (!collapsed || !('id' in collapsed)) throw new Error('expected one collapsed dynamic Composer control action');
        expect(collapsed.id).toBe('plugin-composer-control:acme.channels/dynamic-action');
        expect(collapsed.disabled).toBe(true);
    });

    it('shows declared Composer control and choice text from the admitted translation bundle', async () => {
        const control = composerControl({
            localId: 'mode',
            definition: {
                label: { key: 'acme.mode.label', fallback: 'Mode' },
                icon: 'add',
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [
                        {
                            id: 'fast',
                            label: { key: 'acme.mode.fast', fallback: 'Fast' },
                            effect: { kind: 'action', action: 'refresh' },
                        },
                        {
                            id: 'safe',
                            // No bundle entry: the author's own words answer it,
                            // and the raw key is never shown.
                            label: { key: 'acme.mode.safe', fallback: 'Safe' },
                            effect: { kind: 'action', action: 'refresh' },
                        },
                    ],
                },
            },
        });
        const chips = createPluginContributedActionComposerChips({
            controller: {
                list: vi.fn(() => []),
                listSlashCommands: () => [],
                open: vi.fn(),
                isReferenceAvailable: () => false,
                isSessionReferenceAvailable: () => false,
                invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
                openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            } satisfies PluginContributedActionController,
            openAction: vi.fn(),
            composerControls: [control],
            composerControlHost: createComposerControlHost(),
        });

        const node = chips[0]?.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        });
        if (!React.isValidElement<Readonly<{ accessibilityLabel?: string }>>(node)) {
            throw new Error('expected a Composer control chip');
        }
        expect(node.props.accessibilityLabel).toBe('Delivery mode');

        const popover = chips[0]?.collapsedOptionsPopover as unknown as Readonly<{
            label: string;
            options: readonly AgentInputChipPickerOption[];
        }>;
        expect(popover.label).toBe('Delivery mode');
        expect(popover.options.map((option) => option.label)).toEqual(['Fastest', 'Safe']);
    });

    it('exposes a selectable Composer control as a real toggle button on the web', async () => {
        const selectableControl = composerControl({
            localId: 'live-toggle',
            definition: {
                label: 'Live control',
                icon: 'add',
                interaction: { kind: 'action', action: 'refresh' },
                state: { resource: 'live-toggle-state' },
            },
        });
        const plainControl = composerControl({ localId: 'plain' });
        const renderContext = {
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        };
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;

        const readChip = (selected: boolean) => {
            const chips = createPluginContributedActionComposerChips({
                controller,
                openAction: vi.fn(),
                composerControls: [selectableControl, plainControl],
                composerControlHost: createComposerControlHost({
                    renderControlResourceState: (input) => input.children({ selected }, null),
                }),
            });
            return {
                selectable: chips[0]?.render(renderContext),
                plain: chips[1]?.render(renderContext),
            };
        };

        const on = readChip(true);
        if (!React.isValidElement<Readonly<Record<string, unknown>>>(on.selectable)) {
            throw new Error('expected a selectable Composer control chip');
        }
        // Native keeps its own selected state; the web tree gets valid button
        // semantics instead of nothing at all.
        expect(on.selectable.props.accessibilityState).toEqual({ selected: true });
        expect(on.selectable.props['aria-pressed']).toBe(true);

        const off = readChip(false);
        if (!React.isValidElement<Readonly<Record<string, unknown>>>(off.selectable)) {
            throw new Error('expected a selectable Composer control chip');
        }
        expect(off.selectable.props['aria-pressed']).toBe(false);

        // A control with no on/off state must not be announced as an unpressed
        // toggle.
        if (!React.isValidElement<Readonly<Record<string, unknown>>>(off.plain)) {
            throw new Error('expected a plain Composer control chip');
        }
        expect(off.plain.props).not.toHaveProperty('aria-pressed');
    });

    it('keeps choice selection on the options instead of announcing the opener as selected', () => {
        const choicesControl = composerControl({
            localId: 'mode',
            definition: {
                label: 'Mode',
                icon: 'settings',
                state: { resource: 'mode-state' },
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'fast',
                        label: 'Fast',
                        effect: { kind: 'action', action: 'refresh' },
                    }],
                },
            },
        });
        const chips = createPluginContributedActionComposerChips({
            controller: {
                list: vi.fn(() => []),
                listSlashCommands: () => [],
                open: vi.fn(),
                isReferenceAvailable: () => false,
                isSessionReferenceAvailable: () => false,
                invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
                openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            },
            openAction: vi.fn(),
            composerControls: [choicesControl],
            composerControlHost: createComposerControlHost({
                renderControlResourceState: (input) => input.children({ selectedChoiceIds: ['fast'] }, null),
            }),
        });
        const node = chips[0]?.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        });
        if (!React.isValidElement<Readonly<Record<string, unknown>>>(node)) {
            throw new Error('expected a choices Composer control chip');
        }

        expect(node.props).not.toHaveProperty('aria-pressed');
        expect(node.props.accessibilityState).toBeUndefined();
        expect(chips[0]?.collapsedOptionsPopover?.selectedOptionId).toBe('fast');
    });

    it('keeps declared choices selected while recovering unknown Resource selections through one bounded contributor diagnostic', async () => {
        logSpy.mockClear();
        const singleChoiceControl = composerControl({
            localId: 'single-choice',
            definition: {
                label: 'Mode',
                icon: 'settings',
                state: { resource: 'mode-state' },
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'fast',
                        label: 'Fast',
                        effect: { kind: 'action', action: 'refresh' },
                    }, {
                        id: 'safe',
                        label: 'Safe',
                        disabled: true,
                        effect: { kind: 'action', action: 'refresh', input: { mode: 'safe' } },
                    }],
                },
            },
        });
        const multipleChoiceControl = composerControl({
            localId: 'multiple-choice',
            definition: {
                label: 'Channels',
                icon: 'more',
                state: { resource: 'channel-state' },
                interaction: {
                    kind: 'choices',
                    selection: 'multiple',
                    options: [{
                        id: 'refresh',
                        label: { key: 'channels.refresh', fallback: 'Refresh channels' },
                        description: 'Refresh the current list',
                        effect: { kind: 'action', action: 'refresh', input: { source: 'control' } },
                    }, {
                        id: 'clear',
                        label: 'Clear draft',
                        effect: { kind: 'composerApply', operations: [{ kind: 'text.clear' }] },
                    }],
                },
            },
        });
        const composerControlHost = createComposerControlHost({
            renderControlResourceState: vi.fn<PluginComposerControlHost['renderControlResourceState']>((input) => (
                input.children(input.control.id === singleChoiceControl.id
                    ? { selectedChoiceIds: ['fast', 'unknown-choice'] }
                    : { selectedChoiceIds: ['refresh', 'clear', 'unknown-choice'] }, null)
            )),
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;

        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [singleChoiceControl, multipleChoiceControl],
            composerControlHost,
        });

        const singlePopover = unwrapDiagnosticContent<Readonly<{
            selectedOptionId?: string | null;
            options: readonly { id: string }[];
            onSelect: (id: string) => void;
        }>>(chips[0]?.renderCollapsedPopover?.({
            anchorRef: React.createRef(),
            onRequestClose: vi.fn(),
        }));
        expect(singlePopover.props.selectedOptionId).toBe('fast');
        expect(singlePopover.props.options.map((option) => option.id)).toEqual(['fast', 'safe']);

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(
                <>{chips[0]?.render({
                    chipStyle: () => ({}),
                    showLabel: true,
                    iconColor: '#fff',
                    textStyle: {},
                    countTextStyle: {},
                    chipAnchorRef: React.createRef(),
                    popoverAnchorRef: React.createRef(),
                })}</>,
            );
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('composer_control_unknown_choice_ids'));
        const diagnostic = logSpy.mock.calls[0]?.[0];
        expect(diagnostic).toEqual(expect.stringContaining('"pluginId":"acme.channels"'));
        expect(diagnostic).toEqual(expect.stringContaining('"contributionId":"single-choice"'));
        const renderedChip = tree.root.findByProps({
            testID: 'plugin-composer-control:acme.channels/single-choice',
        });
        expect(renderedChip.props.accessibilityRole).toBe('button');
        expect(renderedChip.props.accessibilityLabel).toBe('Mode');
        expect(renderedChip.props.accessibilityState).toBeUndefined();
        expect(renderedChip.props).not.toHaveProperty('aria-pressed');

        await act(async () => {
            tree?.update(
                <>{chips[0]?.render({
                    chipStyle: () => ({}),
                    showLabel: true,
                    iconColor: '#fff',
                    textStyle: {},
                    countTextStyle: {},
                    chipAnchorRef: React.createRef(),
                    popoverAnchorRef: React.createRef(),
                })}</>,
            );
        });
        expect(logSpy).toHaveBeenCalledTimes(1);

        singlePopover.props.onSelect('fast');
        expect(composerControlHost.openAction).toHaveBeenCalledWith({
            control: singleChoiceControl,
            action: { pluginId: 'acme.channels', localId: 'refresh' },
        });
        composerControlHost.openAction.mockClear();
        singlePopover.props.onSelect('unknown-choice');
        expect(composerControlHost.openAction).not.toHaveBeenCalled();
        expect(composerControlHost.applyComposer).not.toHaveBeenCalled();

        const multiplePopover = unwrapDiagnosticContent<Readonly<{
            rootStep: SelectionListStep;
        }>>(chips[1]?.renderCollapsedPopover?.({
            anchorRef: React.createRef(),
            onRequestClose: vi.fn(),
        }));
        const multipleSection = multiplePopover.props.rootStep.sections[0];
        if (!multipleSection || multipleSection.kind !== 'static') throw new Error('expected static choice rows');
        const multipleOptions = multipleSection.options;
        expect(multipleOptions.map((option) => option.id)).toEqual(['refresh', 'clear']);
        multipleOptions[0]?.onSelect?.();
        multipleOptions[1]?.onSelect?.();
        expect(composerControlHost.openAction).toHaveBeenLastCalledWith({
            control: multipleChoiceControl,
            action: { pluginId: 'acme.channels', localId: 'refresh' },
            input: { source: 'control' },
        });
        expect(composerControlHost.applyComposer).toHaveBeenCalledWith({
            control: multipleChoiceControl,
            operations: [{ kind: 'text.clear' }],
        });

        await act(async () => { tree?.unmount(); });
    });

    // A read-only Session, a view-only share, or an `editAndSubmit` lock makes
    // the Composer transaction owner return `notEditable`. Only the choices
    // whose effect is a Composer mutation may present as disabled there: an
    // Action choice in the same control is independent of draft editability.
    it('disables only composerApply choices when the Composer document refuses mutation', () => {
        const control = composerControl({
            localId: 'mixed-choice',
            definition: {
                label: 'Channels',
                icon: 'more',
                interaction: {
                    kind: 'choices',
                    selection: 'multiple',
                    options: [{
                        id: 'refresh',
                        label: 'Refresh channels',
                        effect: { kind: 'action', action: 'refresh' },
                    }, {
                        id: 'clear',
                        label: 'Clear draft',
                        effect: { kind: 'composerApply', operations: [{ kind: 'text.clear' }] },
                    }],
                },
            },
        });
        const composerControlHost = createComposerControlHost({ canMutateComposer: () => false });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;

        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [control],
            composerControlHost,
        });

        const popover = chips[0]?.collapsedOptionsPopover as unknown as Readonly<{
            rootStep: SelectionListStep;
        }>;
        const section = popover.rootStep.sections[0];
        if (!section || section.kind !== 'static') throw new Error('expected static choice rows');
        const options = section.options;
        expect(options.map((option) => [option.id, option.disabled === true])).toEqual([
            ['refresh', false],
            ['clear', true],
        ]);

        options[1]?.onSelect?.();
        expect(composerControlHost.applyComposer).not.toHaveBeenCalled();

        // Positive twin: the Action choice in the same control still executes.
        options[0]?.onSelect?.();
        expect(composerControlHost.openAction).toHaveBeenCalledWith({
            control,
            action: { pluginId: 'acme.channels', localId: 'refresh' },
        });
    });

    // The canonical transaction owner can still refuse an enabled mutating
    // choice (a conflicting revision). Reporting that as a successful selection
    // dismissed the affordance and lost the user's intent silently.
    it('reports a refused composerApply selection so its affordance is not dismissed as applied', () => {
        const control = composerControl({
            localId: 'apply-choice',
            definition: {
                label: 'Draft',
                icon: 'more',
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'clear',
                        label: 'Clear draft',
                        effect: { kind: 'composerApply', operations: [{ kind: 'text.clear' }] },
                    }],
                },
            },
        });
        const composerControlHost = createComposerControlHost();
        composerControlHost.applyComposer.mockReturnValue({ status: 'conflict', currentRevision: 9 });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;

        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [control],
            composerControlHost,
        });

        const popover = chips[0]?.collapsedOptionsPopover;
        if (!popover) throw new Error('expected the choice overflow popover');
        expect(popover.onSelect('clear')).toBe(false);

        // Positive twin: an applied transaction still reports a closable success.
        composerControlHost.applyComposer.mockReturnValue({ status: 'applied', revision: 10 });
        expect(popover.onSelect('clear')).toBe(true);
    });

    it('bounds maximum schema-valid unknown Resource choices without losing diagnostic attribution or admission safety', async () => {
        logSpy.mockClear();
        const unknownChoiceIds = Array.from(
            { length: 64 },
            (_, index) => `unknown-${String(index).padStart(3, '0')}-${'x'.repeat(244)}`,
        );
        expect(unknownChoiceIds.every((choiceId) => choiceId.length === 256)).toBe(true);
        expect(ComposerControlStateV1Schema.safeParse({ selectedChoiceIds: unknownChoiceIds }).success).toBe(true);

        const maximumChoiceControl = composerControl({
            localId: 'maximum-choice',
            definition: {
                label: 'Mode',
                icon: 'settings',
                state: { resource: 'mode-state' },
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'fast',
                        label: 'Fast',
                        effect: { kind: 'action', action: 'refresh' },
                    }],
                },
            },
        });
        const composerControlHost = createComposerControlHost({
            renderControlResourceState: (input) => input.children({ selectedChoiceIds: unknownChoiceIds }, null),
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chip = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [maximumChoiceControl],
            composerControlHost,
        })[0];

        const popover = unwrapDiagnosticContent<Readonly<{
            selectedOptionId?: string | null;
            options: readonly { id: string }[];
            onSelect: (id: string) => void;
        }>>(chip?.renderCollapsedPopover?.({
            anchorRef: React.createRef(),
            onRequestClose: vi.fn(),
        }));
        expect(popover.props.selectedOptionId).toBeNull();
        expect(popover.props.options.map((option) => option.id)).toEqual(['fast']);
        popover.props.onSelect(unknownChoiceIds[0]!);
        expect(composerControlHost.openAction).not.toHaveBeenCalled();
        expect(composerControlHost.applyComposer).not.toHaveBeenCalled();

        let tree: ReturnType<typeof create> | null = null;
        await act(async () => {
            tree = create(
                <>{chip?.render({
                    chipStyle: () => ({}),
                    showLabel: true,
                    iconColor: '#fff',
                    textStyle: {},
                    countTextStyle: {},
                    chipAnchorRef: React.createRef(),
                    popoverAnchorRef: React.createRef(),
                })}</>,
            );
        });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const diagnostic = logSpy.mock.calls[0]?.[0];
        if (typeof diagnostic !== 'string') throw new Error('expected unknown-choice diagnostic text');
        const prefix = '[plugin-ui-composer-control] ';
        expect(diagnostic.startsWith(prefix)).toBe(true);
        expect(new TextEncoder().encode(diagnostic).byteLength)
            .toBeLessThanOrEqual(PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1);

        const payload = JSON.parse(diagnostic.slice(prefix.length)) as Readonly<{
            code?: unknown;
            pluginId?: unknown;
            contributionId?: unknown;
            controlId?: unknown;
            unknownChoiceIdSamples?: unknown;
            unknownChoiceIdsOmittedCount?: unknown;
        }>;
        expect(payload).toMatchObject({
            code: 'composer_control_unknown_choice_ids',
            pluginId: 'acme.channels',
            contributionId: 'maximum-choice',
            controlId: 'acme.channels/maximum-choice',
        });
        const unknownChoiceIdSamples = payload.unknownChoiceIdSamples;
        if (!Array.isArray(unknownChoiceIdSamples)
            || !unknownChoiceIdSamples.every((choiceId): choiceId is string => typeof choiceId === 'string')) {
            throw new Error('expected bounded unknown-choice ID samples');
        }
        expect(unknownChoiceIdSamples).toHaveLength(3);
        expect(unknownChoiceIdSamples.every(
            (choiceId) => new TextEncoder().encode(choiceId).byteLength <= 96,
        )).toBe(true);
        expect(payload.unknownChoiceIdsOmittedCount)
            .toBe(unknownChoiceIds.length - unknownChoiceIdSamples.length);

        await act(async () => { tree?.unmount(); });
    });

    it('keeps a sensitive multibyte maximum Resource diagnostic parseable after redacting its dynamic values', async () => {
        logSpy.mockClear();
        const rawCredential = 'credential-秘密🔐';
        const unknownChoiceIds = Array.from({ length: 64 }, (_, index) => {
            const prefix = `api_key=${rawCredential}-${String(index).padStart(3, '0')}-`;
            return `${prefix}${'界'.repeat(256 - prefix.length)}`;
        });
        expect(unknownChoiceIds.every((choiceId) => choiceId.length === 256)).toBe(true);
        expect(ComposerControlStateV1Schema.safeParse({ selectedChoiceIds: unknownChoiceIds }).success).toBe(true);

        const sensitiveMaximumChoiceControl = composerControl({
            localId: 'sensitive-maximum-choice',
            definition: {
                label: 'Mode',
                icon: 'settings',
                state: { resource: 'mode-state' },
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'fast',
                        label: 'Fast',
                        effect: { kind: 'action', action: 'refresh' },
                    }],
                },
            },
        });
        const composerControlHost = createComposerControlHost({
            renderControlResourceState: (input) => input.children({ selectedChoiceIds: unknownChoiceIds }, null),
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chip = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [sensitiveMaximumChoiceControl],
            composerControlHost,
        })[0];

        let tree: ReturnType<typeof create> | null = null;
        await act(async () => {
            tree = create(
                <>{chip?.render({
                    chipStyle: () => ({}),
                    showLabel: true,
                    iconColor: '#fff',
                    textStyle: {},
                    countTextStyle: {},
                    chipAnchorRef: React.createRef(),
                    popoverAnchorRef: React.createRef(),
                })}</>,
            );
        });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const diagnostic = logSpy.mock.calls[0]?.[0];
        if (typeof diagnostic !== 'string') throw new Error('expected unknown-choice diagnostic text');
        const prefix = '[plugin-ui-composer-control] ';
        expect(diagnostic.startsWith(prefix)).toBe(true);
        expect(diagnostic).not.toContain(rawCredential);
        expect(new TextEncoder().encode(diagnostic).byteLength)
            .toBeLessThanOrEqual(PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1);

        const payload = JSON.parse(diagnostic.slice(prefix.length)) as Readonly<{
            code?: unknown;
            pluginId?: unknown;
            contributionId?: unknown;
            controlId?: unknown;
            unknownChoiceIdSamples?: unknown;
            unknownChoiceIdsOmittedCount?: unknown;
        }>;
        expect(payload).toMatchObject({
            code: 'composer_control_unknown_choice_ids',
            pluginId: 'acme.channels',
            contributionId: 'sensitive-maximum-choice',
            controlId: 'acme.channels/sensitive-maximum-choice',
        });
        const unknownChoiceIdSamples = payload.unknownChoiceIdSamples;
        if (!Array.isArray(unknownChoiceIdSamples)
            || !unknownChoiceIdSamples.every((choiceId): choiceId is string => typeof choiceId === 'string')) {
            throw new Error('expected bounded unknown-choice ID samples');
        }
        expect(unknownChoiceIdSamples).toHaveLength(3);
        expect(unknownChoiceIdSamples.every(
            (choiceId) => new TextEncoder().encode(choiceId).byteLength <= 96,
        )).toBe(true);
        expect(payload.unknownChoiceIdsOmittedCount)
            .toBe(unknownChoiceIds.length - unknownChoiceIdSamples.length);

        await act(async () => { tree?.unmount(); });
    });

    it('keeps removed Resource choices out of a compact renderer while reporting the recovery once', async () => {
        logSpy.mockClear();
        const compactChoiceControl = composerControl({
            localId: 'compact-choice',
            definition: {
                label: 'Mode',
                icon: 'settings',
                state: { resource: 'mode-state' },
                compactRenderer: { renderer: 'mode-compact' },
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'fast',
                        label: 'Fast',
                        effect: { kind: 'action', action: 'refresh' },
                    }],
                },
            },
        });
        const renderSurfaceContent = vi.fn<PluginComposerControlHost['renderSurfaceContent']>(
            () => <React.Fragment>compact surface</React.Fragment>,
        );
        const composerControlHost = createComposerControlHost({
            renderSurfaceContent,
            renderControlResourceState: (input) => input.children({
                selectedChoiceIds: ['fast', 'removed-choice'],
            }, null),
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chip = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [compactChoiceControl],
            composerControlHost,
        })[0];
        const rendered = chip?.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        });

        expect(renderSurfaceContent).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'control',
            role: 'compact',
            control: compactChoiceControl,
            state: expect.objectContaining({ selectedChoiceIds: ['fast'] }),
        }));

        let tree: ReturnType<typeof create> | null = null;
        await act(async () => {
            tree = create(<>{rendered}</>);
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('composer_control_unknown_choice_ids'));
        await act(async () => { tree?.unmount(); });
    });

    it('does not report an unknown Resource choice after its Composer control retires before the effect commits', async () => {
        logSpy.mockClear();
        const choiceControl = composerControl({
            localId: 'retiring-choice',
            definition: {
                label: 'Mode',
                icon: 'settings',
                state: { resource: 'mode-state' },
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'fast',
                        label: 'Fast',
                        effect: { kind: 'action', action: 'refresh' },
                    }],
                },
            },
        });
        let current = true;
        const composerControlHost = createComposerControlHost({
            isCurrent: () => current,
            renderControlResourceState: (input) => input.children({
                selectedChoiceIds: ['removed-choice'],
            }, null),
        });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chip = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [choiceControl],
            composerControlHost,
        })[0];
        const rendered = chip?.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        });
        current = false;

        let tree: ReturnType<typeof create> | null = null;
        await act(async () => {
            tree = create(<>{rendered}</>);
        });
        expect(logSpy).not.toHaveBeenCalled();
        await act(async () => { tree?.unmount(); });
    });

    it('routes destinations and every surface-bearing control arm through its exact host adapter rather than a generic chip callback', () => {
        const destinationControl = composerControl({
            localId: 'destination',
            definition: {
                label: 'Open destination',
                icon: 'forward',
                interaction: { kind: 'destination', destination: 'details' },
            },
        });
        const surfaceControl = composerControl({
            localId: 'surface',
            definition: {
                label: 'Surface',
                icon: 'preview',
                state: { resource: 'surface-state' },
                interaction: {
                    kind: 'surface',
                    renderer: { renderer: 'surface-renderer' },
                    presentation: 'popover',
                    layout: 'split',
                },
            },
        });
        const pickerControl = composerControl({
            localId: 'picker',
            definition: {
                label: 'Pick attachment',
                icon: 'file',
                state: { resource: 'picker-state' },
                interaction: {
                    kind: 'attachmentPicker',
                    attachment: 'source',
                    presentation: 'dialog',
                    layout: 'list',
                },
            },
        });
        const compactControl = composerControl({
            localId: 'compact',
            definition: {
                label: 'Compact surface',
                icon: 'action',
                compactRenderer: { renderer: 'compact-renderer' },
                overflow: {
                    label: 'More compact choices',
                    icon: 'more',
                    presentation: { presentation: 'dialog', layout: 'split' },
                },
                interaction: {
                    kind: 'surface',
                    renderer: { renderer: 'interaction-renderer' },
                    presentation: 'popover',
                    layout: 'content',
                },
            },
        });
        const renderControlResourceState = vi.fn<PluginComposerControlHost['renderControlResourceState']>((input) => (
            input.children(input.control.id === surfaceControl.id ? { label: 'Live surface' } : null, null)
        ));
        const composerControlHost = createComposerControlHost({ renderControlResourceState });
        const controller = {
            list: vi.fn(() => []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [destinationControl, surfaceControl, pickerControl, compactControl],
            composerControlHost,
        });
        const renderContext = {
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
            toggleCollapsedPopover: vi.fn(),
        };

        const destinationNode = chips[0]?.render(renderContext);
        if (!React.isValidElement<Readonly<{ onPress: () => void }>>(destinationNode)) {
            throw new Error('expected a destination control chip');
        }
        destinationNode.props.onPress();
        expect(composerControlHost.openDestination).toHaveBeenCalledWith({
            control: destinationControl,
            destination: { pluginId: 'acme.channels', localId: 'details' },
        });

        const surfaceNode = chips[1]?.render(renderContext);
        if (!React.isValidElement<Readonly<{ onPress: () => void }>>(surfaceNode)) {
            throw new Error('expected a surface control chip');
        }
        surfaceNode.props.onPress();
        expect(renderContext.toggleCollapsedPopover).toHaveBeenCalledWith('plugin-composer-control:acme.channels/surface');
        const surfacePopover = chips[1]?.renderCollapsedPopover?.({
            anchorRef: React.createRef(),
            onRequestClose: vi.fn(),
        });
        if (!React.isValidElement<Readonly<{
            options: readonly AgentInputChipPickerOption[];
        }>>(surfacePopover)) throw new Error('expected a Resource-backed surface popover');
        expect(surfacePopover.type).toBe(AgentInputChipPickerPopover);
        const surfaceContent = surfacePopover.props.options[0]?.renderDetailContent;
        if (typeof surfaceContent !== 'function') throw new Error('expected a split surface detail adapter');
        surfaceContent({ onRequestClose: vi.fn() });
        expect(composerControlHost.renderSurfaceContent).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'control',
            role: 'interaction',
            control: surfaceControl,
            presentation: 'popover',
            layout: 'split',
        }));
        expect(vi.mocked(composerControlHost.renderSurfaceContent).mock.calls[0]?.[0]).not.toHaveProperty('renderer');
        expect(renderControlResourceState).toHaveBeenCalledWith(expect.objectContaining({ control: surfaceControl }));

        const pickerNode = chips[2]?.render(renderContext);
        if (!React.isValidElement<Readonly<{ onPress: () => void }>>(pickerNode)) {
            throw new Error('expected an attachment picker control chip');
        }
        pickerNode.props.onPress();
        expect(composerControlHost.openSurfaceDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'attachmentPicker',
                role: 'interaction',
                control: pickerControl,
                presentation: 'dialog',
                layout: 'list',
            }),
            // The visible chip is the exact originating trigger, so native
            // dismissal restores physical/accessibility focus to it instead of
            // dropping focus out of the composer.
            { focusReturnRef: renderContext.chipAnchorRef },
        );

        const compactControlChip = chips.find(
            (chip) => chip.key === 'plugin-composer-control:acme.channels/compact',
        );
        const compactNode = compactControlChip?.render(renderContext);
        if (!React.isValidElement<Readonly<{
            accessibilityRole?: string;
            accessibilityLabel?: string;
            hitSlop?: unknown;
            onPress?: () => void;
            children?: React.ReactNode;
        }>>(compactNode)) throw new Error('expected compact host interaction wrapper');
        const compactChip = compactNode;
        expect(compactChip.props.accessibilityRole).toBe('button');
        expect(compactChip.props.accessibilityLabel).toBe('Compact surface');
        expect(compactChip.props.hitSlop).toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
        const compactVisual = React.Children.only(compactChip.props.children);
        if (!React.isValidElement<Readonly<{ children?: React.ReactNode }>>(compactVisual)) {
            throw new Error('expected compact renderer visual content');
        }
        expect(compactVisual.props.children).toBe('surface');
        compactChip.props.onPress?.();
        expect(composerControlHost.openSurfaceDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'control',
                role: 'interaction',
                control: compactControl,
                presentation: 'dialog',
                layout: 'split',
            }),
            { focusReturnRef: renderContext.chipAnchorRef },
        );
        expect(composerControlHost.renderSurfaceContent).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'control',
            role: 'compact',
            control: compactControl,
        }));
        expect(vi.mocked(composerControlHost.renderSurfaceContent).mock.calls[1]?.[0]).not.toHaveProperty('renderer');
        // The collapsed overflow item's originating trigger is the action menu
        // itself, which owns the anchor the host hands down through
        // `buildCollapsedExtraControlActions`.
        const actionMenuAnchorRef = React.createRef<never>();
        const compactCollapsed = compactControlChip?.collapsedAction?.({
            tint: '#fff',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
            focusReturnRef: actionMenuAnchorRef,
        });
        if (!compactCollapsed || !('id' in compactCollapsed)) throw new Error('expected compact overflow action');
        expect(compactCollapsed.label).toBe('More compact choices');
        compactCollapsed.onPress?.();
        expect(composerControlHost.openSurfaceDialog).toHaveBeenLastCalledWith(
            expect.objectContaining({
                kind: 'control',
                role: 'interaction',
                control: compactControl,
                presentation: 'dialog',
                layout: 'split',
            }),
            { focusReturnRef: actionMenuAnchorRef },
        );
    });

    it('uses the controller’s exact semantic composer placements, then delegates selection back to the host presenter', () => {
        const primary = Object.assign(descriptor({ localId: 'configure', placement: 'composer.primary' }), {
            icon: 'magic-wand',
            priority: -10,
        });
        const secondary = Object.assign(descriptor({ localId: 'refresh', placement: 'composer.more' }), {
            icon: 'arrow-right',
            priority: 10,
        });
        const list = vi.fn((selector: Readonly<{ placement: string; scope: string }>) => (
            selector.placement === 'composer.primary' ? [primary] : [secondary]
        ));
        const openAction = vi.fn();
        const controller = {
            list,
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;

        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction,
        });

        expect(list).toHaveBeenNthCalledWith(1, { placement: 'composer.primary', scope: 'session' });
        expect(list).toHaveBeenNthCalledWith(2, { placement: 'composer.more', scope: 'session' });
        expect(chips.map((chip) => chip.key)).toEqual([
            'plugin-contributed-action:composer.primary:acme.channels/configure',
            'plugin-contributed-action:composer.more:acme.channels/refresh',
        ]);

        const primaryChip = chips[0]!;
        const primaryNode = primaryChip.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: React.createRef(),
        });
        if (!React.isValidElement(primaryNode)) throw new Error('expected primary Action chip');
        const primaryIcon = React.Children.toArray(
            (primaryNode.props as Readonly<{ children: React.ReactNode }>).children,
        )[0];
        if (!React.isValidElement<{ name: string }>(primaryIcon)) throw new Error('expected primary Action icon');
        expect(primaryIcon.props.name).toBe('magic-wand');
        (primaryNode.props as Readonly<{ onPress: () => void }>).onPress();
        expect(openAction).toHaveBeenCalledWith(primary);

        const secondaryChip = chips[1]!;
        const dismiss = vi.fn();
        const collapsed = secondaryChip.collapsedAction?.({
            tint: '#fff',
            dismiss,
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        if (!collapsed || !('id' in collapsed)) throw new Error('expected one overflow Action');
        expect(collapsed.id).toBe('plugin-contributed-action:composer.more:acme.channels/refresh');
        if (!React.isValidElement<{ name: string }>(collapsed.icon)) throw new Error('expected overflow Action icon');
        expect(collapsed.icon.props.name).toBe('arrow-right');
        collapsed.onPress?.();
        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(openAction).toHaveBeenLastCalledWith(secondary);
    });

    it('keeps non-session Composer controls without consulting session Action placements', () => {
        const newSessionControl = composerControl({
            localId: 'new-session-control',
            definition: {
                label: 'New session control',
                icon: 'add',
                scopes: ['newSession'],
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        const list = vi.fn(() => {
            throw new Error('non-session Composer must not consult session Action rows');
        });
        const controller = {
            list,
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;

        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [newSessionControl],
            composerControlHost: createComposerControlHost({ scope: 'newSession' }),
            includeSessionActions: false,
        });

        expect(list).not.toHaveBeenCalled();
        expect(chips.map((chip) => chip.controlId)).toEqual([
            'plugin:acme.channels/new-session-control',
        ]);
    });

    it('gives adjacent plugin Actions and controls distinct native physical targets while retaining dense web chips', () => {
        const primary = [
            descriptor({ localId: 'configure', placement: 'composer.primary' }),
            descriptor({ localId: 'refresh', placement: 'composer.primary' }),
        ];
        const controller = {
            list: ({ placement }: Readonly<{ placement: string }>) => (placement === 'composer.primary' ? primary : []),
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const chips = createPluginContributedActionComposerChips({
            controller,
            openAction: vi.fn(),
            composerControls: [
                composerControl({ localId: 'first-control' }),
                composerControl({ localId: 'second-control' }),
            ],
            composerControlHost: createComposerControlHost(),
        });
        const context = {
            chipStyle: () => ({ width: 32, height: 32, marginRight: 6, marginBottom: 1 }),
            showLabel: false,
            iconColor: '#fff',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: React.createRef(),
            popoverAnchorRef: React.createRef(),
        };
        const renderFrames = () => chips.map((chip) => {
            const node = chip.render(context);
            if (!React.isValidElement<{
                hitSlop?: unknown;
                style?: (state: Readonly<{ pressed: boolean }>) => unknown;
                testID?: string;
            }>(node)) throw new Error('expected a visible plugin composer chip');
            const style = node.props.style?.({ pressed: false });
            const flattened = (Array.isArray(style) ? style : [style]).reduce<Record<string, unknown>>((result, part) => (
                part && typeof part === 'object' ? { ...result, ...part } : result
            ), {});
            return { hitSlop: node.props.hitSlop, style: flattened, testID: node.props.testID };
        });
        const platform = Platform as unknown as { OS: string };
        const originalPlatform = platform.OS;

        try {
            for (const [nativePlatform, minimumTarget] of [['ios', 44], ['android', 48]] as const) {
                platform.OS = nativePlatform;
                const frames = renderFrames();
                expect(frames.map((frame) => frame.testID)).toEqual([
                    'plugin-composer-action:acme.channels/configure',
                    'plugin-composer-action:acme.channels/refresh',
                    'plugin-composer-control:acme.channels/first-control',
                    'plugin-composer-control:acme.channels/second-control',
                ]);
                for (const frame of frames) {
                    expect(frame.hitSlop).toBeUndefined();
                    expect(frame.style).toMatchObject({ minWidth: minimumTarget, minHeight: minimumTarget });
                }
                const firstRowEnd = Math.max(Number(frames[0]?.style.width ?? 0), Number(frames[0]?.style.minWidth ?? 0));
                const nextRowStart = firstRowEnd + Number(frames[0]?.style.marginRight ?? 0);
                expect(nextRowStart).toBeGreaterThanOrEqual(firstRowEnd);
                const firstColumnEnd = Math.max(Number(frames[0]?.style.height ?? 0), Number(frames[0]?.style.minHeight ?? 0));
                const nextColumnStart = firstColumnEnd + Number(frames[0]?.style.marginBottom ?? 0);
                expect(nextColumnStart).toBeGreaterThanOrEqual(firstColumnEnd);
            }

            platform.OS = 'web';
            for (const frame of renderFrames()) {
                expect(frame.hitSlop).toBeUndefined();
                expect(frame.style).toMatchObject({ width: 32, height: 32 });
                expect(frame.style.minWidth).toBeUndefined();
                expect(frame.style.minHeight).toBeUndefined();
            }
        } finally {
            platform.OS = originalPlatform;
        }
    });
});
