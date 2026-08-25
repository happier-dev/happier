import * as React from 'react';

import { Modal } from '@/modal';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';

/**
 * The ONE outcome path for every local-service action (tunnels audit §9.2).
 *
 * Six actions — start, terminate, forget, copy-url, stop-managed, restart-managed — plus the three
 * public-preview ones dispatch through `runtimeActionExecute` and, before this module, every single
 * one of them threw the result away. A denial came back as data
 * (`frontDoorRuntimeActionExecutor.ts:39-40` returns `{ ok:false, errorCode, error }` verbatim), the
 * caller schema-parsed it, the parse failed, the caller returned `null`, the sheet closed, the
 * spinner cleared, the row did not change and the product said nothing at all.
 *
 * There is one classifier and one presentation here rather than nine, because "did this work, and
 * if not why" is one concept. Success is deliberately NOT announced by this module: a successful
 * action's evidence is the row changing state, the `CopiedPill`, or the exposure appearing —
 * announcing it twice would be noise.
 */

type UnknownRecord = Record<string, unknown>;

export type LocalServiceActionOutcome =
    | Readonly<{ kind: 'succeeded' }>
    /**
     * `reasonCode` is `null` only when the action never dispatched — a guard in the action hook
     * returned `undefined` because the target could not be addressed. That is still a failure the
     * user must see; it just has no daemon code behind it.
     */
    | Readonly<{ kind: 'failed'; reasonCode: string | null }>;

function asRecord(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Classify whatever a local-service action handler resolved to.
 *
 * Reads the three shapes the corridor can actually produce, in the order they can appear:
 *
 *  1. `undefined` — the hook's own guard refused to dispatch (unaddressable target, missing
 *     machineId). No code, but a failure.
 *  2. `{ ok: false, errorCode }` — the action-executor front door refused before the daemon saw it.
 *  3. `{ status: 'denied' | 'failed', reasonCode }` — the daemon refused or tried and failed. The
 *     protocol guarantees a `reasonCode` on both (`LocalServiceActionResultV1Schema` superRefine),
 *     and the launcher/public-preview responses carry the same `status` discriminator.
 *
 * Anything else is a success payload the caller already knows how to parse.
 */
export function readLocalServiceActionOutcome(result: unknown): LocalServiceActionOutcome {
    if (result === undefined || result === null) {
        return { kind: 'failed', reasonCode: null };
    }
    const record = asRecord(result);
    if (!record) {
        return { kind: 'succeeded' };
    }
    if (record.ok === false) {
        return {
            kind: 'failed',
            reasonCode: readNonEmptyString(record.errorCode) ?? readNonEmptyString(record.error),
        };
    }
    const status = readNonEmptyString(record.status);
    if (status !== null && status !== 'succeeded') {
        return { kind: 'failed', reasonCode: readNonEmptyString(record.reasonCode) };
    }
    return { kind: 'succeeded' };
}

/**
 * Show the failure. Title comes from the caller because only the caller knows which service and
 * which verb; the body comes from the canonical reason-code mapper so a daemon code is never
 * rendered raw, and an unmapped code still produces an actionable sentence.
 */
export function presentLocalServiceActionFailure(input: Readonly<{
    title: string;
    reasonCode: string | null;
}>): void {
    const copy = resolveReasonCopy({ reasonCode: input.reasonCode, kind: 'localServiceAction' });
    Modal.alert(input.title, copy.body);
}

export type LocalServiceActionRunner = Readonly<{
    /** The row currently awaiting a dispatch, so exactly one row shows the in-flight treatment. */
    pendingId: string | null;
    /**
     * Dispatch one action and own its whole visible outcome. Resolves `true` when the action
     * succeeded, so a caller can chain its own success affordance (a `CopiedPill`, a reveal).
     */
    run: (input: Readonly<{
        id: string;
        failureTitle: string;
        action: () => Promise<unknown>;
    }>) => Promise<boolean>;
}>;

/**
 * In-flight + failure, owned once for a whole surface.
 *
 * `pendingId` is a single id rather than a set: these actions all mutate the same machine and the
 * surface never dispatches two at once, so a set would model a state that cannot happen.
 */
export function useLocalServiceActionRunner(): LocalServiceActionRunner {
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    const mountedRef = React.useRef(true);
    // Re-arm on mount, not only disarm on cleanup. React replays effects in development, so a
    // guard that is only ever set to `false` never recovers — and the row it belongs to would
    // stay showing its spinner forever after an action that actually succeeded.
    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const run = React.useCallback(async (input: Readonly<{
        id: string;
        failureTitle: string;
        action: () => Promise<unknown>;
    }>): Promise<boolean> => {
        setPendingId(input.id);
        let outcome: LocalServiceActionOutcome;
        try {
            outcome = readLocalServiceActionOutcome(await input.action());
        } catch {
            // A thrown transport error is the same product event as a returned refusal: the action
            // did not happen and the user has to be told. It carries no daemon reason code.
            outcome = { kind: 'failed', reasonCode: null };
        } finally {
            if (mountedRef.current) {
                setPendingId((current) => (current === input.id ? null : current));
            }
        }
        if (outcome.kind === 'failed') {
            presentLocalServiceActionFailure({
                title: input.failureTitle,
                reasonCode: outcome.reasonCode,
            });
            return false;
        }
        return true;
    }, []);

    return { pendingId, run };
}
