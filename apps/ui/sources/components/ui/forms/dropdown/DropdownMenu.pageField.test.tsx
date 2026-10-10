import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewport = vi.hoisted(() => ({ width: 1280, height: 900 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Dimensions: {
            get: () => ({ width: viewport.width, height: viewport.height, scale: 2, fontScale: 1 }),
            addEventListener: () => ({ remove: () => {} }),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

afterEach(() => {
    standardCleanup();
    viewport.width = 1280;
    viewport.height = 900;
});

const STRATEGIES = [
    { id: 'priority', title: 'Priority order' },
    { id: 'round-robin', title: 'Round robin' },
    { id: 'retired', title: 'Least used', disabled: true },
];

type TriggerOverrides = Readonly<{ showSelectedDetail?: boolean; subtitle?: string; itemProps?: Readonly<{ accessoryLayout?: 'inline' | 'stacked' | 'adaptive' }> }>;

async function renderField(params: Readonly<{
    presentation?: 'page' | 'grouped';
    selectedId: string | null;
    trigger?: TriggerOverrides;
}>) {
    const { DropdownMenu } = await import('./DropdownMenu');
    const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
    const screen = await renderScreen(
        <ListPresentationProvider value={params.presentation ?? 'page'}>
            <DropdownMenu
                open={false}
                onOpenChange={() => {}}
                items={STRATEGIES}
                selectedId={params.selectedId}
                onSelect={() => {}}
                itemTrigger={{ title: 'Strategy', ...(params.trigger ?? {}) }}
            />
        </ListPresentationProvider>,
    );
    const texts = screen.findAllByType('Text' as never).map((node) => node.props.children).filter((child) => typeof child === 'string');
    const hasFieldBox = screen.findAllByType('View' as never).some((node) => {
        const style = flattenTestStyle(node.props.style);
        return typeof style.borderWidth === 'number' && style.borderWidth > 0 && typeof style.borderRadius === 'number';
    });
    return { texts, hasFieldBox, screen };
}

describe('DropdownMenu page field', () => {
    it('shows the selected value in the field', async () => {
        const { texts, hasFieldBox } = await renderField({ selectedId: 'round-robin' });
        expect(hasFieldBox).toBe(true);
        expect(texts).toContain('Round robin');
        expect(texts).not.toContain('Choose…');
    });

    it('shows the selected value even when the row asks not to repeat it as detail', async () => {
        const { texts } = await renderField({
            selectedId: 'round-robin',
            trigger: { showSelectedDetail: false, subtitle: 'Round robin' },
        });
        expect(texts).not.toContain('Choose…');
        // The field carries the value; the description does not say it a second time.
        expect(texts.filter((text) => text === 'Round robin')).toHaveLength(1);
    });

    it('shows a selected option that can no longer be chosen instead of an empty field', async () => {
        const { texts } = await renderField({ selectedId: 'retired' });
        expect(texts).toContain('Least used');
        expect(texts).not.toContain('Choose…');
    });

    it('asks for a choice only when nothing is selected', async () => {
        const { texts } = await renderField({ selectedId: null });
        expect(texts).toContain('Choose…');
    });

    it('keeps the selected value in its field on phone widths, moved below the label when the row is narrow', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { texts, hasFieldBox, screen } = await renderField({ selectedId: 'round-robin' });
        expect(hasFieldBox).toBe(true);
        expect(texts).toContain('Round robin');

        // The row measures its width (R9): a phone-width row stacks the value under the label instead of
        // pushing it off the side of the screen.
        const measured = screen.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
        expect(measured.length).toBeGreaterThan(0);
        const row = measured[0]!;
        await act(async () => {
            row.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 52 } } });
        });
        const rowAfter = screen.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0]!;
        expect(flattenTestStyle(rowAfter.props.style).flexDirection).toBe('column');
    });

    it('keeps the grouped trigger unchanged outside page presentation (menus, sheets)', async () => {
        const { texts, hasFieldBox } = await renderField({
            presentation: 'grouped',
            selectedId: 'round-robin',
            trigger: { showSelectedDetail: false, subtitle: 'Round robin' },
        });
        expect(hasFieldBox).toBe(false);
        expect(texts).not.toContain('Choose…');
        expect(texts.filter((text) => text === 'Round robin')).toHaveLength(1);
    });

    it('spans the row with a field its row stacks under the label, and keeps its own width beside it', async () => {
        const { HappierFieldBoxTrigger } = await import('@happier-dev/plugin-ui/presentation');
        const stacked = await renderField({ selectedId: null, trigger: { itemProps: { accessoryLayout: 'stacked' } } });
        expect(stacked.screen.findAllByType(HappierFieldBoxTrigger)[0]!.props.span).toBe('row');
        standardCleanup();
        const inline = await renderField({ selectedId: null, trigger: { itemProps: { accessoryLayout: 'inline' } } });
        expect(inline.screen.findAllByType(HappierFieldBoxTrigger)[0]!.props.span).not.toBe('row');
    });
});
