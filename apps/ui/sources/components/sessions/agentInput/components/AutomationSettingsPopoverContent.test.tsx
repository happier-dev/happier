import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import Yoga, { type Node } from 'yoga-layout';

import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const popoverBoundaryRef = { current: { nodeType: 'AutomationBoundary' } } as React.RefObject<any>;

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Platform: {
                OS: 'ios',
                select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: '#f5f5f5', sectionTitle: '#666' },
                    input: { background: '#fff', placeholder: '#888' },
                    surface: '#ffffff',
                    divider: '#ddd',
                    text: '#111',
                    textSecondary: '#666',
                },
            },
        });
    },
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key, params) => params ? key : key });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']));
vi.mock('@/components/ui/forms/FieldItem', () => createPassThroughModule(['FieldItem']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => popoverBoundaryRef,
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));

type LayoutStyle = Readonly<Record<string, unknown>>;

function flattenLayoutStyle(style: unknown): LayoutStyle {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenLayoutStyle));
    return style && typeof style === 'object' ? style as LayoutStyle : {};
}

function hostChildren(node: ReactTestInstance): ReactTestInstance[] {
    return node.children.flatMap((child) => {
        if (typeof child === 'string') return [];
        return typeof child.type === 'string' ? [child] : hostChildren(child);
    });
}

type YogaLength = number | `${number}%`;

function isYogaLength(value: unknown): value is YogaLength {
    return typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value));
}

function applyFlexStyle(node: Node, style: LayoutStyle) {
    if (style.flexDirection === 'row') node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    if (style.flexWrap === 'wrap') node.setFlexWrap(Yoga.WRAP_WRAP);
    if (style.alignItems === 'flex-start') node.setAlignItems(Yoga.ALIGN_FLEX_START);
    if (typeof style.gap === 'number') node.setGap(Yoga.GUTTER_ALL, style.gap);
    if (typeof style.flexGrow === 'number') node.setFlexGrow(style.flexGrow);
    if (typeof style.flexShrink === 'number') node.setFlexShrink(style.flexShrink);
    if (isYogaLength(style.flexBasis)) node.setFlexBasis(style.flexBasis);
    if (isYogaLength(style.minWidth)) node.setMinWidth(style.minWidth);
    if (isYogaLength(style.maxWidth)) node.setMaxWidth(style.maxWidth);
}

// Lays the real interval editor grid styles out with React Native's layout engine. OS text and
// control measurement is the boundary: the stepper is the width measured on a 1080px Android
// phone (#736), and the presets need roughly one line of eight pills before they wrap.
function layoutIntervalEditor(params: Readonly<{
    panelInnerWidth: number;
    grid: LayoutStyle;
    editorGroup: LayoutStyle;
    presetGroup: LayoutStyle;
}>) {
    const root = Yoga.Node.create();
    const grid = Yoga.Node.create();
    const editorGroup = Yoga.Node.create();
    const stepper = Yoga.Node.create();
    const presetGroup = Yoga.Node.create();
    const presetContent = Yoga.Node.create();
    try {
        root.setWidth(params.panelInnerWidth);
        applyFlexStyle(grid, params.grid);
        applyFlexStyle(editorGroup, params.editorGroup);
        applyFlexStyle(presetGroup, params.presetGroup);
        stepper.setWidth(217);
        stepper.setHeight(42);
        const presetLineWidth = 392;
        presetContent.setMeasureFunc((width, widthMode) => {
            if (widthMode === Yoga.MEASURE_MODE_UNDEFINED || width >= presetLineWidth) {
                return { width: presetLineWidth, height: 30 };
            }
            return { width, height: 30 * Math.ceil(presetLineWidth / Math.max(width, 1)) };
        });
        root.insertChild(grid, 0);
        grid.insertChild(editorGroup, 0);
        grid.insertChild(presetGroup, 1);
        editorGroup.insertChild(stepper, 0);
        presetGroup.insertChild(presetContent, 0);
        root.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
        return {
            editor: editorGroup.getComputedLayout(),
            presets: presetGroup.getComputedLayout(),
        };
    } finally {
        root.freeRecursive();
    }
}

describe('AutomationSettingsPopoverContent', () => {
    it('keeps the enable toggle header and replaces the form body with sentence controls', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: 'Nightly',
                description: 'Run nightly work',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            }}
            onChange={() => {}}
        />);

        const enableItem = screen.findByType('Item' as any);
        const toggle = enableItem.props.rightElement;
        expect(toggle?.props?.value).toBe(true);

        expect(screen.findAllByType('AutomationSettingsForm' as any)).toHaveLength(0);
        expect(screen.findByProps({ testID: 'automation-sentence-name-input' }).props.value).toBe('Nightly');
        expect(screen.findByProps({ testID: 'automation-sentence-schedule-trigger' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-sentence-notes-input' }).props.value).toBe('Run nightly work');
    });

    it('keeps details collapsed when disabled', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        expect(screen.findByType('Item' as any).props.rightElement?.props?.value).toBe(false);
        expect(screen.findAllByProps({ testID: 'automation-sentence-name-input' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'automation-sentence-schedule-trigger' })).toHaveLength(0);
    });

    it('lets users choose hour presets, enter day intervals, and switch to cron from the sentence schedule editor', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const onChange = vi.fn();
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={onChange}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-sentence-schedule-trigger' }).props.onPress();
        });
        screen.findByProps({ testID: 'automation-schedule-preset-120' }).props.onPress();
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'interval',
            everyMinutes: 120,
        }));

        const unitDropdown = screen.findByType('DropdownMenu' as any);
        expect(unitDropdown.props).toEqual(expect.objectContaining({
            popoverBoundaryRef,
            connectToTrigger: true,
        }));
        expect('popoverPortalWebTarget' in unitDropdown.props).toBe(false);

        unitDropdown.props.onSelect('days');
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'interval',
            everyMinutes: 24 * 60,
        }));

        screen.findByProps({ testID: 'automation-schedule-use-cron' }).props.onPress();
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'cron',
        }));
    });

    it('moves interval presets onto their own full-width row when the panel is too narrow for both columns', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-sentence-schedule-trigger' }).props.onPress();
        });

        const panel = screen.findByProps({ testID: 'automation-schedule-frequency-popover' });
        const grid = panel.find((node) =>
            typeof node.type === 'string'
            && flattenLayoutStyle(node.props.style).flexWrap === 'wrap'
            && node.findAll((child) => child.props?.testID === 'automation-interval-minutes-input').length > 0
            && node.findAll((child) => child.props?.testID === 'automation-schedule-preset-5').length > 0);
        const [editorGroup, presetGroup] = hostChildren(grid);
        if (!editorGroup || !presetGroup) throw new Error('Missing interval editor columns');
        const styles = {
            grid: flattenLayoutStyle(grid.props.style),
            editorGroup: flattenLayoutStyle(editorGroup.props.style),
            presetGroup: flattenLayoutStyle(presetGroup.props.style),
        };

        for (const panelInnerWidth of [238, 270]) {
            const { editor, presets } = layoutIntervalEditor({ panelInnerWidth, ...styles });
            expect(presets.left).toBe(0);
            expect(presets.top).toBeGreaterThanOrEqual(editor.top + editor.height);
            expect(presets.width).toBe(panelInnerWidth);
        }

        const wide = layoutIntervalEditor({ panelInnerWidth: 600, ...styles });
        expect(wide.presets.top).toBe(wide.editor.top);
        expect(wide.presets.left).toBeGreaterThan(wide.editor.left + wide.editor.width);
        expect(wide.presets.left + wide.presets.width).toBe(600);
    });

    it('shows a compact cron field guide inside the cron editor', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'cron',
                everyMinutes: 60,
                cronExpr: '0 9 * * 1-5',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-sentence-schedule-trigger' }).props.onPress();
        });

        expect(screen.findByProps({ testID: 'automation-cron-field-guide' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-minute' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-hour' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-dayOfMonth' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-month' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-weekday' })).toBeTruthy();
    });
});
