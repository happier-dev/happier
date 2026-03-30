import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const windowStub = { innerWidth: 1440 } as Window & typeof globalThis;
(globalThis as unknown as { window: Window & typeof globalThis }).window = windowStub;

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; ios?: T; default?: T }) => values.web ?? values.ios ?? values.default,
            },
            useWindowDimensions: () => ({ width: 1440, height: 900 }),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

describe('SelectionTiles', () => {
    it('supports single selection mode', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        const screen = await renderScreen(<SelectionTiles
            options={[
                { id: 'session_menu', title: 'Session menu' },
                { id: 'command_palette', title: 'Command palette' },
            ]}
            value={null}
            onChange={onChange}
            testIdPrefix="single-select"
        />);
        tree = screen.tree;

        const sessionMenu = screen.findByTestId('single-select:session_menu');
        const commandPalette = screen.findByTestId('single-select:command_palette');
        await act(async () => {
            await pressTestInstanceAsync(commandPalette, 'single-select:command_palette');
        });

        expect(sessionMenu!.props.accessibilityRole).toBe('radio');
        expect(sessionMenu!.props.accessibilityState).toEqual({ selected: false, disabled: false });
        expect(commandPalette!.props.accessibilityRole).toBe('radio');
        expect(onChange).toHaveBeenCalledWith('command_palette');
    });

    it('renders option footers when a renderer is provided', async () => {
        const onChange = vi.fn();
        const renderOptionFooter = vi.fn((params: { option: { id: string }; selected: boolean; disabled: boolean }) => {
            if (!params.selected) {
                return null;
            }
            return React.createElement('Text', { testID: `footer:${params.option.id}` }, 'Footer');
        });
        const { SelectionTiles } = await import('./SelectionTiles');

        const screen = await renderScreen(<SelectionTiles
            options={[
                { id: 'a', title: 'A' },
                { id: 'b', title: 'B' },
            ]}
            value={'a'}
            onChange={onChange}
            renderOptionFooter={renderOptionFooter}
            testIdPrefix="footer-select"
        />);

        expect(() => screen.tree.findByProps({ testID: 'footer:a' })).not.toThrow();
        expect(() => screen.tree.findByProps({ testID: 'footer:b' })).toThrow();
        expect(renderOptionFooter).toHaveBeenCalled();
    });

    it('lets footer switches trigger their own change handlers', async () => {
        const onChange = vi.fn();
        const onFooterChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');
        const { Pressable } = await import('react-native');

        const screen = await renderScreen(<SelectionTiles
            options={[
                { id: 'mcp', title: 'MCP' },
            ]}
            value={['mcp']}
            onChange={onChange}
            renderOptionFooter={({ selected }) => selected ? (
                <Pressable testID="footer-switch" onPress={onFooterChange}>
                </Pressable>
            ) : null}
            testIdPrefix="footer-switch-select"
            selectionMode="multiple"
        />);

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('footer-switch'), 'footer-switch');
        });

        expect(onFooterChange).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('supports multiple selection mode and toggles selected values', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        const screen = await renderScreen(<SelectionTiles
            selectionMode="multiple"
            options={[
                { id: 'voice_panel', title: 'Voice panel' },
                { id: 'mcp', title: 'MCP' },
            ]}
            value={['voice_panel']}
            onChange={onChange}
            testIdPrefix="multi-select"
        />);
        tree = screen.tree;

        const voicePanel = screen.findByTestId('multi-select:voice_panel');
        const mcp = screen.findByTestId('multi-select:mcp');
        await act(async () => {
            await pressTestInstanceAsync(mcp, 'multi-select:mcp');
        });
        await act(async () => {
            await pressTestInstanceAsync(voicePanel, 'multi-select:voice_panel');
        });

        expect(voicePanel!.props.accessibilityRole).toBe('checkbox');
        expect(voicePanel!.props.accessibilityState).toEqual({ checked: true, disabled: false });
        expect(mcp!.props.accessibilityRole).toBe('checkbox');
        expect(mcp!.props.accessibilityState).toEqual({ checked: false, disabled: false });
        expect(onChange).toHaveBeenNthCalledWith(1, ['voice_panel', 'mcp']);
        expect(onChange).toHaveBeenNthCalledWith(2, []);
    });

    it('does not toggle disabled options', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        const screen = await renderScreen(<SelectionTiles
            selectionMode="multiple"
            options={[
                { id: 'voice_tool', title: 'Voice tool', disabled: true, badge: 'Unavailable' },
            ]}
            value={[]}
            onChange={onChange}
            testIdPrefix="disabled-select"
        />);
        tree = screen.tree;

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('disabled-select:voice_tool'), 'disabled-select:voice_tool');
        });

        expect(onChange).not.toHaveBeenCalled();
    });

    it('assigns stable tile test ids when a prefix is provided', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SelectionTiles
                    options={[
                        { id: 'build', title: 'Build' },
                        { id: 'review', title: 'Review' },
                    ]}
                    value={'build'}
                    onChange={onChange}
                    testIdPrefix="engine-mode"
                />)).tree;

        expect(() => tree.findByProps({ testID: 'engine-mode:build' })).not.toThrow();
        expect(() => tree.findByProps({ testID: 'engine-mode:review' })).not.toThrow();
    });

    it('uses two columns for medium-width compact three-option layouts', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SelectionTiles
                    options={[
                        { id: 'a', title: 'A' },
                        { id: 'b', title: 'B' },
                        { id: 'c', title: 'C' },
                    ]}
                    density="compact"
                    value={'a'}
                    onChange={onChange}
                    testIdPrefix="medium-grid"
                />)).tree;

        const grid = tree.findByType('View' as any);
        await act(async () => {
            grid.props.onLayout?.({
                nativeEvent: {
                    layout: { width: 300, height: 120, x: 0, y: 0 },
                },
            });
        });

        const optionA = tree.findAll((node) => node.props?.testID === 'medium-grid:a' && typeof node.props?.style === 'function')[0];
        const resolvedStyle = optionA.props.style({ pressed: false });
        const flattenedStyle = Object.assign(
            {},
            ...(Array.isArray(resolvedStyle)
                ? resolvedStyle.filter(Boolean)
                : [resolvedStyle].filter(Boolean)),
        );

        expect(flattenedStyle.width).toBe(145);
    });

    it('uses a multi-column compact fallback before a layout measurement is available on web', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SelectionTiles
                    options={[
                        { id: 'a', title: 'A' },
                        { id: 'b', title: 'B' },
                        { id: 'c', title: 'C' },
                        { id: 'd', title: 'D' },
                    ]}
                    density="compact"
                    value={'a'}
                    onChange={onChange}
                    testIdPrefix="fallback-grid"
                />)).tree;

        const optionA = tree.findAll((node) => node.props?.testID === 'fallback-grid:a' && typeof node.props?.style === 'function')[0];
        const resolvedStyle = optionA.props.style({ pressed: false });
        const flattenedStyle = Object.assign(
            {},
            ...(Array.isArray(resolvedStyle)
                ? resolvedStyle.filter(Boolean)
                : [resolvedStyle].filter(Boolean)),
        );

        expect(flattenedStyle.width).toBe('48%');
        expect(flattenedStyle.maxWidth).toBe('48%');
        expect(flattenedStyle.flexGrow).toBe(0);
        expect(flattenedStyle.flexShrink).toBe(0);
    });

    it('keeps a forced two-column compact layout at narrower measured widths for popover model grids', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SelectionTiles
                    options={[
                        { id: 'a', title: 'A' },
                        { id: 'b', title: 'B' },
                        { id: 'c', title: 'C' },
                        { id: 'd', title: 'D' },
                    ]}
                    density="compact"
                    value={'a'}
                    onChange={onChange}
                    minimumColumns={2}
                    testIdPrefix="forced-grid"
                />)).tree;

        const grid = tree.findByType('View' as any);
        await act(async () => {
            grid.props.onLayout?.({
                nativeEvent: {
                    layout: { width: 240, height: 120, x: 0, y: 0 },
                },
            });
        });

        const optionA = tree.findAll((node) => node.props?.testID === 'forced-grid:a' && typeof node.props?.style === 'function')[0];
        const resolvedStyle = optionA.props.style({ pressed: false });
        const flattenedStyle = Object.assign(
            {},
            ...(Array.isArray(resolvedStyle)
                ? resolvedStyle.filter(Boolean)
                : [resolvedStyle].filter(Boolean)),
        );

        expect(flattenedStyle.width).toBe(115);
    });

});
