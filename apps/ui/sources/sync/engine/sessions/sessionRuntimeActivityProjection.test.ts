import { describe, expect, it, vi } from 'vitest';

import {
    buildSessionRuntimeActivityProjectionPatch,
    resolveSessionRuntimeActivityProjectionFields,
} from './sessionRuntimeActivityProjection';

describe('sessionRuntimeActivityProjection', () => {
    const current = {
        runtimeActivityState: 'active' as const,
        runtimeActivityActiveCount: 2,
        runtimeActivityObservedAt: 500,
        runtimeActivityRevision: 7,
    };

    it('accepts only a complete valid four-field tuple', () => {
        expect(resolveSessionRuntimeActivityProjectionFields({}, {
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 400,
            runtimeActivityRevision: 1,
        })).toEqual({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 400,
            runtimeActivityRevision: 1,
        });
        expect(resolveSessionRuntimeActivityProjectionFields({}, {
            runtimeActivityState: 'active',
            runtimeActivityRevision: 1,
        })).toEqual({});
        expect(resolveSessionRuntimeActivityProjectionFields({}, {
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 400,
            runtimeActivitySourceClass: 'agent_detached_task',
            runtimeActivityRevision: 1,
        })).toEqual({});
    });

    it('uses the canonical revision merge when resolving projection fields', () => {
        expect(resolveSessionRuntimeActivityProjectionFields(current, {
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 900,
            runtimeActivityRevision: 6,
        })).toEqual({});

        const onResyncRequired = vi.fn();
        expect(resolveSessionRuntimeActivityProjectionFields(current, {
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 501,
            runtimeActivityRevision: 7,
        }, onResyncRequired)).toEqual({});
        expect(onResyncRequired).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'equal_revision_conflict',
        }));
    });

    it('orders atomically by revision and never by observedAt', () => {
        expect(buildSessionRuntimeActivityProjectionPatch(current, {
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 400,
            runtimeActivityRevision: 8,
        })).toEqual({
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 400,
            runtimeActivityRevision: 8,
        });
        expect(buildSessionRuntimeActivityProjectionPatch(current, {
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 900,
            runtimeActivityRevision: 6,
        })).toEqual({});
    });

    it('retains current truth and emits a typed resync trigger on equal conflicts', () => {
        const onResyncRequired = vi.fn();
        expect(buildSessionRuntimeActivityProjectionPatch(current, {
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 501,
            runtimeActivityRevision: 7,
        }, onResyncRequired)).toEqual({});
        expect(onResyncRequired).toHaveBeenCalledWith({
            reason: 'equal_revision_conflict',
            current: {
                state: 'active',
                activeCount: 2,
                observedAt: 500,
                revision: 7,
            },
            incoming: {
                state: 'idle',
                activeCount: 0,
                observedAt: 501,
                revision: 7,
            },
        });
    });
});
