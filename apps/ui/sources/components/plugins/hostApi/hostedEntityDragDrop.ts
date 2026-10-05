import {
    PluginUiReadEntityDragItemRequestV1Schema,
    PluginUiUpdateEntityDragDropRequestV1Schema,
    PluginUiWatchEntityDragDropRequestV1Schema,
    type EntityDragItemV1,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import { entityHostedPointerToWindow } from '@/components/ui/treeDragDrop/geometry/entityDragCoordinateSpace';
import type { WindowBounds } from '@/components/ui/treeDragDrop/treeDragDropTypes';
import type { EntityDragCarry } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { PluginEntityDragDropBinding, PluginEntityDragSourceMount } from '../surfaces/entityDragDrop/pluginEntityDragDropBinding';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiHandlers } from '../surfaces/createPluginSurfaceHostApi';

/** Host-owned retirement handles and local coordinates; target selection belongs only to E01. */
export function createHostedEntityDragDropHandlers(input: Readonly<{
    binding: PluginEntityDragDropBinding;
    isCurrent: () => boolean;
    readSessionItem: () => EntityDragItemV1 | null;
}>): Readonly<{ handlers: PluginSurfaceHostApiHandlers; dispose: () => void }> {
    const mounts = new Map<string, Readonly<{ id: string; dispose: () => void; source?: PluginEntityDragSourceMount; layout?: { bounds: WindowBounds; viewport: { width: number; height: number } } }>>();
    let frameBounds: WindowBounds | null = null;
    let readFrameBounds: (() => Promise<WindowBounds | null>) | undefined;
    let carry: EntityDragCarry | null = null;
    let disposed = false;
    let pendingCommands: Promise<void> = Promise.resolve();
    const operations = new Set<Readonly<{ command: 'mount' | 'begin' | 'pointer'; mountId?: string; cancellation: AbortController }>>();
    const current = () => !disposed && input.isCurrent();
    const measure = async () => { frameBounds = await readFrameBounds?.() ?? null; };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const operation of operations) operation.cancellation.abort();
        carry?.cancel('hosted-surface-retired');
        carry = null;
        for (const mount of mounts.values()) mount.dispose();
        mounts.clear();
    };
    return {
        dispose,
        handlers: {
            watchEntityDragDrop: (request, options) => {
                if (!current() || !options?.entityDragDropSubscription) return createPluginSurfaceHostApiError('unavailable');
                const record = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) ? request.payload : {};
                const payload = { ...record };
                Reflect.deleteProperty(payload, 'subscriptionId');
                const parsed = PluginUiWatchEntityDragDropRequestV1Schema.safeParse(payload);
                if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload');
                const source = mounts.get(parsed.data.mountId)?.source;
                if (!source?.isCurrent()) return createPluginSurfaceHostApiError('unavailable');
                const publish = () => {
                    const valid = current() && source.isCurrent();
                    const snapshot = input.binding.runtime.getSnapshot();
                    const own = valid && snapshot.sourceId === source.id;
                    options.entityDragDropSubscription?.publish({ current: valid, phase: own ? snapshot.phase : 'idle', admission: own ? snapshot.admission : null, outcome: own ? snapshot.outcome : null, destinations: valid ? [...input.binding.runtime.getDestinations(source.id)] : [] });
                };
                const unsubscribe = input.binding.runtime.subscribe(publish);
                options.entityDragDropSubscription.retain(unsubscribe);
                publish();
                return {};
            },
            readEntityDragItem: request => {
                if (!current()) return createPluginSurfaceHostApiError('unavailable');
                if (!PluginUiReadEntityDragItemRequestV1Schema.safeParse(request.payload).success) return createPluginSurfaceHostApiError('invalid_payload');
                return input.readSessionItem();
            },
            updateEntityDragDrop: (request, options): PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1> => {
                if (!current()) return createPluginSurfaceHostApiError('unavailable');
                const immediate = PluginUiUpdateEntityDragDropRequestV1Schema.safeParse(request.payload);
                if (!immediate.success) return createPluginSurfaceHostApiError('invalid_payload');
                const command = immediate.data;
                // Explicit cancellation/retirement interrupts a release still measuring. A normal
                // browser dragend follows its already-delivered drop and waits for that settlement.
                if (immediate.success && immediate.data.kind === 'cancel' && immediate.data.reason !== 'gesture-end') {
                    const source = command.kind === 'cancel' && command.mountId ? mounts.get(command.mountId)?.source : undefined;
                    const scoped = command.kind === 'cancel' && command.mountId !== undefined;
                    for (const operation of operations) if (operation.command !== 'mount' && (!scoped || operation.mountId === command.mountId)) operation.cancellation.abort();
                    if (scoped && (!source?.isCurrent() || input.binding.runtime.getSnapshot().sourceId !== source.id)) return { accepted: false };
                    carry?.cancel('hosted-pointer-cancel');
                    carry = null;
                    input.binding.runtime.cancel('hosted-pointer-cancel');
                    return { accepted: current() };
                }
                if (immediate.success && immediate.data.kind === 'unmount') {
                    for (const operation of operations) if (operation.mountId === immediate.data.mountId) operation.cancellation.abort();
                    mounts.get(immediate.data.mountId)?.dispose();
                    mounts.delete(immediate.data.mountId);
                    return { accepted: current() };
                }
                const operation = { command: (immediate.data.kind === 'mountSource' || immediate.data.kind === 'mountTarget' || immediate.data.kind === 'layout') ? 'mount' as const : immediate.data.kind === 'begin' ? 'begin' as const : 'pointer' as const,
                    ...(immediate.success && 'mountId' in immediate.data ? { mountId: immediate.data.mountId } : {}), cancellation: new AbortController() };
                operations.add(operation);
                const cancellation = mergeAbortSignals([operation.cancellation.signal, options?.signal]);
                const result = pendingCommands.then(async (): Promise<PluginUiJsonValueV1> => {
                if (!current()) return createPluginSurfaceHostApiError('unavailable');
                if (operation.cancellation.signal.aborted || options?.signal?.aborted) return { accepted: false };
                if (command.kind === 'cancel') {
                    const source = command.mountId ? mounts.get(command.mountId)?.source : undefined;
                    if (command.mountId && (!source?.isCurrent() || input.binding.runtime.getSnapshot().sourceId !== source.id)) return { accepted: false };
                    carry?.cancel('hosted-pointer-cancel');
                    carry = null;
                    return { accepted: true };
                }
                if (command.kind === 'unmount') {
                    mounts.get(command.mountId)?.dispose();
                    mounts.delete(command.mountId);
                    return { accepted: true };
                }
                if (command.kind === 'mountSource') {
                    if (!await input.binding.waitForSourceRegistration(command.sourceId, cancellation.signal)) return { accepted: false };
                    mounts.get(command.mountId)?.dispose();
                    mounts.delete(command.mountId);
                    const source = input.binding.mountSource(command);
                    if (!source) return { accepted: false };
                    mounts.set(command.mountId, { id: source.id, dispose: source.dispose, source });
                    return { accepted: true };
                }
                if (command.kind === 'destinations') {
                    const source = mounts.get(command.mountId)?.source;
                    return source?.isCurrent() ? { accepted: true, destinations: [...input.binding.runtime.getDestinations(source.id)], description: input.binding.runtime.describeSource(source.id) } : { accepted: false };
                }
                if (command.kind === 'choose') {
                    const source = mounts.get(command.mountId)?.source;
                    if (!carry || !source?.isCurrent() || input.binding.runtime.getSnapshot().sourceId !== source.id) return { accepted: false };
                    carry.choose(command.targetId, command.destination);
                    return { accepted: input.binding.runtime.getSnapshot().phase === 'carrying' };
                }
                if (command.kind === 'commit') {
                    const source = mounts.get(command.mountId)?.source;
                    if (!carry || !source?.isCurrent() || input.binding.runtime.getSnapshot().sourceId !== source.id) return { accepted: false };
                    const active = carry;
                    const outcome = await active.release();
                    if (carry === active) carry = null;
                    return { accepted: outcome !== null, outcome };
                }
                if (command.kind === 'perform') {
                    const source = mounts.get(command.mountId)?.source;
                    if (!source?.isCurrent()) return { accepted: false };
                    const outcome = await input.binding.runtime.perform(source.id, command.targetId, command.destination);
                    return { accepted: outcome !== null, outcome };
                }
                if (command.kind === 'begin' && command.input === 'keyboard') {
                    carry = mounts.get(command.mountId)?.source?.begin('keyboard') ?? null;
                    return { accepted: carry !== null };
                }
                readFrameBounds = options?.getHostedFrameBounds ?? readFrameBounds;
                if (!readFrameBounds) return createPluginSurfaceHostApiError('unavailable', ['hosted-drag-measurement-unavailable']);
                if (command.kind === 'mountTarget') {
                    if (!await input.binding.waitForTargetRegistration(command.targetId, cancellation.signal)) return { accepted: false };
                    mounts.get(command.mountId)?.dispose();
                    mounts.delete(command.mountId);
                    await measure();
                    if (!current() || operation.cancellation.signal.aborted || options?.signal?.aborted) return { accepted: false };
                    const layout = { bounds: command.bounds, viewport: command.viewport };
                    const target = input.binding.mountTarget({ ...command, parentId: command.parentId ? input.binding.runtimeMountId(command.parentId) : undefined, refreshBounds: measure,
                        getBounds: () => {
                            if (!frameBounds) return null;
                            const viewport = { bounds: frameBounds, localWidth: layout.viewport.width, localHeight: layout.viewport.height };
                            const start = entityHostedPointerToWindow(layout.bounds, viewport);
                            const end = entityHostedPointerToWindow({ x: layout.bounds.x + layout.bounds.width, y: layout.bounds.y + layout.bounds.height }, viewport);
                            return start && end ? { ...start, width: end.x - start.x, height: end.y - start.y } : null;
                        } });
                    if (!target) return { accepted: false };
                    mounts.set(command.mountId, { id: target.id, dispose: target.dispose, layout });
                    return { accepted: true };
                }
                if (command.kind === 'layout') {
                    const layout = mounts.get(command.mountId)?.layout;
                    if (!layout) return { accepted: false };
                    layout.bounds = command.bounds;
                    layout.viewport = command.viewport;
                    await measure();
                    if (!current() || operation.cancellation.signal.aborted || options?.signal?.aborted) return { accepted: false };
                    input.binding.runtime.refresh();
                    return { accepted: true };
                }
                const existingCarry = carry;
                const sourceIdBeforeMeasure = input.binding.runtime.getSnapshot().sourceId;
                await measure();
                if (!current() || operation.cancellation.signal.aborted || options?.signal?.aborted) return { accepted: false };
                const pointer = frameBounds ? entityHostedPointerToWindow(command.pointer, {
                    bounds: frameBounds, localWidth: command.viewport.width, localHeight: command.viewport.height,
                }) : null;
                if (!pointer) return { accepted: false };
                if (command.kind === 'begin') {
                    carry = mounts.get(command.mountId)?.source?.begin() ?? null;
                    carry?.move(pointer);
                    return { accepted: carry !== null };
                }
                if (carry !== existingCarry || input.binding.runtime.getSnapshot().sourceId !== sourceIdBeforeMeasure) return { accepted: false };
                if (command.kind === 'move') {
                    if (carry) carry.move(pointer);
                    else input.binding.runtime.move(pointer);
                    return { accepted: input.binding.runtime.getSnapshot().phase === 'carrying' };
                }
                if (carry) carry.move(pointer);
                else input.binding.runtime.move(pointer);
                const outcome = carry ? await carry.release() : await input.binding.runtime.release();
                carry = null;
                return { accepted: outcome !== null, outcome };
                });
                pendingCommands = result.then(() => { operations.delete(operation); cancellation.dispose(); }, () => { operations.delete(operation); cancellation.dispose(); });
                return result;
            },
        },
    };
}
