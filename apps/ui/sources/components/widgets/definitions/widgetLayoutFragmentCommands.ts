import { captureWidgetLayoutFragmentGroupV1, instantiateWidgetLayoutFragmentGroupV1,
    type WidgetLayoutFragmentDraftV1, type WidgetLayoutFragmentGroupV1, type WidgetLayoutGroupV1,
    type WidgetSurfaceRefV1, type WidgetProjectAreaV1 } from '@happier-dev/protocol/widgets';
import { randomUUID } from '@/platform/randomUUID';
import { runWidgetDefinitionCommand, type WidgetCommandTarget } from './widgetDefinitionCommands';

/** Saving copies content into a fragment; the source group keeps its own independent layout. */
export function runSaveWidgetGroupCommandV1(group: WidgetLayoutGroupV1,
    descriptor: Omit<WidgetLayoutFragmentDraftV1, 'group'>, target: WidgetCommandTarget, signal?: AbortSignal) {
    return runWidgetDefinitionCommand('widgets.fragment.create', { account: target, artifactId: randomUUID(),
        fragment: { ...descriptor, group: captureWidgetLayoutFragmentGroupV1(group) } }, target, signal);
}

/** Gallery and Add-to use one copy path and allocate placement identities before the atomic Action. */
export function runAddWidgetLayoutFragmentCommandV1(group: WidgetLayoutFragmentGroupV1, surface: WidgetSurfaceRefV1,
    options: Readonly<{ toIndex?: number; area?: WidgetProjectAreaV1; signal?: AbortSignal }> = {}) {
    const copy = instantiateWidgetLayoutFragmentGroupV1(group, { groupId: randomUUID(), childIds: group.children.map(() => randomUUID()) });
    return runWidgetDefinitionCommand('widgets.group.add', { surface, group: { ...copy, ...(options.area ? { area: options.area } : {}) },
        ...(options.toIndex !== undefined ? { toIndex: options.toIndex } : {}) }, surface, options.signal);
}

export function runCopyWidgetGroupCommandV1(group: WidgetLayoutGroupV1, surface: WidgetSurfaceRefV1,
    options: Readonly<{ toIndex?: number; area?: WidgetProjectAreaV1; signal?: AbortSignal }> = {}) {
    return runAddWidgetLayoutFragmentCommandV1(captureWidgetLayoutFragmentGroupV1(group), surface, options);
}
