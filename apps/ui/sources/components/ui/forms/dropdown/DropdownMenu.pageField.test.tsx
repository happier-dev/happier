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

vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

// Collect the real component graph before the interaction-test deadline starts.
await import('./DropdownMenu');
await import('@/components/ui/lists/listPresentation');

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
    it('opens the real menu and selects a value through the node portal boundary', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        function Field() {
            const [open, setOpen] = React.useState(false);
            const [value, setValue] = React.useState('priority');
            return <DropdownMenu open={open} onOpenChange={setOpen} selectedId={value}
                items={STRATEGIES.map((item) => ({ ...item, testID: `strategy:${item.id}` }))}
                onSelect={setValue} itemTrigger={{ title: 'Strategy', itemProps: { testID: 'strategy-trigger' } }} />;
        }
        const screen = await renderScreen(<Field />);
        await screen.pressByTestIdAsync('strategy-trigger');
        await vi.waitFor(() => expect(screen.findAllHostsByTestId('strategy:round-robin').length).toBeGreaterThan(0));
        await screen.pressByTestIdAsync('strategy:round-robin');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Round robin'));
        expect(screen.findAllHostsByTestId('strategy:round-robin')).toHaveLength(0);
    });

    it('labels its search field as a plain search unless the caller names what it searches', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { CompactSearchField } = await import('@/components/ui/forms/CompactSearchField');
        const field = (searchPlaceholder?: string) => (
            <DropdownMenu open onOpenChange={() => {}} search {...(searchPlaceholder ? { searchPlaceholder } : {})}
                items={STRATEGIES} selectedId={null} onSelect={() => {}} itemTrigger={{ title: 'Strategy' }} />
        );
        const plain = await renderScreen(field());
        await vi.waitFor(() => expect(plain.findAllByType(CompactSearchField).length).toBe(1));
        // Never the global command palette's prompt.
        expect(plain.findByType(CompactSearchField).props.placeholder).not.toMatch(/commits|messages|actions/i);
        const named = await renderScreen(field('Search strategies'));
        await vi.waitFor(() => expect(named.findAllByType(CompactSearchField).length).toBe(1));
        expect(named.findByType(CompactSearchField).props.placeholder).toBe('Search strategies');
    });

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

    it('keeps a select trailing its label at its content width in a narrow column on a pane or a phone, and stacks it below the narrowest trigger', async () => {
        const fieldBox = (screen: Awaited<ReturnType<typeof renderField>>['screen']) => screen.findAllByType('View' as never)
            .map((node) => flattenTestStyle(node.props.style))
            .find((style) => typeof style.borderWidth === 'number' && style.borderWidth > 0 && typeof style.borderRadius === 'number')!;
        const layoutRow = async (screen: Awaited<ReturnType<typeof renderField>>['screen'], width: number) => {
            const row = screen.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0]!;
            await act(async () => {
                row.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 52 } } });
            });
            return flattenTestStyle(screen.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0]!.props.style).flexDirection;
        };

        // A ~480px pane column beside a receipt (a desktop window): the label keeps its column and the
        // select takes what is left at its content width, as in the lab ("At most [3 ▾]").
        const pane = await renderField({ selectedId: 'round-robin' });
        expect(await layoutRow(pane.screen, 481)).not.toBe('column');
        expect(fieldBox(pane.screen).width).toBeUndefined();
        const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
        // No wider than what the label's column leaves (row insets, gap, label column).
        expect(pane.screen.findAllByType('View' as never).some((node) => flattenTestStyle(node.props.style).maxWidth === 481 - 2 * 16 - HAPPIER_PAGE_METRICS.rowLeadingGapPx - 200)).toBe(true);
        // Below the label's column plus the narrowest trigger it moves beneath.
        expect(await layoutRow(pane.screen, 370)).toBe('column');
        standardCleanup();

        // A phone is held to the same rule as a pane (`resolveHappierPageRowFieldMaxWidth`): the field
        // takes the room beside the label, and moves beneath only when that room is below its narrowest trigger.
        viewport.width = 430;
        viewport.height = 932;
        const phone = await renderField({ selectedId: 'round-robin' });
        expect(await layoutRow(phone.screen, 398)).not.toBe('column');
        expect(await layoutRow(phone.screen, 358)).toBe('column');
    });
});
