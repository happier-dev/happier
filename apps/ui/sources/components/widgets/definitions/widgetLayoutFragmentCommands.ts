import { captureWidgetLayoutFragmentGroupV1, getWidgetSupportedSizesV1, instantiateWidgetLayoutFragmentGroupV1,
    type WidgetLayoutFragmentDraftV1, type WidgetLayoutFragmentGroupV1, type WidgetLayoutGroupV1,
    type WidgetSurfaceRefV1, type WidgetProjectAreaV1 } from '@happier-dev/protocol/widgets';
import { randomUUID } from '@/platform/randomUUID';
import { isPublicProfileWidgetSurfaceV1, isSameWidgetDefinitionV1, translateWidgetPublicProfileCopyV1 } from '@happier-dev/protocol/widgets';
import { createWidgetArtifactWriteAttempt, runWidgetDefinitionCommand, type WidgetCommandTarget } from './widgetDefinitionCommands';

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

/** Gallery and Add-to use one copy path and allocate placement identities before the atomic Action. */
function runPreparedWidgetLayoutFragmentCommandV1(prepareGroup: () => WidgetLayoutFragmentGroupV1, surface: WidgetSurfaceRefV1,
    options: Readonly<{ toIndex?: number; area?: WidgetProjectAreaV1; signal?: AbortSignal }> = {}) {
    return runWidgetDefinitionCommand('widgets.group.add', async () => {
        const group = prepareGroup();
        const targetGroup = getWidgetSupportedSizesV1(surface.owner.kind).length === 0
            ? { ...group, children: group.children.map(({ size: _sourceSize, ...child }) => child) }
            : group;
        const copy = instantiateWidgetLayoutFragmentGroupV1(targetGroup, { groupId: randomUUID(),
            childIds: targetGroup.children.map(() => randomUUID()) });
        let placement = copy;
        if (isPublicProfileWidgetSurfaceV1(surface)) {
            const catalog = await runWidgetDefinitionCommand('widgets.catalog.list', { surface }, surface, options.signal);
            if (catalog.kind !== 'applied') throw Object.assign(new Error('Public snapshot catalog unavailable'), { code: 'widget_public_profile_presentation_unavailable' });
            const children = copy.children.map(child => {
                const entry = catalog.result.entries.find(entry => entry.availability === 'available' && isSameWidgetDefinitionV1(entry.definition, child.instance.definition));
                const instance = entry ? translateWidgetPublicProfileCopyV1(child.instance, { ...entry, inputs: { fields: entry.fields } }) : null;
                if (!instance) throw Object.assign(new Error('Public snapshot unavailable'), { code: 'widget_public_profile_presentation_unavailable' });
                return { ...child, instance };
            });
            const { context: _privateContext, ...publicGroup } = copy;
            placement = { ...publicGroup, children };
        }
        return { surface, group: { ...placement, ...(options.area ? { area: options.area } : {}) },
            ...(options.toIndex !== undefined ? { toIndex: options.toIndex } : {}) };
    }, surface, options.signal);
}

export function runAddWidgetLayoutFragmentCommandV1(group: WidgetLayoutFragmentGroupV1, surface: WidgetSurfaceRefV1,
    options: Readonly<{ name?: string; toIndex?: number; area?: WidgetProjectAreaV1; signal?: AbortSignal }> = {}) {
    return runPreparedWidgetLayoutFragmentCommandV1(() => ({ ...group,
        ...(options.name === undefined ? {} : { title: options.name }) }), surface, options);
}

export function runCopyWidgetGroupCommandV1(group: WidgetLayoutGroupV1, surface: WidgetSurfaceRefV1,
    options: Readonly<{ toIndex?: number; area?: WidgetProjectAreaV1; signal?: AbortSignal }> = {}) {
    return runPreparedWidgetLayoutFragmentCommandV1(() => captureWidgetLayoutFragmentGroupV1(group), surface, options);
}
