import * as React from 'react';

import {
    ComposerInputLockSnapshotV1Schema,
    type ComposerInputLockSnapshotV1,
    type ComposerRefV1,
} from '@happier-dev/protocol';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';

import type {
    AgentInputComposerDecoration,
    AgentInputComposerInputLock,
} from '@/components/sessions/agentInput/agentInputContracts';

import {
    notifyComposerPresentationTargetChanged,
    type ComposerPresentationDecorationUpdate,
    type ComposerPresentationInputLockLease,
} from './sessionComposerPresentationTargets';

type ComposerPresentationInputRuntime = {
    ref: ComposerRefV1;
    targetKey: string;
    /** Terminal only: scope replacement or Account retirement can never reactivate it. */
    retired: boolean;
    /** React mount state; strict-effect probes must not retire the exact scope. */
    mounted: boolean;
    decorations: Map<string, AgentInputComposerDecoration>;
    locks: Map<string, ComposerPresentationInputLockLease>;
};

export type ComposerPresentationInputEffects = Readonly<{
    composerDecorations: readonly AgentInputComposerDecoration[];
    composerInputLock: AgentInputComposerInputLock | null;
    /** Snapshot readers use the map synchronously, before React has rendered. */
    readComposerInputLock: () => ComposerInputLockSnapshotV1 | null;
    setComposerDecorations: (input: ComposerPresentationDecorationUpdate) => void;
    acquireComposerInputLock: (input: ComposerPresentationInputLockLease) => () => void;
    /** Account retirement clears local projection before a former target can be reused. */
    retire: () => void;
}>;

function effectIdentity(input: Readonly<{
    owner: ComposerPresentationDecorationUpdate['owner'];
    key: string;
}>): string {
    return JSON.stringify([
        input.owner.identity.pluginId,
        input.owner.identity.localId,
        input.owner.immutableGenerationId,
        input.owner.surfaceInstanceKey,
        input.key,
    ]);
}

function inputLockForRuntime(runtime: ComposerPresentationInputRuntime): ComposerInputLockSnapshotV1 | null {
    if (runtime.locks.size === 0) return null;

    let mode: ComposerInputLockSnapshotV1['mode'] = 'submit';
    const reasons: string[] = [];
    for (const lease of runtime.locks.values()) {
        if (lease.request.mode === 'editAndSubmit') {
            mode = 'editAndSubmit';
        }
        const reason = lease.request.reason;
        if (reasons.includes(reason)) continue;
        const candidate = ComposerInputLockSnapshotV1Schema.safeParse({
            mode,
            reasons: [...reasons, reason],
        });
        if (candidate.success) {
            reasons.push(reason);
        }
    }

    const parsed = ComposerInputLockSnapshotV1Schema.safeParse({ mode, reasons });
    return parsed.success ? parsed.data : null;
}

/**
 * Local visual projection for one currently mounted Composer target. The
 * target registry and host handlers retain effect ownership; this hook has no
 * persistence and becomes inert when its exact scope is replaced or retired.
 */
export function useComposerPresentationInputEffects(input: Readonly<{
    ref: ComposerRefV1;
}>): ComposerPresentationInputEffects {
    const runtimeRef = React.useRef<ComposerPresentationInputRuntime | null>(null);
    const targetKey = composerRefV1Key(input.ref);
    const [, forceRender] = React.useReducer((version: number) => version + 1, 0);

    if (runtimeRef.current?.targetKey !== targetKey) {
        if (runtimeRef.current) {
            runtimeRef.current.retired = true;
            runtimeRef.current.mounted = false;
            runtimeRef.current.decorations.clear();
            runtimeRef.current.locks.clear();
        }
        runtimeRef.current = {
            ref: input.ref,
            targetKey,
            retired: false,
            mounted: false,
            decorations: new Map(),
            locks: new Map(),
        };
    }

    const isRuntimeLive = React.useCallback((runtime: ComposerPresentationInputRuntime): boolean => {
        return !runtime.retired
            && runtime.mounted
            && runtimeRef.current === runtime;
    }, []);

    const publishProjection = React.useCallback((runtime: ComposerPresentationInputRuntime): void => {
        if (runtimeRef.current !== runtime) return;
        forceRender();
        notifyComposerPresentationTargetChanged(runtime.ref);
    }, []);

    const setComposerDecorations = React.useCallback((update: ComposerPresentationDecorationUpdate): void => {
        const runtime = runtimeRef.current;
        if (!runtime || !isRuntimeLive(runtime)) return;
        const id = effectIdentity({ owner: update.owner, key: update.key });
        if (update.decorations === null) {
            runtime.decorations.delete(id);
        } else {
            runtime.decorations.set(id, {
                id,
                key: update.key,
                decorations: update.decorations,
            });
        }
        publishProjection(runtime);
    }, [isRuntimeLive, publishProjection]);

    const acquireComposerInputLock = React.useCallback((lease: ComposerPresentationInputLockLease): (() => void) => {
        const runtime = runtimeRef.current;
        if (!runtime || !isRuntimeLive(runtime)) return () => {};
        const lockKey = effectIdentity({ owner: lease.owner, key: lease.subscriptionId });
        const activeLease = { ...lease };
        runtime.locks.set(lockKey, activeLease);
        publishProjection(runtime);

        return () => {
            if (runtimeRef.current !== runtime || runtime.retired) return;
            if (runtime.locks.get(lockKey) !== activeLease) return;
            runtime.locks.delete(lockKey);
            publishProjection(runtime);
        };
    }, [isRuntimeLive, publishProjection]);

    const readComposerInputLock = React.useCallback((): ComposerInputLockSnapshotV1 | null => {
        const runtime = runtimeRef.current;
        return runtime && isRuntimeLive(runtime) ? inputLockForRuntime(runtime) : null;
    }, [isRuntimeLive]);

    const retire = React.useCallback((): void => {
        const runtime = runtimeRef.current;
        if (!runtime || runtime.retired) return;
        runtime.retired = true;
        runtime.mounted = false;
        runtime.decorations.clear();
        runtime.locks.clear();
        publishProjection(runtime);
    }, [publishProjection]);

    // The presentation target itself registers from a passive effect. Establish
    // this local visual lifetime first, so an already-registered target cannot
    // observe a port whose mounted scope is still marked inert.
    React.useLayoutEffect(() => {
        const runtime = runtimeRef.current;
        if (!runtime || runtime.retired || runtimeRef.current !== runtime) return;
        // React's development strict-effects probe runs cleanup/setup once on
        // the same mounted scope. This restores mount currentness only; a
        // scope explicitly retired by its Account owner stays terminal.
        runtime.mounted = true;
        return () => {
            runtime.mounted = false;
            runtime.decorations.clear();
            runtime.locks.clear();
            notifyComposerPresentationTargetChanged(runtime.ref);
        };
    }, [targetKey]);

    const runtime = runtimeRef.current;
    return {
        composerDecorations: runtime && !runtime.retired ? [...runtime.decorations.values()] : [],
        composerInputLock: runtime && !runtime.retired ? inputLockForRuntime(runtime) : null,
        readComposerInputLock,
        setComposerDecorations,
        acquireComposerInputLock,
        retire,
    };
}
