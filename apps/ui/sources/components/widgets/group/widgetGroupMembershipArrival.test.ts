import { describe, expect, it } from 'vitest';
import type { WidgetLayoutGroupV1, WidgetLayoutItemV1, WidgetLayoutWidgetV1 } from '@happier-dev/protocol/widgets';

import { resolveWidgetGroupMembershipArrivals } from './widgetGroupMembershipArrival';

const widget = (id: string): WidgetLayoutWidgetV1 => ({ kind: 'widget', instance: { v: 1, id, definition: { kind: 'builtin', id: 'changes' }, bindings: {} }, size: 'small' });
const group = (id: string, ...children: string[]): WidgetLayoutGroupV1 => ({ kind: 'group', id, width: 'full', frameStyle: 'card', dividers: 'hairline', children: children.map(widget) });
const arrivals = (previous: readonly WidgetLayoutItemV1[] | null, next: readonly WidgetLayoutItemV1[]) =>
    Object.fromEntries(resolveWidgetGroupMembershipArrivals(previous, next));

describe('group membership arrivals (lab widget-groups: Ungroup fans out, Group with merges)', () => {
    it('moves nothing when a layout first arrives or only its order changes', () => {
        const items = [group('g', 'a', 'b'), widget('c')];
        expect(arrivals(null, items)).toEqual({});
        expect(arrivals(items, [widget('c'), group('g', 'a', 'b')])).toEqual({});
        expect(arrivals(items, [group('g', 'b', 'a'), widget('c')])).toEqual({});
    });
    it('fans the widgets of an ungrouped group out in their order, and leaves their neighbours still', () => {
        expect(arrivals([group('g', 'a', 'b'), widget('c')], [widget('a'), widget('b'), widget('c')]))
            .toEqual({ a: { kind: 'ungrouped', order: 0 }, b: { kind: 'ungrouped', order: 1 } });
    });
    it('merges cards into a new group: the group arrives once, its widgets do not arrive on their own', () => {
        expect(arrivals([widget('a'), widget('b'), widget('c')], [group('g', 'a', 'b'), widget('c')]))
            .toEqual({ g: { kind: 'grouped', order: 0 } });
    });
    it('treats one widget leaving or joining an existing group as a move, not as an ungroup or a merge', () => {
        expect(arrivals([group('g', 'a', 'b'), widget('c')], [group('g', 'a'), widget('b'), widget('c')])).toEqual({});
        expect(arrivals([group('g', 'a'), widget('b')], [group('g', 'a', 'b')])).toEqual({});
        // A widget added from Add, or a saved group added whole, is an arrival of its own kind (the frame's ring), not this one.
        expect(arrivals([widget('a')], [widget('a'), widget('new'), group('saved', 'x', 'y')])).toEqual({});
    });
});
