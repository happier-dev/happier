import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

const inputFocus = vi.hoisted(() => ({ calls: 0 }));

// The app `TextInput` adds font scaling (a settings boundary); the host input's focus handle is what
// the field's frame drives.
vi.mock('@/components/ui/text/Text', () => ({
    TextInput: React.forwardRef((props: Record<string, unknown>, ref) => {
        React.useImperativeHandle(ref, () => ({ focus: () => { inputFocus.calls += 1; } }), []);
        return React.createElement('TextInput', props);
    }),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: () => null,
    ICON_SIZE: { xs: 14 },
}));

// Resolve the source dependency closure during collection, outside each interaction test's clock.
await import('./CompactSearchField');

describe('CompactSearchField', () => {
    it('applies caller geometry through a native layout wrapper without restyling the shared field', async () => {
        const { CompactSearchField } = await import('./CompactSearchField');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const geometry = { flex: 1, minWidth: 0, marginLeft: 4, maxWidth: '100%' as const };
        const screen = await renderScreen(
            <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" style={geometry} />,
        );
        const wrapper = screen.findByTestId('search.layout');
        expect(wrapper).not.toBeNull();
        expect(flattenTestStyle(wrapper!.props.style)).toMatchObject(geometry);
        const field = screen.findByTestId('search.field');
        expect(flattenTestStyle(field!.props.style)).not.toHaveProperty('marginLeft');
        expect(field!.props.onPress).toEqual(expect.any(Function));
    });

    it('runs an explicit search on submit and stays read-only while the list cannot be searched', async () => {
        const onSubmit = vi.fn();
        const { CompactSearchField } = await import('./CompactSearchField');
        const screen = await renderScreen(
            <CompactSearchField
                testID="search"
                value="triage"
                onChangeText={() => {}}
                placeholder="Search every source"
                onSubmitEditing={onSubmit}
                editable={false}
            />,
        );
        const input = screen.tree.root.findByType('TextInput' as never);
        expect(input.props.editable).toBe(false);
        expect(input.props.returnKeyType).toBe('search');
        await act(async () => {
            (input.props.onSubmitEditing as () => void)();
        });
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('filters as the user types when no explicit search is wired', async () => {
        const { CompactSearchField } = await import('./CompactSearchField');
        const screen = await renderScreen(
            <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" />,
        );
        const input = screen.tree.root.findByType('TextInput' as never);
        expect(input.props.returnKeyType).toBeUndefined();
        expect(input.props.onSubmitEditing).toBeUndefined();
    });

    it('leaves keyboard focus to the input: the frame around it is not a tab stop', async () => {
        // On web a Pressable is a tab stop by default; a focused frame shows the browser's ring and no
        // caret, and a dialog's initial focus would land on it instead of the input.
        const { CompactSearchField } = await import('./CompactSearchField');
        const screen = await renderScreen(
            <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" />,
        );
        const frame = screen.findByTestId('search.field');
        expect(frame?.props.tabIndex).toBe(-1);
    });

    it('focuses the input when the field around it is tapped (icon, padding, border)', async () => {
        inputFocus.calls = 0;
        const { CompactSearchField } = await import('./CompactSearchField');
        const screen = await renderScreen(
            <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" />,
        );
        const frame = screen.findByTestId('search.field');
        if (!frame) throw new Error('Missing search field frame');
        await act(async () => {
            (frame.props.onPress as () => void)();
        });
        expect(inputFocus.calls).toBe(1);
        // The frame is not a second control for assistive technology or the keyboard.
        expect(frame.props.accessible).toBe(false);
        expect(frame.props.focusable).toBe(false);
    });

    it('draws the compact 32px field on every platform; a finger reaches it through the hit area', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const { CompactSearchField } = await import('./CompactSearchField');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const minHeightOn = async (platform: 'ios' | 'android' | 'web') => {
            const screen = await renderScreen(
                <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                    <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" />
                </HappierUiPlatformProvider>,
            );
            const value = flattenTestStyle(screen.findByTestId('search.field')!.props.style).minHeight;
            await screen.unmount();
            return value;
        };
        // A touch target is a hit area, not a drawn size (DESIGN.md): the well keeps the lab's 32px.
        expect(await minHeightOn('ios')).toBe(32);
        expect(await minHeightOn('android')).toBe(32);
        expect(await minHeightOn('web')).toBe(32);
    });

    it('draws one compact frame: no vertical padding past its height and a 10px leading inset for the glass', async () => {
        const { CompactSearchField, COMPACT_SEARCH_FIELD_METRICS } = await import('./CompactSearchField');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const screen = await renderScreen(<CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" />);
        const field = flattenTestStyle(screen.findByTestId('search.field')!.props.style);
        expect(field.paddingLeft ?? field.paddingHorizontal).toBe(10);
        expect(field.paddingVertical ?? 0).toBe(0);
        expect(COMPACT_SEARCH_FIELD_METRICS.heightPx).toBe(32);
        expect(COMPACT_SEARCH_FIELD_METRICS.iconInsetPx).toBe(10);
    });
});

describe('CompactSearchField placement above a page list', () => {
    it('sits in the page content column, aligned with the sheets, instead of spanning the pane', async () => {
        const { CompactSearchField } = await import('./CompactSearchField');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const { PAGE_COLUMN_MAX_WIDTH_PX } = await import('@/components/ui/layout/contentWidthMode');
        const { resolveItemGroupContentHorizontalInsetPx } = await import('@/components/ui/lists/itemGroupSpacing');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" placement="page" />
            </ListPresentationProvider>,
        );
        const column = screen.tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'search.column')[0];
        expect(column).toBeDefined();
        const style = flattenTestStyle(column!.props.style) as Record<string, unknown>;
        // The same column the page's sheets use: capped at the page column, centred, with the sheet inset.
        expect(typeof style.maxWidth).toBe('number');
        expect(style.maxWidth as number).toBeLessThanOrEqual(PAGE_COLUMN_MAX_WIDTH_PX.reading);
        expect(style.width).toBe('100%');
        // Centred in a band that spans the list header, as ItemGroup centres its sheets.
        const band = flattenTestStyle(column!.parent!.props.style) as Record<string, unknown>;
        expect(band.alignSelf).toBe('stretch');
        expect(band.alignItems).toBe('center');
        expect(style.paddingHorizontal).toBe(resolveItemGroupContentHorizontalInsetPx());
    });

    it('puts its accessory beside the field, or under it at full width where a phone has no room beside', async () => {
        const { CompactSearchField } = await import('./CompactSearchField');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const accessory = React.createElement('View', { testID: 'select' });
        const place = async (accessoryPlacement?: 'beside' | 'below') => {
            const screen = await renderScreen(
                <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" accessory={accessory}
                    {...(accessoryPlacement ? { accessoryPlacement } : {})} />,
            );
            const select = screen.findByTestId('select')!;
            return flattenTestStyle(select.parent!.props.style);
        };
        expect(await place()).toMatchObject({ flexDirection: 'row' });
        expect(await place('below')).toMatchObject({ alignItems: 'stretch' });
        expect(await place('below')).not.toHaveProperty('flexDirection', 'row');
    });

    it('adds no column of its own where it is placed inline (a rail or a section row)', async () => {
        const { CompactSearchField } = await import('./CompactSearchField');
        const screen = await renderScreen(
            <CompactSearchField testID="search" value="" onChangeText={() => {}} placeholder="Search" />,
        );
        expect(screen.tree.root.findAll((node) => node.props.testID === 'search.column')).toHaveLength(0);
    });
});
