import type { HomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { HomeHubMutationErrorV1, type HomeHubLayoutIntent } from '../home/homeHubLayoutV1.js';
import type { WidgetActionSurfacePortV1, WidgetMoveCaptureV1 } from './actionsV1.js';
import { WidgetGridSizeV1Schema, normalizeWidgetSizeForSurfaceV1 } from './widgetPresentationV1.js';
import { findWidgetLayoutItemV1, type WidgetLayoutItemV1 } from './widgetLayoutItemV1.js';

export function createHomeWidgetActionPortV1(port: HomeHubArtifactPortV1): WidgetActionSurfacePortV1 {
  const capture = async (result: Awaited<ReturnType<HomeHubArtifactPortV1['describe']>>, instanceId: string, signal?: AbortSignal): Promise<WidgetMoveCaptureV1 | null> => {
    const section = result.sections.flatMap(section => section.kind === 'group' ? section.children : [section]).find(section => section.kind === 'widget' && section.id === instanceId);
    if (section?.kind !== 'widget') return null;
    return { expectedInstance: section.instance, expectedPresentation: await port.captureWidgetPresentation(result.layout, instanceId, signal) };
  };
  return {
    async captureMove(_surface, instanceId, _context, signal) {
      return await capture(await port.describe(await port.read(signal), signal), instanceId, signal)
        ?? { ok: false, errorCode: 'widget_instance_not_found', error: 'widget_instance_not_found' };
    },
    async read(surface, _context, signal) {
      const description = await port.describe(await port.read(signal), signal);
      const items = description.sections.flatMap<WidgetLayoutItemV1>(section => section.kind === 'builtin' ? []
        : section.kind === 'group' ? [section.group] : [{ kind: 'widget' as const, instance: section.instance, size: section.size, ...(section.frameStyle ? { frameStyle: section.frameStyle } : {}) }]);
      return { surface, canEdit: true, items, instances: description.sections.flatMap(section => section.kind === 'group' ? section.children : [section]).flatMap(section => section.kind === 'widget'
        ? [{ instance: section.instance, size: section.size, ...(section.frameStyle ? { frameStyle: section.frameStyle } : {}) }]
        : []) };
    },
    async apply(surface, intent, _context, signal) {
      try {
        const instanceId = intent.kind === 'add' ? intent.instance.id : intent.kind === 'group_create' ? intent.groupId : intent.kind === 'group_add' ? intent.group.id : intent.instanceId;
        let domain: HomeHubLayoutIntent;
        switch (intent.kind) {
          case 'add': {
            if (intent.placement || intent.position?.tabId) return { ok: false, errorCode: 'widget_placement_unsupported', error: 'widget_placement_unsupported' };
            const groupId = intent.position?.groupId ?? intent.groupId;
            if (groupId) {
              const size = intent.presentation ? normalizeWidgetSizeForSurfaceV1('home', intent.presentation.size) : undefined;
              const index = intent.position?.index ?? intent.toIndex;
              domain = { kind: 'widget_add', instance: intent.instance, groupId, ...(index === undefined ? {} : { position: { nativeIndex: index } }),
                ...(size ? { size } : {}), ...(intent.presentation?.frameStyle ? { frameStyle: intent.presentation.frameStyle } : {}) }; break;
            }
            const index = intent.toIndex;
            const state = index === undefined ? null : await port.describe(await port.read(signal), signal);
            const widgets = state?.sections.filter(section => section.kind !== 'builtin') ?? [];
            const anchor = index === undefined ? undefined : widgets[index];
            const size = intent.presentation ? normalizeWidgetSizeForSurfaceV1('home', intent.presentation.size) : undefined;
            domain = { kind: 'widget_add', instance: intent.instance,
              ...(size ? { size } : {}),
              ...(intent.presentation?.frameStyle ? { frameStyle: intent.presentation.frameStyle } : {}),
              ...(intent.position ? { position: { nativeIndex: intent.position.index } }
                : state ? { position: { anchorId: anchor?.id ?? widgets.at(-1)?.id ?? null, placement: anchor ? 'before' as const : 'after' as const } } : {}) };
            break;
          }
          case 'remove': {
            const current = findWidgetLayoutItemV1((await port.read(signal)).items, instanceId);
            if (current?.kind === 'group') { domain = { kind: 'remove', instanceId }; break; }
            const expected = intent.expectedPresentation;
            const size = WidgetGridSizeV1Schema.safeParse(expected?.size);
            if (expected?.tabId || expected?.size && !size.success) return { ok: false, errorCode: 'widget_placement_unsupported', error: 'widget_placement_unsupported' };
            domain = { kind: 'widget_remove', instanceId, ...(intent.expectedInstance ? { expectedInstance: intent.expectedInstance } : {}),
              ...(expected ? { expectedPresentation: { nativeIndex: expected.nativeIndex, frameStyle: expected.frameStyle, ...(expected.groupId === undefined ? {} : { groupId: expected.groupId }), ...(expected.hidden === undefined ? {} : { hidden: expected.hidden }), ...(size.success ? { size: size.data } : {}) } } : {}) };
            break;
          }
          case 'rename': domain = { kind: 'rename', instanceId, displayName: intent.displayName }; break;
          case 'size': {
            const size = WidgetGridSizeV1Schema.safeParse(intent.size);
            if (!size.success) return { ok: false, errorCode: 'widget_size_unsupported', error: 'widget_size_unsupported' };
            domain = { kind: 'size', instanceId, size: size.data }; break;
          }
          case 'frame': domain = { kind: 'frameStyle', sectionId: instanceId, frameStyle: intent.frameStyle }; break;
          case 'inputs': domain = { kind: 'widget_inputs', instanceId, bindings: intent.bindings, ...(intent.paths ? { paths: [...intent.paths] } : {}) }; break;
          case 'inputs_reset': domain = { kind: 'widget_inputs_reset', instanceId, ...(intent.paths ? { paths: [...intent.paths] } : {}) }; break;
          case 'move': {
            if ('nativeIndex' in intent && intent.tabId) return { ok: false, errorCode: 'widget_placement_unsupported', error: 'widget_placement_unsupported' };
            const layout = await port.read(signal);
            const grouped = layout.items.some(item => item.kind === 'group' && item.children.some(child => child.instance.id === instanceId));
            if ('nativeIndex' in intent) {
              domain = intent.groupId === null || (intent.groupId === undefined && !grouped)
                ? { kind: 'move_to', sectionId: instanceId, position: { nativeIndex: intent.nativeIndex } }
                : { kind: 'move', instanceId, toIndex: intent.nativeIndex,
                  ...(intent.groupId === undefined ? {} : { groupId: intent.groupId }) };
              break;
            }
            if (intent.groupId !== undefined || grouped) {
              domain = { kind: 'move', instanceId, toIndex: intent.toIndex,
                ...(intent.groupId === undefined ? {} : { groupId: intent.groupId }) }; break;
            }
            const state = await port.describe(await port.read(signal), signal);
            const widgets = state.sections.filter(section => section.kind !== 'builtin' && section.id !== instanceId);
            const anchor = widgets[intent.toIndex];
            domain = { kind: 'move_to', sectionId: instanceId, position: { anchorId: anchor?.id ?? widgets.at(-1)?.id ?? null, placement: anchor ? 'before' : 'after' } };
            break;
          }
          case 'width': domain = { kind: 'width', instanceId, width: intent.width }; break;
          case 'group_create': case 'group_ungroup': case 'group_set': case 'group_inputs': case 'group_add': domain = intent; break;
        }
        const committed = await port.apply(domain, signal);
        const item = findWidgetLayoutItemV1(committed.layout.items, instanceId);
        return { ok: true, result: { ref: { surface, instanceId }, instance: item?.kind === 'widget' ? item.instance : null, item: item ?? null,
          ...(intent.kind === 'add' && intent.captureForMove ? { moveCapture: await capture(committed, instanceId, signal) } : {}) } };
      } catch (error) {
        if (error instanceof HomeHubMutationErrorV1) return { ok: false, errorCode: error.code, error: error.code };
        throw error;
      }
    },
  };
}
