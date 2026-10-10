import { describe, expect, it, vi } from 'vitest';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { applyWidgetAreaLayoutIntentV1, createHomeWidgetActionPortV1, createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, getWidgetLayoutItemIdV1, WidgetInstanceActionInputSchemasV1, type WidgetLayoutItemV1, type WidgetLayoutGroupV1, type WidgetLayoutWidgetV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { applyHomeHubLayoutIntent, buildHomeHubLayoutResult, buildHomeHubArtifactIdV1, createHomeHubArtifactPortV1, HOME_HUB_ARTIFACT_KIND_V1, resolveHomeHubLayout } from '@happier-dev/protocol/home';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createWorkBoardArtifactBoundary } from '../../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { resolveWidgetAreaEntityDrop } from '@/components/widgets/area/widgetAreaEntityDrop';
import { resolveSessionSurfaceIndicatorEdge } from '@/components/sessions/board/sessionSurfaceIndicatorEdge';
import { createEntityDragDropRuntime } from '../entityDragDropRuntime';
import { resolveWidgetLayoutEntityDrop } from '../widgetLayoutEntityDrop';
import { resolveWidgetCardPointerDestination, resolveWidgetGroupPointerDestination, widgetGroupDropTarget, widgetGroupTakesEffect, widgetLayoutCardDropTarget, widgetLayoutSiblingIds } from '@/components/widgets/group/widgetGroupDropTarget';
import { t } from '@/text';
import { resolveHappierDropChooserSections } from '@happier-dev/plugin-ui/presentation';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock();
});

const scope = { serverId: 'home', accountId: 'account' };
const surface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'home' } };
const widget = (id: string, size: 'small' | 'full' = 'small'): WidgetLayoutWidgetV1 => ({ kind: 'widget',
    instance: { v: 1, id, definition: { kind: 'builtin', id: 'changes' }, bindings: {} }, size });
const group: WidgetLayoutGroupV1 = { kind: 'group', id: 'group', width: 'half', frameStyle: 'card', dividers: 'hairline', children: [widget('child')] };
const preview = { verb: 'Move', target: 'Group' };
const carry: EntityDragItemV1 = { kind: 'home-section', scope, sectionId: 'moving' };
const destination = { groupId: 'group', anchorId: null, placement: 'after' };

describe('shared layout DnD admission', () => {
    const adjacentCases = (['child', 'standalone', 'whole-group', 'last-child'] as const).flatMap(sourceKind =>
        (['before', 'after'] as const).flatMap(sourceSide =>
            (['widget', 'group'] as const).flatMap(anchorKind =>
                (['before', 'after'] as const).map(placement => {
                    // Explicit final orders, including untouched siblings; this is the user's
                    // placement contract, not a second implementation of the index calculation.
                    const movedId = sourceKind === 'whole-group' ? 'source' : 'moving';
                    const extracting = sourceKind === 'child' || sourceKind === 'last-child';
                    const remaining = extracting && sourceKind !== 'last-child' ? ['source'] : [];
                    const expected = sourceSide === 'before'
                        ? placement === 'before' ? ['daily', 'triage', ...remaining, 'spacer', movedId, 'anchor', 'tail']
                            : ['daily', 'triage', ...remaining, 'spacer', 'anchor', movedId, 'tail']
                        : placement === 'before' ? ['daily', 'triage', movedId, 'anchor', 'spacer', ...remaining, 'tail']
                            : ['daily', 'triage', 'anchor', movedId, 'spacer', ...remaining, 'tail'];
                    return { sourceKind, sourceSide, anchorKind, placement, movedId, expected };
                }))));
    describe.each(['home', 'project-main', 'project-aside', 'widget-area'] as const)('%s composed adjacent-placement matrix', context => {
        it.each(adjacentCases)('$sourceKind $sourceSide $anchorKind → $placement', async scenario => {
            const isHome = context === 'home';
            const area = context === 'project-main' ? 'main' as const : context === 'project-aside' ? 'aside' as const : undefined;
            const targetSurface: WidgetSurfaceRefV1 = { ...scope, owner: isHome ? { kind: 'home' }
                : area ? { kind: 'project', projectId: 'project', layoutId: 'ordering' }
                    : { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'main' } };
            const source: WidgetLayoutItemV1 = scenario.sourceKind === 'standalone' ? widget('moving')
                : { ...group, id: 'source', width: 'full' as const, children: scenario.sourceKind === 'last-child'
                    ? [widget('moving')] : [widget('moving'), widget('remaining')] };
            const anchor: WidgetLayoutItemV1 = scenario.anchorKind === 'widget' ? widget('anchor') : { ...group, id: 'anchor' };
            const middle = scenario.sourceSide === 'before' ? [source, widget('spacer'), anchor] : [anchor, widget('spacer'), source];
            const items: WidgetLayoutItemV1[] = [widget('daily'), widget('triage'), ...middle, widget('tail')]
                .map(item => area ? { ...item, area } : item);
            // A different Project column is part of the document but not the destination order.
            if (area) items.splice(1, 0, { ...widget('other-area'), area: area === 'main' ? 'aside' : 'main' });
            const preceding = ['start', 'attention', 'setup'];
            const unresolved = ['retained-a', 'retained-b', 'retained-c', 'retained-d', 'retained-e'];
            const nativeOrder = [...preceding, ...unresolved, ...items.map(getWidgetLayoutItemIdV1), 'usage'];
            const builtins = [{ id: 'start', hideable: false }, { id: 'attention', hideable: false },
                { id: 'setup', hideable: true }, { id: 'usage', hideable: true, afterWidgets: true }];
            const homeLayout = { v: 1 as const, order: nativeOrder, hidden: [], items };
            const nativeIds = isHome ? resolveHomeHubLayout(homeLayout, builtins, []).order
                : items.filter(item => !area || item.area === area).map(getWidgetLayoutItemIdV1);
            const admission = resolveWidgetLayoutEntityDrop({
                item: { kind: scenario.sourceKind === 'whole-group' ? 'widget-layout-group' : 'widget-area-instance', scope,
                    ref: { surface: targetSurface, instanceId: scenario.movedId } },
                surface: targetSurface, items, topLevelIds: nativeIds, area, canEdit: true,
                destination: { anchorId: 'anchor', placement: scenario.placement }, preview,
            });
            if (admission.status !== 'allowed') throw new Error(`Unexpected ${admission.status}`);
            expect(resolveSessionSurfaceIndicatorEdge({ effect: admission.effect, bounds: null, pointer: null,
                widgetAreaTarget: { surface: targetSurface, area, groupId: null, itemId: 'anchor', itemIds: nativeIds } }))
                .toBe(scenario.placement === 'before' ? 'top' : 'bottom');
            const boundary = createWorkBoardArtifactBoundary();
            const artifactId = isHome ? buildHomeHubArtifactIdV1(scope.accountId) : buildWidgetSurfaceArtifactIdV1(targetSurface);
            const areaLayout = { v: 1 as const, surface: targetSurface, items };
            boundary.rows.set(artifactId, { artifactId,
                header: isHome ? { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1, title: 'Home layout' } : buildWidgetSurfaceArtifactHeaderV1(areaLayout),
                body: JSON.stringify(isHome ? homeLayout : areaLayout), revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner' });
            const transport = boundary.forAccount(scope.accountId);
            const homeOwner = createHomeHubArtifactPortV1(transport, { accountId: scope.accountId, builtins });
            const areaOwner = !isHome ? createWidgetSurfaceArtifactPortV1(transport, { surface: targetSurface, isCurrent: () => true }) : null;
            const areaPort = areaOwner ? createWidgetAreaActionPortV1(() => areaOwner) : undefined;
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                widgetAccountScope: () => scope,
                ...(isHome ? { homeHubArtifacts: homeOwner } : { widgetSurfaceActions: { project: areaPort, pluginArea: areaPort } }),
            }));
            // Area moves are configurable danger Actions. Use the real Account
            // setting for direct UI moves; do not mock admission or bypass it.
            expect(admission.effect.actionId).toBe('widgets.item.move');
            const result = await executor.execute('widgets.item.move', admission.effect.input, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.item.move': ['ui'] } }),
            });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            const committed = isHome ? (await homeOwner.describe(await homeOwner.read())).sections.flatMap<WidgetLayoutItemV1>(section =>
                section.kind === 'builtin' ? [] : section.kind === 'group' ? [section.group] : [{ kind: 'widget', instance: section.instance }])
                : (await areaOwner!.read()).items;
            expect(committed.filter(item => !area || item.area === area).map(getWidgetLayoutItemIdV1)).toEqual(scenario.expected);
            if (isHome) expect((await homeOwner.read()).order).toEqual([...preceding, ...unresolved, ...scenario.expected, 'usage']);
            if (area) expect(committed.filter(item => item.area !== area)).toEqual([{ ...widget('other-area'), area: area === 'main' ? 'aside' : 'main' }]);
            const remainingGroup = committed.find(item => item.kind === 'group' && item.id === 'source');
            if (scenario.sourceKind === 'last-child') expect(remainingGroup).toBeUndefined();
            else if (scenario.sourceKind !== 'standalone') expect(remainingGroup).toMatchObject({
                children: scenario.sourceKind === 'child' ? [widget('remaining')] : [widget('moving'), widget('remaining')],
            });
        });
    });
    it('replays Resume 13 through resolution, Action, Home port and reducer with its retained slots', async () => {
        const items = [widget('daily'), widget('triage'), { ...group, id: '53ab', width: 'full' as const, children: [widget('c1ea'), widget('fb086')] },
            { ...group, id: '0389', children: [widget('session')] }];
        const preceding = ['start', 'attention', 'daily', 'setup', 'triage', 'automations', 'machines', 'usage'];
        const unresolved = ['55249652', '95e264e9', '9bc23fb9', 'b3785069', 'b5c03de6'];
        const layout = { v: 1 as const, order: [...preceding, ...unresolved, '53ab', '0389'], hidden: ['machines'], items };
        const resolved = resolveHomeHubLayout(layout, [
            { id: 'start', hideable: false }, { id: 'attention', hideable: false }, { id: 'setup', hideable: true },
            { id: 'automations', hideable: true, afterWidgets: true }, { id: 'machines', hideable: true, afterWidgets: true },
            { id: 'usage', hideable: true, afterWidgets: true },
        ], []);
        const admission = resolveWidgetLayoutEntityDrop({ item: { kind: 'home-section', scope, sectionId: 'c1ea' }, surface,
            items, topLevelIds: resolved.order, canEdit: true,
            destination: { anchorId: '0389', placement: 'before' }, preview });
        if (admission.status !== 'allowed') throw new Error(`Unexpected ${admission.status}`);
        const boundary = createWorkBoardArtifactBoundary();
        const artifactId = buildHomeHubArtifactIdV1(scope.accountId);
        boundary.rows.set(artifactId, { artifactId, header: { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1, title: 'Home layout' },
            body: JSON.stringify(layout), revision: { headerVersion: 1, bodyVersion: 1 } });
        const owner = createHomeHubArtifactPortV1(boundary.forAccount(scope.accountId), { accountId: scope.accountId });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ homeHubArtifacts: owner, widgetAccountScope: () => scope }));
        expect(admission.effect.actionId).toBe('widgets.item.move');
        expect(await executor.execute('widgets.item.move', admission.effect.input, { surface: 'ui' })).toMatchObject({ ok: true });
        expect((await owner.read()).order).toEqual([...preceding, ...unresolved, '53ab', 'c1ea', '0389']);
    });
    it.each(['home', 'project'] as const)('keeps the %s below-anchor line when extracting the last child removes a preceding group', ownerKind => {
        const targetSurface: WidgetSurfaceRefV1 = { ...scope, owner: ownerKind === 'home' ? { kind: 'home' } : { kind: 'project', projectId: 'project' } };
        const source = { ...group, id: 'source', children: [widget('moving')] };
        const items = [widget('daily'), source, group, widget('triage')];
        const topLevelIds = ownerKind === 'home' ? ['start', 'attention', ...items.map(getWidgetLayoutItemIdV1), 'usage'] : undefined;
        const input = { surface: targetSurface, items, topLevelIds, group, name: 'Group', ...(ownerKind === 'project' ? { area: 'main' as const } : {}) };
        const target = widgetGroupDropTarget(input);
        const admission = target.resolve({ item: { kind: 'widget-area-instance', scope, ref: { surface: targetSurface, instanceId: 'moving' } },
            pointer: null, destination: { anchorId: group.id, placement: 'after' }, input: 'keyboard' });
        if (admission.status !== 'allowed') throw new Error('Expected admitted extraction');
        expect(resolveSessionSurfaceIndicatorEdge({ effect: admission.effect, bounds: null, pointer: null, widgetAreaTarget: {
            surface: targetSurface, area: input.area, groupId: null, itemId: group.id,
            itemIds: widgetLayoutSiblingIds(items, undefined, topLevelIds),
        } })).toBe('bottom');
        const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].parse(admission.effect.input);
        if (!('to' in move)) throw new Error('Expected native destination');
        const expected = ['daily', group.id, 'moving', 'triage'];
        if (ownerKind === 'home') {
            const builtins = [{ id: 'start', hideable: false }, { id: 'attention', hideable: false }, { id: 'usage', hideable: true, afterWidgets: true }];
            const layout = applyHomeHubLayoutIntent({ v: 1, order: [...topLevelIds!], hidden: [], items }, builtins, [],
                { kind: 'move_to', sectionId: 'moving', position: { nativeIndex: move.to.index } });
            expect(buildHomeHubLayoutResult(layout, builtins, []).sections.map(section => section.id)).toEqual(['start', 'attention', ...expected, 'usage']);
        } else {
            expect(applyWidgetAreaLayoutIntentV1({ v: 1, surface: targetSurface, items }, { kind: 'move', instanceId: 'moving',
                area: 'main', groupId: null, toIndex: move.to.index }).items.map(getWidgetLayoutItemIdV1)).toEqual(expected);
        }
    });
    it('applies an explicit native Home group position in the same space as a widget position', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const owner = createHomeHubArtifactPortV1(boundary.forAccount(scope.accountId), { accountId: scope.accountId });
        await owner.apply({ kind: 'group_add', group });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ homeHubArtifacts: owner, widgetAccountScope: () => scope }));
        expect(await executor.execute('widgets.item.move', { ref: { surface, instanceId: group.id },
            to: { surface, index: 0, groupId: null } }, { surface: 'ui' })).toMatchObject({ ok: true });
        expect((await owner.read()).order[0]).toBe(group.id);
    });
    const orderCases: readonly { name: string; ids: string[]; sourceId: string; anchorId: string; placement: 'before' | 'after';
        expected: string[]; anchorKind?: 'widget' | 'group'; groupId?: string }[] = [
        { name: 'Resume 13 child above next group after Daily and triage', ids: ['daily', 'triage', 'source', 'anchor'], sourceId: 'child', anchorId: 'anchor', placement: 'before', expected: ['daily', 'triage', 'source', 'child', 'anchor'], anchorKind: 'group' },
        { name: 'out above own group', ids: ['daily', 'triage', 'source', 'anchor'], sourceId: 'child', anchorId: 'source', placement: 'before', expected: ['daily', 'triage', 'child', 'source', 'anchor'] },
        { name: 'out below own group', ids: ['daily', 'triage', 'source', 'anchor'], sourceId: 'child', anchorId: 'source', placement: 'after', expected: ['daily', 'triage', 'source', 'child', 'anchor'] },
        ...(['source', 'anchor'] as const).flatMap(first => (['widget', 'group'] as const).flatMap(anchorKind => (['before', 'after'] as const).map(placement => ({
            name: `out ${placement} ${anchorKind}, ${first} first`, anchorKind,
            ids: ['daily', first, first === 'source' ? 'anchor' : 'source', 'triage'],
            sourceId: 'child', anchorId: 'anchor', placement,
            expected: first === 'source'
                ? placement === 'before' ? ['daily', 'source', 'child', 'anchor', 'triage'] : ['daily', 'source', 'anchor', 'child', 'triage']
                : placement === 'before' ? ['daily', 'child', 'anchor', 'source', 'triage'] : ['daily', 'anchor', 'child', 'source', 'triage'],
        })))),
        ...(['source', 'anchor'] as const).flatMap(first => (['before', 'after'] as const).map(placement => ({
            name: `whole group ${placement}, ${first} first`, anchorKind: 'group' as const,
            ids: ['daily', first, 'triage', first === 'source' ? 'anchor' : 'source'], sourceId: 'source', anchorId: 'anchor', placement,
            expected: first === 'source'
                ? placement === 'before' ? ['daily', 'triage', 'source', 'anchor'] : ['daily', 'triage', 'anchor', 'source']
                : placement === 'before' ? ['daily', 'source', 'anchor', 'triage'] : ['daily', 'anchor', 'source', 'triage'],
        }))),
        ...(['source', 'anchor'] as const).map(first => ({ name: `into group, ${first} first`, anchorKind: 'group' as const,
            ids: ['daily', first, first === 'source' ? 'anchor' : 'source', 'triage'], sourceId: 'child', anchorId: 'anchor-child',
            placement: 'before' as const, groupId: 'anchor', expected: ['daily', first, first === 'source' ? 'anchor' : 'source', 'triage'],
        })),
    ];

    describe.each(['home', 'project'] as const)('%s drop resolution through the native movement owner', ownerKind => {
        it.each(orderCases)('$name preserves the promised order, membership and feedback', async scenario => {
            const targetSurface: WidgetSurfaceRefV1 = { ...scope, owner: ownerKind === 'home' ? { kind: 'home' } : { kind: 'project', projectId: 'project' } };
            const sourceGroup: WidgetLayoutGroupV1 = { ...group, id: 'source', children: [widget('child'), widget('remaining')] };
            const anchor: WidgetLayoutItemV1 = scenario.anchorKind === 'widget' ? widget('anchor')
                : { ...group, id: 'anchor', children: [widget('anchor-child')] };
            const items = scenario.ids.map(id => id === 'source' ? sourceGroup : id === 'anchor' ? anchor : widget(id));
            const nativeIds = ownerKind === 'home' ? ['start', 'attention', ...scenario.ids, 'usage'] : scenario.ids;
            const item: EntityDragItemV1 = { kind: scenario.sourceId === 'source' ? 'widget-layout-group' : 'widget-area-instance', scope,
                ref: { surface: targetSurface, instanceId: scenario.sourceId } };
            const destination = { anchorId: scenario.anchorId, placement: scenario.placement, groupId: scenario.groupId ?? null };
            const targetInput = { surface: targetSurface, items, topLevelIds: nativeIds, canEdit: true, sourceItem: widget('child') };
            const target = scenario.groupId || scenario.anchorId === 'anchor' && anchor.kind === 'widget'
                ? widgetLayoutCardDropTarget({ ...targetInput, itemId: scenario.anchorId, title: 'Anchor', groupLabel: 'Group', groupId: scenario.groupId })
                : widgetGroupDropTarget({ ...targetInput, group: scenario.anchorId === 'source' ? sourceGroup : anchor as WidgetLayoutGroupV1, name: 'Anchor' });
            const admission = ownerKind === 'home' ? target.resolve({ item, pointer: null, destination, input: 'chooser' })
                : resolveWidgetAreaEntityDrop({ ...targetInput, item, placements: items, area: 'main', destination, preview });
            if (admission.status !== 'allowed') throw new Error(`Unexpected ${admission.status} admission`);
            const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].parse(admission.effect.input);
            if (!('to' in move)) throw new Error('Expected native destination');
            expect(admission.effect.preview.glyph).toBe(scenario.placement === 'before' ? 'above' : 'below');
            expect(resolveSessionSurfaceIndicatorEdge({ effect: admission.effect, bounds: null, pointer: null, widgetAreaTarget: {
                surface: targetSurface, groupId: scenario.groupId ?? null, itemId: scenario.anchorId,
                itemIds: scenario.groupId ? ['anchor-child'] : nativeIds,
            } })).toBe(scenario.placement === 'before' ? 'top' : 'bottom');
            let committed: readonly WidgetLayoutItemV1[];
            if (ownerKind === 'home') {
                const boundary = createWorkBoardArtifactBoundary();
                const artifactId = buildHomeHubArtifactIdV1(scope.accountId);
                boundary.rows.set(artifactId, { artifactId, header: { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1, title: 'Home layout' },
                    body: JSON.stringify({ v: 1, order: nativeIds, hidden: [], items }), revision: { headerVersion: 1, bodyVersion: 1 } });
                const owner = createHomeHubArtifactPortV1(boundary.forAccount(scope.accountId), { accountId: scope.accountId,
                    builtins: [{ id: 'start', hideable: false }, { id: 'attention', hideable: false }, { id: 'usage', hideable: true, afterWidgets: true }] });
                const port = createHomeWidgetActionPortV1(owner);
                const executor = createActionExecutor(createActionExecutorBoundaryFixture({ homeHubArtifacts: owner, widgetAccountScope: () => scope }));
                expect(await executor.execute('widgets.item.move', move, { surface: 'ui' })).toMatchObject({ ok: true });
                const result = await owner.describe(await owner.read());
                expect(result.sections.map(section => section.id)).toEqual(['start', 'attention', ...scenario.expected, 'usage']);
                const read = await port.read(targetSurface, { surface: 'ui' });
                if ('ok' in read || !read.items) throw new Error('Expected acknowledged Home inventory');
                committed = read.items;
            } else {
                committed = applyWidgetAreaLayoutIntentV1({ v: 1, surface: targetSurface, items }, { kind: 'move', instanceId: scenario.sourceId,
                    toIndex: move.to.index, groupId: move.to.groupId, area: 'main' }).items;
            }
            expect(committed.map(getWidgetLayoutItemIdV1)).toEqual(scenario.expected);
            expect(committed.find(entry => entry.kind === 'group' && entry.id === 'source')).toMatchObject({
                children: scenario.sourceId === 'source' ? sourceGroup.children : [widget('remaining')],
            });
            if (scenario.groupId) expect(committed.find(entry => entry.kind === 'group' && entry.id === 'anchor')).toMatchObject({ children: [widget('child'), widget('anchor-child')] });
        });
    });
    it.each(['widget', 'group'] as const)('keeps a carried %s preview aligned with the group edge write and body admission', kind => {
        const source: WidgetLayoutItemV1 = kind === 'group' ? { ...group, id: 'moving', children: [widget('moving-child')] } : widget('moving');
        const item: EntityDragItemV1 = kind === 'group'
            ? { kind: 'widget-layout-group', scope, ref: { surface, instanceId: 'moving' } } : carry;
        const target = widgetGroupDropTarget({ surface, items: [widget('before'), group, widget('between'), source, widget('after')], group, name: 'Group' });
        const bounds = { x: 20, y: 20, width: 100, height: 100 };
        for (const [y, placement, index] of [[25, 'before', 1], [115, 'after', 2]] as const) {
            const pointer = { x: 50, y };
            const resolved = resolveWidgetGroupPointerDestination(group.id, bounds, pointer);
            const admission = target.resolve({ item, pointer, destination: resolved, input: 'pointer' });
            expect(admission).toMatchObject({ status: 'allowed', effect: {
                input: { to: { groupId: null, index } },
                preview: { glyph: placement === 'before' ? 'above' : 'below',
                    verb: t(placement === 'before' ? 'entityDragDrop.preview.moveAbove' : 'entityDragDrop.preview.moveBelow', { target: 'Group' }), target: 'Group' },
            } });
            const chosen = target.listDestinations!(item).find(option => JSON.stringify(option.destination) === JSON.stringify(resolved))!;
            expect(target.resolve({ item, pointer: null, destination: chosen.destination, input: 'chooser' })).toEqual(admission);
        }
        const pointer = { x: 50, y: 70 };
        const body = target.resolve({ item, pointer, destination: resolveWidgetGroupPointerDestination(group.id, bounds, pointer), input: 'pointer' });
        if (kind === 'group') {
            expect(body).toMatchObject({ status: 'refused', reason: { code: 'widget_group_nesting_forbidden' } });
        } else {
            expect(body).toMatchObject({ status: 'allowed', effect: {
                input: { to: { groupId: group.id, index: 1 } },
                preview: { glyph: 'move', verb: t('widgetFrame.moveIntoGroupNamed', { group: 'Group' }), target: 'Group' },
            } });
            expect(target.resolve({ item, pointer: null, destination: null, input: 'keyboard' })).toEqual(body);
        }
    });
    it('describes above and below a grouped child while preserving the containing group in the write', () => {
        const target = widgetLayoutCardDropTarget({ surface, items: [group, widget('moving')], itemId: 'child', title: 'Child', groupId: group.id, groupLabel: 'Group' });
        const bounds = { x: 20, y: 20, width: 100, height: 100 };
        for (const [y, index, glyph, key] of [[25, 0, 'above', 'widgetFrame.intoGroupAbove'], [115, 1, 'below', 'widgetFrame.intoGroupBelow']] as const) {
            const pointer = { x: 50, y };
            expect(target.resolve({ item: carry, pointer, destination: resolveWidgetCardPointerDestination('child', group.id, bounds, pointer), input: 'pointer' }))
                .toMatchObject({ status: 'allowed', effect: { input: { to: { groupId: group.id, index } },
                    preview: { glyph, verb: t('widgetFrame.moveIntoGroupNamed', { group: t('widgetFrame.groupUntitled') }), consequence: t(key, { target: 'Child' }), target: 'Child' } } });
        }
    });
    it('retains the resolved edge preview when the group target refuses an unchanged position', () => {
        const target = widgetGroupDropTarget({ surface, items: [group, widget('moving')], group, name: 'Group' });
        expect(target.resolve({ item: carry, pointer: null, destination: { anchorId: group.id, placement: 'after' }, input: 'keyboard' }))
            .toMatchObject({ status: 'refused', reason: { code: 'widget_position_unchanged' },
                preview: { glyph: 'below', verb: t('entityDragDrop.preview.moveBelow', { target: 'Group' }), target: 'Group' } });
    });
    it('says what the release does to group membership: into, out, inside, a whole group, and why a group refuses (lab wgdnd)', () => {
        const named = { ...group, title: 'happier', children: [widget('child'), widget('second')] };
        const items = [named, widget('moving'), widget('wide', 'full')];
        const resolve = (item: EntityDragItemV1, to: unknown) => resolveWidgetLayoutEntityDrop({ item, surface, items, canEdit: true,
            preview: { verb: 'Organize', target: 'Child' }, destination: to });
        // Into: the preview names the group and the place, and says it shows plain there.
        expect(resolve(carry, { groupId: 'group', anchorId: 'child', placement: 'after' })).toMatchObject({ status: 'allowed', effect: { preview: {
            verb: t('widgetFrame.moveIntoGroupNamed', { group: 'happier' }), consequence: t('widgetFrame.intoGroupBelow', { target: 'Child' }) } } });
        expect(resolve(carry, { groupId: 'group', anchorId: null, placement: 'after' })).toMatchObject({ status: 'allowed', effect: { preview: {
            verb: t('widgetFrame.moveIntoGroupNamed', { group: 'happier' }), consequence: t('widgetFrame.intoGroupEnd') } } });
        // Inside: order only; the container does not change, so the verb stays the edge.
        const child: EntityDragItemV1 = { kind: 'home-section', scope, sectionId: 'child' };
        expect(resolve(child, { groupId: 'group', anchorId: 'second', placement: 'after' })).toMatchObject({ status: 'allowed', effect: { preview: {
            verb: t('entityDragDrop.preview.moveBelow', { target: 'Child' }), consequence: t('widgetFrame.reorderInGroupDetail') } } });
        // Out: it gets its own card again.
        expect(resolve(child, { groupId: null, anchorId: 'moving', placement: 'after' })).toMatchObject({ status: 'allowed', effect: { preview: {
            consequence: t('widgetFrame.outOfGroupDetail', { group: 'happier' }) } } });
        // A whole group: its widgets travel with it.
        const whole: EntityDragItemV1 = { kind: 'widget-layout-group', scope, ref: { surface, instanceId: 'group' } };
        expect(resolve(whole, { groupId: null, anchorId: 'moving', placement: 'after' })).toMatchObject({ status: 'allowed', effect: { preview: {
            consequence: t('widgetFrame.wholeGroupDetail', { count: 2 }) } } });
        // Refused by the group: the title names the group it cannot enter.
        const wide: EntityDragItemV1 = { kind: 'home-section', scope, sectionId: 'wide' };
        expect(resolve(wide, { groupId: 'group', anchorId: null, placement: 'after' })).toMatchObject({ status: 'refused',
            reason: { code: 'widget_group_width_no_fit' }, preview: { verb: t('widgetFrame.cantPutInGroup', { group: 'happier' }) } });
    });
    it('outlines a group only for a carry that would enter it, wherever inside it the pointer is (lab wgdnd 1 vs 3)', () => {
        const other: WidgetLayoutGroupV1 = { ...group, id: 'other', children: [widget('other-child')] };
        const items = [group, other, widget('moving')];
        const effectOf = (sectionId: string, to: unknown) => {
            const admission = resolveWidgetLayoutEntityDrop({ item: { kind: 'home-section', scope, sectionId }, surface, items, canEdit: true, preview, destination: to });
            if (admission.status !== 'allowed') throw new Error(admission.reason.code);
            return admission.effect;
        };
        // From outside, over one of its children: the child draws the line, the group takes the outline.
        const entering = effectOf('moving', { groupId: 'group', anchorId: 'child', placement: 'before' });
        expect(widgetGroupTakesEffect(group, surface, entering)).toBe(true);
        expect(widgetGroupTakesEffect(other, surface, entering)).toBe(false);
        // Reordering inside changes no container: the line only.
        const two: WidgetLayoutGroupV1 = { ...group, children: [widget('child'), widget('second')] };
        const inside = resolveWidgetLayoutEntityDrop({ item: { kind: 'home-section', scope, sectionId: 'child' }, surface, items: [two], canEdit: true, preview,
            destination: { groupId: 'group', anchorId: 'second', placement: 'after' } });
        expect(inside.status === 'allowed' && widgetGroupTakesEffect(two, surface, inside.effect)).toBe(false);
        // Beside the group is not into it; nor is the same group id on another surface.
        expect(widgetGroupTakesEffect(group, surface, effectOf('moving', { groupId: null, anchorId: 'group', placement: 'before' }))).toBe(false);
        expect(widgetGroupTakesEffect(group, { ...scope, owner: { kind: 'project', projectId: 'p' } }, entering)).toBe(false);
    });
    it('keeps a group that cannot take the widget in the chooser, with its reason (lab wgdnd Bp)', () => {
        const target = widgetGroupDropTarget({ surface, items: [group, widget('between'), widget('wide', 'full')], group, name: 'website' });
        const item: EntityDragItemV1 = { kind: 'home-section', scope, sectionId: 'wide' };
        const options = target.listDestinations!(item).map((entry, index) => {
            const admission = target.resolve({ item, pointer: null, destination: entry.destination, input: 'chooser' });
            return { id: String(index), label: entry.label, group: entry.group, refusedReason: admission.status === 'refused' ? admission.reason.message : null };
        });
        const sections = resolveHappierDropChooserSections({ options, unavailableTitle: 'Unavailable' });
        const unavailable = sections.find(section => section.title === 'Unavailable')!;
        expect(unavailable.options).toEqual([expect.objectContaining({ label: 'website', disabled: true, detail: t('widgetFrame.groupRefusedWidth') })]);
        // Beside the group stays available.
        expect(sections.filter(section => section !== unavailable).flatMap(section => section.options)).toHaveLength(2);
    });
    it('names an untitled group the way its host does', () => {
        expect(resolveWidgetLayoutEntityDrop({ item: carry, surface, items: [group, widget('moving')], canEdit: true, preview, destination,
            describeGroup: () => 'Checks and Open PRs' })).toMatchObject({ status: 'allowed', effect: { preview: {
            verb: t('widgetFrame.moveIntoGroupNamed', { group: 'Checks and Open PRs' }) } } });
    });
    it('replaces a dissolving last-child group at its own slot instead of skipping its next neighbor', () => {
        const item: EntityDragItemV1 = { kind: 'home-section', scope, sectionId: 'child' };
        expect(resolveWidgetLayoutEntityDrop({ item, surface, items: [widget('before'), group, widget('after')], canEdit: true, preview,
            destination: { groupId: null, anchorId: 'group', placement: 'after' } })).toMatchObject({ status: 'allowed', effect: {
                input: { to: { groupId: null, index: 1 } },
            } });
    });
    it('refuses nesting but admits moving a whole group through the surface order', () => {
        const other = { ...group, id: 'other', children: [widget('other-child')] };
        const item: EntityDragItemV1 = { kind: 'widget-layout-group', scope, ref: { surface, instanceId: group.id } };
        expect(resolveWidgetLayoutEntityDrop({ item, surface, items: [group, other], canEdit: true, preview,
            destination: { ...destination, groupId: 'other' } })).toMatchObject({ status: 'refused', reason: { code: 'widget_group_nesting_forbidden' } });
        expect(resolveWidgetLayoutEntityDrop({ item, surface, items: [group, other], canEdit: true, preview,
            destination: { groupId: null, anchorId: 'other', placement: 'after' } })).toMatchObject({ status: 'allowed', effect: {
                input: { ref: item.ref, to: { surface, groupId: null, index: 1 } },
            } });
    });
    it('requires actual source size before admitting a transfer into a group', () => {
        const sourceSurface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'pinned' } };
        const item: EntityDragItemV1 = { kind: 'widget-area-instance', scope, ref: { surface: sourceSurface, instanceId: 'moving' } };
        const input = { item, surface, items: [group], canEdit: true, preview, destination };
        expect(resolveWidgetLayoutEntityDrop(input)).toMatchObject({ status: 'refused', reason: { code: 'widget_admission_pending' } });
        expect(resolveWidgetLayoutEntityDrop({ ...input, sourceItem: widget('moving', 'full') })).toMatchObject({ status: 'refused', reason: { code: 'widget_group_width_no_fit' } });
        expect(resolveWidgetLayoutEntityDrop({ ...input, sourceItem: widget('moving') })).toMatchObject({ status: 'allowed', effect: { input: { to: { groupId: 'group', index: 1 } } } });
        expect(resolveWidgetLayoutEntityDrop({ ...input, item: { kind: 'widget-layout-group', scope, ref: item.ref }, sourceItem: { ...group, id: 'moving' },
            destination: { groupId: null, anchorId: 'group', placement: 'after' } })).toMatchObject({ status: 'refused', reason: { code: 'unsupported_widget_transfer' } });
    });
    it('keeps a refused group target selected over its permissive surface and rechecks width at release', async () => {
        const runtime = createEntityDragDropRuntime();
        let items: WidgetLayoutItemV1[] = [widget('moving'), group];
        const written: unknown[] = [];
        runtime.registerSource({ id: 'source', scope, getItem: () => carry, isCurrent: () => true });
        runtime.registerTarget({ id: 'surface', scope, acceptedKinds: ['home-section'], getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
            resolve: () => resolveWidgetLayoutEntityDrop({ item: carry, surface, items, canEdit: true, preview,
                destination: { anchorId: 'group', placement: 'after' } }),
            execute: async effect => { written.push(effect.input); return { status: 'applied' }; },
        });
        runtime.registerTarget({ id: 'group', parentId: 'surface', scope, acceptedKinds: ['home-section'], getBounds: () => ({ x: 20, y: 20, width: 100, height: 100 }),
            resolve: ({ item }) => resolveWidgetLayoutEntityDrop({ item, surface, items, canEdit: true, preview, destination }),
            execute: async effect => { written.push(effect.input); return { status: 'applied' }; },
        });
        const active = runtime.begin('source')!;
        active.move({ x: 50, y: 50 });
        expect(runtime.getSnapshot()).toMatchObject({ targetId: 'group', admission: { status: 'allowed' } });
        items = [widget('moving', 'full'), group];
        expect(await active.release()).toMatchObject({ status: 'refused', reason: { code: 'widget_group_width_no_fit' } });
        expect(runtime.getSnapshot()).toMatchObject({ targetId: 'group', outcome: { status: 'refused' } });
        expect(written).toEqual([]);
    });
});
