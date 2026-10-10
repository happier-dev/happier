import { describe, expect, it } from 'vitest';
import type { WidgetLayoutItemV1, WidgetLayoutWidgetV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { resolveWidgetAreaEntityDrop } from './widgetAreaEntityDrop';

const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'owner', owner: { kind: 'project', projectId: 'project' } };
const entry = (id: string, area: 'main' | 'aside'): WidgetLayoutWidgetV1 => ({
    kind: 'widget',
    instance: { v: 1, id, definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} }, area,
});
const placements = [entry('main-a', 'main'), entry('main-b', 'main'), entry('aside-a', 'aside'), entry('aside-b', 'aside')];
const item = { kind: 'widget-area-instance' as const, scope: { serverId: 'home', accountId: 'owner' }, ref: { surface, instanceId: 'main-a' } };
const preview = { verb: 'Move', target: 'Aside' };

describe('layout group destinations', () => {
    const widget = (id: string, size: 'small' | 'full' = 'small') => ({ ...entry(id, 'main'), size });
    const group = { kind: 'group' as const, id: 'group', width: 'half' as const, frameStyle: 'card' as const,
        dividers: 'hairline' as const, area: 'main' as const, children: [widget('child-a'), widget('child-b')] };
    const grouped = [widget('main-a'), group, widget('last')];
    const resolve = (destination: unknown, source = item, layout: readonly WidgetLayoutItemV1[] = grouped) => resolveWidgetAreaEntityDrop({
        item: source, surface, placements: layout, canEdit: true, area: 'main', destination, preview,
    });
    it('moves into a group and reorders children using that group native order', () => {
        expect(resolve({ groupId: 'group', anchorId: 'child-a', placement: 'after' })).toMatchObject({
            status: 'allowed', effect: { actionId: 'widgets.item.move', input: { to: { groupId: 'group', index: 1 } } },
        });
        expect(resolve({ groupId: 'group', anchorId: 'child-b', placement: 'after' }, { ...item, ref: { surface, instanceId: 'child-a' } })).toMatchObject({
            status: 'allowed', effect: { input: { to: { groupId: 'group', index: 1 } } },
        });
    });
    it('moves a child out to the surface without treating it as a missing widget', () => {
        expect(resolve({ groupId: null, anchorId: 'group', placement: 'after' }, { ...item, ref: { surface, instanceId: 'child-a' } })).toMatchObject({
            status: 'allowed', effect: { input: { to: { groupId: null, index: 2 } } },
        });
    });
    it('refuses width mismatch and leaves refusal owned by the group target', () => {
        expect(resolve({ groupId: 'group', anchorId: null, placement: 'after' }, item, [widget('main-a', 'full'), group])).toMatchObject({
            status: 'refused', reason: { code: 'widget_group_width_no_fit' },
        });
    });
    it('refuses a missing group, an anchor from another container, and an unchanged child order', () => {
        expect(resolve({ groupId: 'missing', anchorId: null, placement: 'after' })).toMatchObject({ status: 'refused', reason: { code: 'widget_group_not_found' } });
        expect(resolve({ groupId: 'group', anchorId: 'last', placement: 'after' })).toMatchObject({ status: 'refused', reason: { code: 'anchor-gone' } });
        expect(resolve({ groupId: 'group', anchorId: 'child-b', placement: 'before' }, { ...item, ref: { surface, instanceId: 'child-a' } })).toMatchObject({
            status: 'refused', reason: { code: 'widget_position_unchanged' },
        });
    });
});

it('projects a same-document main-to-aside drop to the destination area-native Action position', () => {
    expect(resolveWidgetAreaEntityDrop({ item, surface, placements, canEdit: true, area: 'aside',
        destination: { anchorId: 'aside-a', placement: 'after' }, preview })).toMatchObject({ status: 'allowed', effect: {
        actionId: 'widgets.item.move', input: { ref: item.ref, to: { surface, area: 'aside', index: 1 } },
    } });
});

it('does not turn a merged phone reorder into a new cross-area persisted order', () => {
    expect(resolveWidgetAreaEntityDrop({ item, surface, placements, canEdit: true, area: 'main',
        destination: { anchorId: 'main-b', placement: 'after' }, preview })).toMatchObject({ status: 'allowed', effect: {
        input: { to: { surface, area: 'main', index: 1 } },
    } });
    expect(resolveWidgetAreaEntityDrop({ item, surface, placements, canEdit: true, area: 'main',
        destination: { anchorId: 'aside-a', placement: 'after' }, preview })).toMatchObject({ status: 'refused', reason: { code: 'anchor-gone' } });
});

it('admits an aside widget into a filtered desktop main area and an empty aside', () => {
    const asideItem = { ...item, ref: { surface, instanceId: 'aside-a' } };
    expect(resolveWidgetAreaEntityDrop({ item: asideItem, surface, placements: placements.filter(entry => entry.area === 'main'),
        canEdit: true, area: 'main', destination: { anchorId: 'main-b', placement: 'after' }, preview })).toMatchObject({
        status: 'allowed', effect: { input: { to: { surface, area: 'main', index: 2 } } },
    });
    expect(resolveWidgetAreaEntityDrop({ item, surface, placements: placements.filter(entry => entry.area === 'main'),
        canEdit: true, area: 'aside', destination: { anchorId: null, placement: 'after' }, preview })).toMatchObject({
        status: 'allowed', effect: { input: { to: { surface, area: 'aside', index: 0 } } },
    });
});
