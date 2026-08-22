import {
    normalizeActionInputByFieldHints,
    resolveEffectiveActionInputFields,
    type ActionInputHints,
    type EffectiveActionInputField,
} from '@happier-dev/protocol';

import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export type ActionInputFormPresentation = Readonly<{
    title: string;
    description: string | null;
    /** The already-normalized Protocol descriptor; this form never infers fields from a schema. */
    inputHints: ActionInputHints;
}>;

export type ActionInputFormSubmissionResult = Readonly<{ ok: boolean }>;

/**
 * The transient form signal is distinct from the Action invocation signal.
 * It fences presentation-local work when this form retires without giving the
 * presentation authority to cancel canonical Action dispatch.
 */
export type ActionInputFormSubmitContext = Readonly<{
    signal: AbortSignal;
}>;

/**
 * The Action form borrows the active Account lifetime; it never creates a
 * second Account/currentness owner or receives Account identity itself.
 */
export type ActionInputFormAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

const MAX_ACTION_INPUT_FORM_DEADLINE_MS = 2_147_483_647;

function isBoundedDeadlineMs(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0
        && value <= MAX_ACTION_INPUT_FORM_DEADLINE_MS;
}

export type ActionInputFormSubmitOutcome<
    TResult extends ActionInputFormSubmissionResult = ActionInputFormSubmissionResult,
    TUnavailableReason extends string = 'submission_in_flight',
    TStaleReason extends string = 'presentation_retired',
> =
    | Readonly<{ kind: 'settled'; outcome: TResult }>
    | Readonly<{ kind: 'unavailable'; reason: TUnavailableReason }>
    | Readonly<{ kind: 'stale'; reason: TStaleReason }>;

export type ActionInputForm<
    TResult extends ActionInputFormSubmissionResult = ActionInputFormSubmissionResult,
    TUnavailableReason extends string = 'submission_in_flight',
    TStaleReason extends string = 'presentation_retired',
> = Readonly<{
    presentation: ActionInputFormPresentation;
    getInput(): Readonly<Record<string, unknown>>;
    replaceInput(input: Readonly<Record<string, unknown>>): void;
    isRetired(): boolean;
    isSubmitting(): boolean;
    getFields(): readonly EffectiveActionInputField[];
    subscribe(listener: () => void): () => void;
    submit(): Promise<ActionInputFormSubmitOutcome<TResult, TUnavailableReason, TStaleReason>>;
    cancel(): void;
    retire(): void;
}>;

type ActionInputFormSubmitResult<
    TResult extends ActionInputFormSubmissionResult,
    TUnavailableReason extends string,
    TStaleReason extends string,
> = TResult | ActionInputFormSubmitOutcome<TResult, TUnavailableReason, TStaleReason>;

function isActionInputFormSubmitOutcome<
    TResult extends ActionInputFormSubmissionResult,
    TUnavailableReason extends string,
    TStaleReason extends string,
>(
    value: ActionInputFormSubmitResult<TResult, TUnavailableReason, TStaleReason>,
): value is ActionInputFormSubmitOutcome<TResult, TUnavailableReason, TStaleReason> {
    return typeof value === 'object' && value !== null && 'kind' in value;
}

/** Removes one declared dot-path without retaining empty object branches. */
function removeActionInputPath(
    input: Readonly<Record<string, unknown>>,
    path: string,
): Readonly<Record<string, unknown>> {
    const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) return input;

    const remove = (value: unknown, index: number): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const record = value as Readonly<Record<string, unknown>>;
        const segment = segments[index]!;
        if (!(segment in record)) return value;

        const output: Record<string, unknown> = { ...record };
        if (index === segments.length - 1) {
            delete output[segment];
            return output;
        }

        const child = remove(record[segment], index + 1);
        if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
            delete output[segment];
        } else {
            output[segment] = child;
        }
        return output;
    };

    const result = remove(input, 0);
    return result && typeof result === 'object' && !Array.isArray(result)
        ? result as Readonly<Record<string, unknown>>
        : {};
}

/**
 * A rejected submission may retain its safe draft for correction/retry, but a
 * secret must leave presentation state before the canonical owner is invoked.
 */
function removeActionInputSecrets(
    input: Readonly<Record<string, unknown>>,
    inputHints: ActionInputHints,
): Readonly<Record<string, unknown>> {
    return inputHints.fields.reduce(
        (current, field) => field.widget === 'secret'
            ? removeActionInputPath(current, field.path)
            : current,
        input,
    );
}

/**
 * The single transient owner for a normalized Action form. It only presents
 * fields and hands a candidate to the caller-supplied owner; final schema
 * validation, policy, persistence and dispatch remain outside this form.
 */
export function createActionInputForm<
    TResult extends ActionInputFormSubmissionResult = ActionInputFormSubmissionResult,
    TUnavailableReason extends string = 'submission_in_flight',
    TStaleReason extends string = 'presentation_retired',
>(params: Readonly<{
    presentation: ActionInputFormPresentation;
    submit: (
        candidate: Readonly<Record<string, unknown>>,
        context: ActionInputFormSubmitContext,
    ) => Promise<
        ActionInputFormSubmitResult<TResult, TUnavailableReason, TStaleReason>
    >;
    /** Captured by the host that owns the active Account scope. */
    accountLifetime?: ActionInputFormAccountLifetime | null;
    /** Host-owned present-user invocation deadline; invalid values fail closed. */
    deadlineMs?: number;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    submissionInFlightReason?: TUnavailableReason;
    retiredReason?: TStaleReason;
    /** Called only for an explicit user dismissal, before the form retires. */
    onCancel?: () => void;
    /** Called once for every retirement path, including cancel and outer abort. */
    onRetire?: () => void;
}>): ActionInputForm<TResult, TUnavailableReason, TStaleReason> {
    let input: Readonly<Record<string, unknown>> = {};
    let retired = false;
    let submitting = false;
    let abortCleanup: (() => void) | null = null;
    let accountLifetimeCleanup: (() => void) | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const listeners = new Set<() => void>();
    const presentationAbortController = new AbortController();
    // The presentation signal includes outer host retirement and is passed
    // through the submit callback to the canonical Action owner.
    const mergedSignal = mergeAbortSignals([presentationAbortController.signal, params.signal]);
    const signal = mergedSignal.signal;
    const submissionInFlightReason = params.submissionInFlightReason
        ?? ('submission_in_flight' as TUnavailableReason);
    const retiredReason = params.retiredReason ?? ('presentation_retired' as TStaleReason);

    const notify = () => {
        for (const listener of listeners) listener();
    };
    const clear = () => {
        input = {};
        notify();
    };
    const clearDeadline = () => {
        if (deadlineTimer === null) return;
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
    };
    const retire = () => {
        if (retired) return;
        retired = true;
        presentationAbortController.abort();
        mergedSignal.dispose();
        clear();
        abortCleanup?.();
        abortCleanup = null;
        accountLifetimeCleanup?.();
        accountLifetimeCleanup = null;
        clearDeadline();
        params.onRetire?.();
    };
    const retireIfNoLongerCurrent = (): boolean => {
        if (
            !retired
            && (params.isCurrent?.() === false || params.accountLifetime?.isCurrent() === false)
        ) retire();
        return retired;
    };
    if (signal) {
        const onAbort = () => retire();
        if (signal.aborted) {
            retire();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
            abortCleanup = () => signal.removeEventListener('abort', onAbort);
        }
    }
    if (params.accountLifetime) {
        if (params.accountLifetime.isCurrent() === false) {
            retire();
        } else {
            const subscription = params.accountLifetime.onRetire(retire);
            if (retired) subscription.dispose();
            else accountLifetimeCleanup = () => subscription.dispose();
        }
    }
    if (params.deadlineMs !== undefined && !isBoundedDeadlineMs(params.deadlineMs)) {
        retire();
    }

    return {
        presentation: params.presentation,
        getInput: () => {
            retireIfNoLongerCurrent();
            return input;
        },
        replaceInput: (next) => {
            if (retireIfNoLongerCurrent() || submitting) return;
            input = { ...next };
            notify();
        },
        isRetired: () => {
            retireIfNoLongerCurrent();
            return retired;
        },
        isSubmitting: () => {
            retireIfNoLongerCurrent();
            return submitting;
        },
        getFields: () => {
            if (retireIfNoLongerCurrent()) return [];
            return resolveEffectiveActionInputFields(
                { inputHints: params.presentation.inputHints },
                input,
            );
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        submit: async () => {
            if (retireIfNoLongerCurrent()) {
                return { kind: 'stale', reason: retiredReason };
            }
            if (submitting) return { kind: 'unavailable', reason: submissionInFlightReason };

            const candidate = normalizeActionInputByFieldHints(
                { inputHints: params.presentation.inputHints },
                { ...input },
            );
            // A failed submission leaves safe fields available for correction,
            // but transient secrets never remain in presentation state while
            // the canonical Action owner is running.
            input = removeActionInputSecrets(input, params.presentation.inputHints);
            notify();
            submitting = true;
            if (params.deadlineMs !== undefined && !retired) {
                deadlineTimer = setTimeout(retire, params.deadlineMs);
            }
            notify();
            let retainSafeInput = false;
            try {
                const result = await params.submit(candidate, { signal });
                const outcome: ActionInputFormSubmitOutcome<
                    TResult,
                    TUnavailableReason,
                    TStaleReason
                > = isActionInputFormSubmitOutcome(result)
                    ? result
                    : { kind: 'settled', outcome: result };
                retainSafeInput = outcome.kind === 'unavailable'
                    || (outcome.kind === 'settled' && !outcome.outcome.ok);
                return outcome;
            } catch (error) {
                if (retired || signal.aborted) {
                    return { kind: 'stale', reason: retiredReason };
                }
                retainSafeInput = true;
                throw error;
            } finally {
                clearDeadline();
                submitting = false;
                if (retired || !retainSafeInput) clear();
                else notify();
            }
        },
        cancel: () => {
            if (retired) return;
            try {
                params.onCancel?.();
            } finally {
                retire();
            }
        },
        retire,
    };
}
