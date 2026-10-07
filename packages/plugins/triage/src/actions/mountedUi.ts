import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { invokeTriageMountedUiAction } from '../ui/mountedActions.js';
import { TriageMountedUiInputV1Schema, TriageMountedSourceRevealInputV1Schema, TriageMountedSourceInsertInputV1Schema, type TriageMountedUiInputV1, type TriageMountedUiResultV1 } from './mountedUiProtocol.js';

export function createTriageMountedUiActionHandler(): PluginClientActionHandler<TriageMountedUiInputV1, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedUiInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function createTriageMountedSourceRevealActionHandler(): PluginClientActionHandler<ReturnType<typeof TriageMountedSourceRevealInputV1Schema.parse>, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedSourceRevealInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function createTriageMountedSourceInsertActionHandler(): PluginClientActionHandler<ReturnType<typeof TriageMountedSourceInsertInputV1Schema.parse>, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedSourceInsertInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}
