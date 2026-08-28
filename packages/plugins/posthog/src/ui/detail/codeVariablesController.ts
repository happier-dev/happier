/** Active-Stack-panel ownership for warning-confirmed Tier-3 code variables. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import type { TriageDetailSurfaceInputV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID } from '../../posthogContracts.js';
import {
    PosthogCodeVariablesResultV1Schema,
} from '../../source/detail/codeVariablesContract.js';
import type { PosthogOccurrenceControllerV1 } from './occurrenceController.js';

export type PosthogCodeVariablesStateV1 =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'confirming' }>
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'revealed'; variablesText: string; truncated: boolean }>
    | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

const IDLE: PosthogCodeVariablesStateV1 = Object.freeze({ kind: 'idle' });

export type PosthogCodeVariablesControllerV1 = Readonly<{
    available: boolean;
    state: PosthogCodeVariablesStateV1;
    requestReveal: () => void;
    cancel: () => void;
    confirm: () => void;
}>;

export function usePosthogCodeVariablesController(
    input: TriageDetailSurfaceInputV1,
    occurrences: PosthogOccurrenceControllerV1,
): PosthogCodeVariablesControllerV1 {
    const { active, activeSignal } = useTabPanelActivity();
    const [state, setState] = useState<PosthogCodeVariablesStateV1>(IDLE);
    const generation = useRef(0);
    const pending = useRef(false);
    const action = useMemo(
        () => ({ pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.codeVariables }),
        [],
    );
    const { execute } = useExecutePluginAction(action);
    const selected = occurrences.selectedEvent;
    const frozenRequest = occurrences.selectedFrozenRequest;
    const selectedOffset = occurrences.selectedAbsoluteOffset;
    const available = active
        && selected !== undefined
        && frozenRequest !== undefined
        && selectedOffset !== undefined;

    useEffect(() => {
        generation.current += 1;
        pending.current = false;
        setState(IDLE);
    }, [
        active,
        frozenRequest,
        input.observation.entryRef.collisionScope,
        input.observation.entryRef.entryId,
        input.observation.entryRef.kindId,
        selected?.uuid,
        selectedOffset,
    ]);

    const requestReveal = useCallback(() => {
        if (available) setState({ kind: 'confirming' });
    }, [available]);
    const cancel = useCallback(() => {
        generation.current += 1;
        pending.current = false;
        setState(IDLE);
    }, []);
    const confirm = useCallback(() => {
        if (!available || selected === undefined || frozenRequest === undefined
            || selectedOffset === undefined || state.kind !== 'confirming' || pending.current) return;
        const token = generation.current + 1;
        generation.current = token;
        pending.current = true;
        setState({ kind: 'loading' });
        void (async () => {
            const execution = await execute({
                v: 1,
                instance: input.instance,
                localRef: {
                    kindId: input.observation.entryRef.kindId,
                    collisionScope: input.observation.entryRef.collisionScope,
                    entryId: input.observation.entryRef.entryId,
                },
                selectedUuid: selected.uuid,
                selectedOffset,
                frozenRequest,
            }, { signal: activeSignal });
            if (activeSignal.aborted || token !== generation.current) return;
            pending.current = false;
            if (execution.status !== 'success') {
                setState({
                    kind: 'unavailable',
                    failure: {
                        class: execution.status === 'error' ? 'transient' : 'unknown',
                        code: execution.status === 'idle' || execution.status === 'pending'
                            ? 'posthog/code-variables-not-dispatched'
                            : execution.code,
                    },
                });
                return;
            }
            const parsed = PosthogCodeVariablesResultV1Schema.safeParse(execution.result);
            if (!parsed.success) {
                setState({
                    kind: 'unavailable',
                    failure: {
                        class: 'unsupportedContract',
                        code: 'posthog/code-variables-result-unreadable',
                    },
                });
                return;
            }
            setState(parsed.data.kind === 'unavailable'
                ? { kind: 'unavailable', failure: parsed.data.failure }
                : {
                    kind: 'revealed',
                    variablesText: parsed.data.variablesText,
                    truncated: parsed.data.truncated === true,
                });
        })();
    }, [
        activeSignal,
        available,
        execute,
        frozenRequest,
        input.instance,
        input.observation.entryRef,
        selected,
        selectedOffset,
        state.kind,
    ]);

    return useMemo(() => ({
        available,
        state,
        requestReveal,
        cancel,
        confirm,
    }), [available, cancel, confirm, requestReveal, state]);
}
