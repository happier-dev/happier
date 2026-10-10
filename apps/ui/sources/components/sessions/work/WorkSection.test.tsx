import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { StyleSheet, Text, View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    HAPPIER_WORK_PANE_METRICS,
    HappierPageSheetGroup,
    HappierWorkSection,
    useHappierPageSection,
} from '@happier-dev/plugin-ui/presentation';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(standardCleanup);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => (params && 'count' in params ? `${key}:${String(params.count)}` : key) });
});

// The Action executor is the outward write boundary; nothing a section draws here executes an Action.
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));

// The user's list density is a stored local setting (storage boundary); the density owner itself runs.
vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return { useLocalSetting: createUseLocalSettingMock({ values: { uiItemDensity: 'cozy', uiFontScale: 1 } }) };
});

const { WorkSection, WorkFlatSheet, WorkSectionEmptyLine } = await import('./WorkSection');
const { Item } = await import('@/components/ui/lists/Item');
const { CollectionListGroupLabel } = await import('@/components/ui/lists/collection/CollectionList');

/** A row as the section's rows see it: the sheet's row inset, and whether it was asked for a hairline. */
function ProbeRow(props: Readonly<{ id: string; showDivider?: boolean }>) {
    const section = useHappierPageSection();
    return (
        <View testID={props.id}>
            <Text>{`${props.id}|inset:${String(section?.rowInsetPx)}|divider:${props.showDivider === true ? 'yes' : 'no'}`}</Text>
        </View>
    );
}

/** Whether a rendered node is (a memo of) the given shared component. */
function rendersThrough(node: ReactTestInstance, component: unknown): boolean {
    return node.type === component || node.type === (component as { type?: unknown }).type;
}

function separators(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => typeof node.type === 'string' && node.props.role === 'separator');
}

describe('WorkSectionEmptyLine', () => {
    it('is the section\'s way to start when it can be pressed, and only a statement otherwise', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <WorkSection testID="notes" anatomy="page" title="Notes" count="">
                <WorkSectionEmptyLine testID="notes.add" text="Add notes" onPress={onPress} />
                <WorkSectionEmptyLine testID="context.empty" text="Nothing added yet" />
            </WorkSection>,
        );
        const start = screen.findByTestId('notes.add');
        expect(start?.props.accessibilityRole).toBe('button');
        await screen.pressByTestIdAsync('notes.add');
        expect(onPress).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('context.empty')?.props.accessibilityRole).toBeUndefined();
        expect(screen.getTextContent()).toContain('Nothing added yet');
    });
});

describe('WorkSection', () => {
    it('draws a configuration section flat on the pane: a full-width hairline, title · quiet count · ⓘ · one action, rows on the list inset with no hairlines', async () => {
        const screen = await renderScreen(
            <WorkSection
                testID="triggers"
                anatomy="page"
                title="Triggers"
                count="5 on"
                info="Triggers run when something happens in this session."
                action={<View testID="triggers-add" />}
            >
                <HappierPageSheetGroup header={<CollectionListGroupLabel title="When a turn ends" count={2} />}>
                    <ProbeRow id="review" />
                    <ProbeRow id="notify" />
                </HappierPageSheetGroup>
                <HappierPageSheetGroup header={<CollectionListGroupLabel title="When the session starts" />}>
                    <ProbeRow id="prepare" />
                </HappierPageSheetGroup>
            </WorkSection>,
        );

        const text = screen.getTextContent();
        expect(text).toContain('Triggers');
        expect(text).toContain('5 on');
        expect(screen.findByTestId('triggers-add')).not.toBeNull();
        const info = screen.findByTestId('triggers-info');
        expect(info?.props.accessibilityLabel).toBe('Triggers run when something happens in this session.');

        // Rows sit on the Work list's own inset and draw no hairlines; one light separator divides the
        // two groups.
        for (const id of ['review', 'notify', 'prepare']) {
            expect(text).toContain(`${id}|inset:${HAPPIER_WORK_PANE_METRICS.rowInsetPx}|divider:no`);
        }
        expect(separators(screen)).toHaveLength(1);
        // The event reads before its rows.
        expect(text.indexOf('When a turn ends')).toBeLessThan(text.indexOf('review|'));
    });

    it('keeps a live-list section compact: the status title and its count, no hairline, no sheet', async () => {
        const screen = await renderScreen(
            <WorkSection testID="working" title="Working" count={6}>
                <ProbeRow id="api" />
            </WorkSection>,
        );

        expect(screen.getTextContent()).toContain('Working');
        // Core draws its Work sections through the one shared owner plugin authors use.
        expect(screen.findAll((node) => rendersThrough(node, HappierWorkSection))).toHaveLength(1);
        expect(screen.findByTestId('working-info')).toBeNull();
        const section = StyleSheet.flatten(screen.findHostByTestId('working')?.props.style);
        expect(section.borderTopColor).toBeUndefined();
        // Not a sheet: its rows keep their own list anatomy.
        expect(screen.getTextContent()).toContain('api|inset:undefined');
    });

    it('lays its real Item rows out as page rows: a stacked control sits under the label, as on a configuration page', async () => {
        const screen = await renderScreen(
            <View>
                <WorkFlatSheet testID="top">
                    <Item testID="goal" title="Goal" accessoryLayout="stacked" rightElement={<View testID="goal-field" />} />
                </WorkFlatSheet>
                <WorkSection testID="notes" anatomy="page" title="Notes" count="">
                    <Item testID="note" title="Note" accessoryLayout="stacked" rightElement={<View testID="note-field" />} />
                </WorkSection>
            </View>,
        );
        // A page row lays a stacked control beneath its label (the row is a column); a grouped row keeps
        // it inline beside the label (the row stays a row).
        const nearestHostView = (node: ReactTestInstance) => {
            let parent = node.parent;
            while (parent && typeof parent.type !== 'string') parent = parent.parent;
            if (!parent) throw new Error('Expected a host View around the node');
            return parent;
        };
        for (const field of ['goal-field', 'note-field']) {
            const accessory = nearestHostView(screen.findHostByTestId(field)!);
            const row = nearestHostView(accessory);
            expect(StyleSheet.flatten(row.props.style)?.flexDirection).toBe('column');
        }
        // No row hairlines on either flat Work surface, even though each contains a real Item.
        expect(separators(screen)).toHaveLength(0);
    });

    it('gives adaptive real Item controls the page measurement boundary in both Work surfaces', async () => {
        const screen = await renderScreen(
            <View>
                <WorkFlatSheet>
                    <Item testID="role" title="Role" accessoryLayout="adaptive" rightElement={<View testID="role-select" />} />
                </WorkFlatSheet>
                <WorkSection testID="roles" anatomy="page" title="Roles" count="">
                    <Item testID="engine" title="Engine" accessoryLayout="adaptive" rightElement={<View testID="engine-select" />} />
                </WorkSection>
                <WorkSection testID="working" title="Working" count="">
                    <Item testID="live" title="Live work" accessoryLayout="adaptive" rightElement={<View testID="live-select" />} />
                </WorkSection>
            </View>,
        );
        // Adaptive page rows measure both row width and accessory width.
        // Grouped live-list rows stay inline without either measurement.
        for (const id of ['role', 'engine']) {
            const row = screen.findHostByTestId(id)!;
            expect(row.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')).toHaveLength(2);
        }
        expect(screen.findHostByTestId('live')!.findAll((node) => typeof node.type === 'string'
            && typeof node.props.onLayout === 'function')).toHaveLength(0);
    });
});
