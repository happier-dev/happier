import { captureWidgetLayoutFragmentGroupV1, getWidgetSupportedSizesV1, instantiateWidgetLayoutFragmentGroupV1,
    type WidgetLayoutFragmentDraftV1, type WidgetLayoutFragmentGroupV1, type WidgetLayoutGroupV1,
    type WidgetSurfaceRefV1, type WidgetProjectAreaV1 } from '@happier-dev/protocol/widgets';
import { randomUUID } from '@/platform/randomUUID';
import { isPublicProfileWidgetSurfaceV1, isSameWidgetDefinitionV1, translateWidgetPublicProfileCopyV1 } from '@happier-dev/protocol/widgets';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionPrepareResult } from '@happier-dev/protocol/actions/executor/types';
import { createWidgetArtifactWriteAttempt, reviewWidgetGroupAddCommandV1, runWidgetDefinitionCommand, type WidgetCommandTarget } from './widgetDefinitionCommands';

/** One Save intent retains its prepared fragment identity until the Home acknowledges it. */
export function createSaveWidgetGroupAttemptV1(target: WidgetCommandTarget) {
    const attempt = createWidgetArtifactWriteAttempt('widgets.fragment.create', target);
    return {
        run(group: WidgetLayoutGroupV1, descriptor: Omit<WidgetLayoutFragmentDraftV1, 'group'>, signal?: AbortSignal) {
            return attempt.run(() => ({ account: target, artifactId: randomUUID(),
                fragment: { ...descriptor, group: captureWidgetLayoutFragmentGroupV1(group) } }), signal);
        },
    };
}

type GroupPlacementOptions = Readonly<{ name?: string; toIndex?: number; area?: WidgetProjectAreaV1; signal?: AbortSignal;
    widgetAreaContext?: ActionExecutorContext['widgetAreaContext'] }>;

const presentationUnavailable: ActionExecuteFailure = {
    ok: false, errorCode: 'widget_public_profile_presentation_unavailable', error: 'widget_public_profile_presentation_unavailable',
};

/** Gallery review, Gallery Add and Add-to prepare the same placement operand for the atomic Action. */
async function prepareGroupPlacement(group: WidgetLayoutFragmentGroupV1, surface: WidgetSurfaceRefV1, options: GroupPlacementOptions) {
    const targetGroup = getWidgetSupportedSizesV1(surface.owner.kind).length === 0
        ? { ...group, children: group.children.map(({ size: _sourceSize, ...child }) => child) }
        : group;
    const copy = instantiateWidgetLayoutFragmentGroupV1(targetGroup, { groupId: randomUUID(),
        childIds: targetGroup.children.map(() => randomUUID()) });
    let placement = copy;
    if (isPublicProfileWidgetSurfaceV1(surface)) {
        const catalog = await runWidgetDefinitionCommand('widgets.catalog.list', { surface }, surface, options.signal);
        if (catalog.kind !== 'applied') return catalog.kind === 'refused' ? {
            ok: false as const, errorCode: catalog.errorCode, error: catalog.errorCode, details: catalog.details,
        } : presentationUnavailable;
        const children: WidgetLayoutGroupV1['children'][number][] = [];
        for (const child of copy.children) {
            const entry = catalog.result.entries.find(entry => entry.availability === 'available' && isSameWidgetDefinitionV1(entry.definition, child.instance.definition));
            const instance = entry ? translateWidgetPublicProfileCopyV1(child.instance, { ...entry, inputs: { fields: entry.fields } }) : null;
            if (!instance) return presentationUnavailable;
            children.push({ ...child, instance });
        }
        const { context: _privateContext, ...publicGroup } = copy;
        placement = { ...publicGroup, children };
    }
    return { ok: true as const, input: { surface, group: { ...placement, ...(options.name === undefined ? {} : { title: options.name }),
        ...(options.area ? { area: options.area } : {}) },
        ...(options.toIndex !== undefined ? { toIndex: options.toIndex } : {}) } };
}

export function runAddWidgetLayoutFragmentCommandV1(group: WidgetLayoutFragmentGroupV1, surface: WidgetSurfaceRefV1,
    options: GroupPlacementOptions = {}) {
    return runWidgetDefinitionCommand('widgets.group.add', async () => {
        const prepared = await prepareGroupPlacement(group, surface, options);
        if (!prepared.ok) throw Object.assign(new Error(presentationUnavailable.error), { code: presentationUnavailable.errorCode });
        return prepared.input;
    }, surface, options.signal, options.widgetAreaContext);
}

export async function reviewAddWidgetLayoutFragmentCommandV1(group: WidgetLayoutFragmentGroupV1, surface: WidgetSurfaceRefV1,
    options: GroupPlacementOptions & Readonly<{ signal: AbortSignal }>): Promise<ActionPrepareResult> {
    const prepared = await prepareGroupPlacement(group, surface, options);
    return prepared.ok ? reviewWidgetGroupAddCommandV1(prepared.input, options.widgetAreaContext, options.signal)
        : { kind: 'settled', result: prepared };
}

export function runCopyWidgetGroupCommandV1(group: WidgetLayoutGroupV1, surface: WidgetSurfaceRefV1,
    options: Readonly<{ toIndex?: number; area?: WidgetProjectAreaV1; signal?: AbortSignal }> = {}) {
    return runWidgetDefinitionCommand('widgets.group.add', async () => {
        const prepared = await prepareGroupPlacement(captureWidgetLayoutFragmentGroupV1(group), surface, options);
        if (!prepared.ok) throw Object.assign(new Error(presentationUnavailable.error), { code: presentationUnavailable.errorCode });
        return prepared.input;
    }, surface, options.signal);
}
