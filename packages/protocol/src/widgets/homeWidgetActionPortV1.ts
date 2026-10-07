import type { HomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { HomeHubMutationErrorV1, type HomeHubLayoutIntent } from '../home/homeHubLayoutV1.js';
import type { WidgetActionSurfacePortV1, WidgetMoveCaptureV1 } from './actionsV1.js';
import { WidgetGridSizeV1Schema, normalizeWidgetSizeForSurfaceV1 } from './widgetPresentationV1.js';

export function createHomeWidgetActionPortV1(port: HomeHubArtifactPortV1): WidgetActionSurfacePortV1 {
  const capture = async (result: Awaited<ReturnType<HomeHubArtifactPortV1['describe']>>, instanceId: string, signal?: AbortSignal): Promise<WidgetMoveCaptureV1 | null> => {
    const section = result.sections.find(section => section.kind === 'widget' && section.id === instanceId);
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
      return { surface, canEdit: true, instances: description.sections.flatMap(section => section.kind === 'widget'
        ? [{ instance: section.instance, size: section.size, ...(section.frameStyle ? { frameStyle: section.frameStyle } : {}) }]
        : []) };
    },
    async apply(surface, intent, _context, signal) {
      try {
        const instanceId = intent.kind === 'add' ? intent.instance.id : intent.instanceId;
        let domain: HomeHubLayoutIntent;
        switch (intent.kind) {
          case 'add': {
            if (intent.placement || intent.position?.tabId) return { ok: false, errorCode: 'widget_placement_unsupported', error: 'widget_placement_unsupported' };
            const index = intent.toIndex;
            const state = index === undefined ? null : await port.describe(await port.read(signal), signal);
            const widgets = state?.sections.filter(section => section.kind === 'widget') ?? [];
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
            const expected = intent.expectedPresentation;
            const size = WidgetGridSizeV1Schema.safeParse(expected?.size);
            if (expected?.tabId || expected?.size && !size.success) return { ok: false, errorCode: 'widget_placement_unsupported', error: 'widget_placement_unsupported' };
            domain = { kind: 'widget_remove', instanceId, ...(intent.expectedInstance ? { expectedInstance: intent.expectedInstance } : {}),
              ...(expected ? { expectedPresentation: { nativeIndex: expected.nativeIndex, frameStyle: expected.frameStyle, ...(expected.hidden === undefined ? {} : { hidden: expected.hidden }), ...(size.success ? { size: size.data } : {}) } } : {}) };
            break;
          }
          case 'rename': domain = { kind: 'widget_rename', instanceId, ...(intent.displayName ? { displayName: intent.displayName } : {}) }; break;
          case 'size': {
            const size = WidgetGridSizeV1Schema.safeParse(intent.size);
            if (!size.success) return { ok: false, errorCode: 'widget_size_unsupported', error: 'widget_size_unsupported' };
            domain = { kind: 'widget_size', instanceId, size: size.data }; break;
          }
          case 'frame': domain = { kind: 'frameStyle', sectionId: instanceId, frameStyle: intent.frameStyle }; break;
          case 'inputs': domain = { kind: 'widget_inputs', instanceId, bindings: intent.bindings }; break;
          case 'move': {
            if ('nativeIndex' in intent) {
              if (intent.tabId) return { ok: false, errorCode: 'widget_placement_unsupported', error: 'widget_placement_unsupported' };
              domain = { kind: 'move_to', sectionId: instanceId, position: { nativeIndex: intent.nativeIndex } };
              break;
            }
            const state = await port.describe(await port.read(signal), signal);
            const widgets = state.sections.filter(section => section.kind === 'widget' && section.id !== instanceId);
            const anchor = widgets[intent.toIndex];
            domain = { kind: 'move_to', sectionId: instanceId, position: { anchorId: anchor?.id ?? widgets.at(-1)?.id ?? null, placement: anchor ? 'before' : 'after' } };
            break;
          }
        }
        const committed = await port.apply(domain, signal);
        return { ok: true, result: { ref: { surface, instanceId }, instance: intent.kind === 'remove' ? null : committed.layout.instances.find(instance => instance.id === instanceId) ?? null,
          ...(intent.kind === 'add' && intent.captureForMove ? { moveCapture: await capture(committed, instanceId, signal) } : {}) } };
      } catch (error) {
        if (error instanceof HomeHubMutationErrorV1) return { ok: false, errorCode: error.code, error: error.code };
        throw error;
      }
    },
  };
}
