import { UiFindInputSchema } from '@happier-dev/protocol/actions/findActionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { FindSurfaceRegistry } from './findSurfaceRegistry';

type FindActionRequest = Parameters<NonNullable<ActionExecutorDeps['uiFindAction']>>[0];
let mountedRegistry: FindSurfaceRegistry | null = null;

/** The mounted keyboard provider binds its own ephemeral registry, just as the palette binds its catalog. */
export function registerFindActionRuntime(registry: FindSurfaceRegistry): () => void {
    mountedRegistry = registry;
    return () => { if (mountedRegistry === registry) mountedRegistry = null; };
}

export async function executeFindAction(request: FindActionRequest): Promise<ActionExecuteResult> {
    request.context.signal?.throwIfAborted();
    const input = UiFindInputSchema.parse(request.input);
    const surface = mountedRegistry?.resolve(input.target);
    if (!surface) return { ok: true, result: { status: 'noMountedSurface' } };
    const controller = surface.controller;
    switch (input.op) {
        case 'set':
            // Capture/refocus the surface before its model's query update can open it.
            surface.open();
            if (input.options) controller.setOptions(input.options);
            controller.setQuery(input.query);
            break;
        case 'step': controller.step(input.direction); break;
        case 'stop': controller.stop(); break;
        case 'close': controller.close(); break;
    }
    if (surface.engineOwnsFind) {
        return { ok: true, result: {
            status: 'unavailable', unavailable: 'engineOwned',
            query: controller.query, options: controller.options,
        } };
    }
    // Project only the declared status fields even if a model carries private engine data.
    const value = surface.controller.status;
    const result = value.kind === 'results'
        ? { status: value.kind, current: value.current, total: value.total, coverage: value.coverage, ...(value.files === undefined ? {} : { files: value.files }) }
        : value.kind === 'searching' ? { status: value.kind, total: value.total }
        : value.kind === 'unavailable' ? { status: value.kind, reason: value.reason }
        : { status: value.kind };
    return { ok: true, result };
}
