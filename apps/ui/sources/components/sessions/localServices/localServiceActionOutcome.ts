import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema, isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineServiceControlResultV1Schema } from '@happier-dev/protocol';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { LocalServiceNativePrerequisiteV1Schema, type LocalServiceNativePrerequisiteV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceEstablishmentFailureV1Schema, type LocalServiceEstablishmentFailureV1 } from '@happier-dev/protocol/local/services/launcher/v1';

import { Modal } from '@/modal';
import { isLocalServiceActionRefusedByPolicy, resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { resolveLocalServiceStartFailure, type LocalServiceOutputRecovery } from '@/sync/domains/local/services/serviceFailure';

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
    | Readonly<{ kind: 'accepted'; operationId: string }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'outcome_unknown'; reasonCode: 'action_outcome_unknown' }>
    | Readonly<{ kind: 'approval_pending'; artifactId: string; actionId: string }>
    /**
     * `reasonCode` is `null` only when the action never dispatched — a guard in the action hook
     * returned `undefined` because the target could not be addressed. That is still a failure the
     * user must see; it just has no daemon code behind it.
     */
    | Readonly<{ kind: 'failed'; reasonCode: string | null; prerequisite?: LocalServiceNativePrerequisiteV1;
        establishmentFailure?: LocalServiceEstablishmentFailureV1 }>;

function asRecord(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Typed failures only: transport messages can contain private service or request data. */
export function readLocalServiceActionFailureReason(result: unknown): string | null {
    const record = asRecord(result);
    const details = asRecord(record?.details);
    let code = readNonEmptyString(details?.reasonCode) ?? readNonEmptyString(readRpcErrorCode(result))
        ?? readNonEmptyString(record?.code) ?? readNonEmptyString(record?.reasonCode) ?? readNonEmptyString(record?.errorCode);
    if (code === 'runtime_action_disabled' && typeof record?.error === 'string') {
        const prefix = 'runtime_action_disabled:localServices:';
        if (record.error.startsWith(prefix)) code = readNonEmptyString(record.error.slice(prefix.length)) ?? code;
        else {
            const browserReason = /^runtime_action_disabled:browser:([a-z][a-z0-9_]*)$/u.exec(record.error);
            if (browserReason) code = browserReason[1];
        }
    }
    // The Action envelope namespaces the daemon's refusal; the direct preview
    // opener already carries that same producer code. Neither carries prose.
    const previewReason = code && /^local_services_preview_refused:([a-z][a-z0-9_]*)$/u.exec(code);
    return previewReason ? previewReason[1] : code;
}

/**
 * Classify whatever a local-service action handler resolved to.
 *
 * Reads the three shapes the corridor can actually produce, in the order they can appear:
 *
 *  1. `undefined` — the hook's own guard refused to dispatch (unaddressable target, missing
 *     machineId). No code, but a failure.
 *  2. `{ ok: false, errorCode }` — the Action refused, failed, or cannot confirm its outcome.
 *  3. `{ status: 'denied' | 'failed', reasonCode }` — the daemon refused or tried and failed. The
 *     protocol guarantees a `reasonCode` on both (`LocalServiceActionResultV1Schema` superRefine),
 *     and the launcher/public-preview responses carry the same `status` discriminator.
 *
 * Anything else is a success payload the caller already knows how to parse.
 */
function readFailureOutcome(result: unknown): Extract<LocalServiceActionOutcome, { kind: 'failed' | 'cancelled' | 'outcome_unknown' }> {
    const reasonCode = readLocalServiceActionFailureReason(result);
    if (reasonCode === 'action_outcome_unknown') return { kind: 'outcome_unknown', reasonCode };
    if (isActionApprovalDeclinedErrorCode(reasonCode) || reasonCode === 'cancelled') return { kind: 'cancelled' };
    const record = asRecord(result);
    const prerequisite = LocalServiceNativePrerequisiteV1Schema.safeParse(reasonCode === 'native_tool_unavailable'
        ? record?.prerequisite ?? asRecord(record?.details)?.prerequisite : undefined);
    const failure = LocalServiceEstablishmentFailureV1Schema.safeParse(reasonCode === 'plugin_managed_service_establishment_failed'
        ? record?.establishmentFailure ?? asRecord(record?.details)?.establishmentFailure : undefined);
    return { kind: 'failed', reasonCode, ...(prerequisite.success ? { prerequisite: prerequisite.data } : {}),
        ...(failure.success ? { establishmentFailure: failure.data } : {}) };
}

export function readLocalServiceActionOutcome(result: unknown): LocalServiceActionOutcome {
    if (result === undefined || result === null || result === false) {
        return { kind: 'failed', reasonCode: null };
    }
    if (result instanceof Error) return readFailureOutcome(result);
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result);
    if (approval.success) return { kind: 'approval_pending', artifactId: approval.data.artifactId, actionId: approval.data.actionId };
    const control = MachineServiceControlResultV1Schema.safeParse(result);
    if (control.success) {
        if (control.data.kind === 'accepted') return { kind: 'accepted', operationId: control.data.operation.operationId };
        if (control.data.kind === 'outcome_unknown') return { kind: 'outcome_unknown', reasonCode: 'action_outcome_unknown' };
        if (control.data.kind === 'unsupported') return { kind: 'failed', reasonCode: control.data.reason };
        return { kind: 'succeeded' };
    }
    const record = asRecord(result);
    if (!record) {
        return { kind: 'succeeded' };
    }
    if (record.ok === false) {
        return readFailureOutcome(result);
    }
    const status = readNonEmptyString(record.status);
    if (status !== null && status !== 'succeeded') {
        return readFailureOutcome(result);
    }
    return { kind: 'succeeded' };
}

/**
 * The words of a failure, drawn once for the dialog and the inline notice: a person-facing `body`
 * first, and `details` for support (the exit, the last output line, then the code). `refusal` marks a
 * failure that needs the person (a port, Docker, a permission) rather than a process that died.
 */
export function describeLocalServiceActionFailure(input: Readonly<{
    reasonCode: string | null;
    /** The title the failure is drawn under: when it already names the Service, the body does not repeat it. */
    title?: string;
    serviceName?: string;
    serviceTarget?: LocalServiceLaunchTarget;
    servicesActionOffered?: boolean;
    prerequisite?: LocalServiceNativePrerequisiteV1;
    establishmentFailure?: LocalServiceEstablishmentFailureV1;
}>): Readonly<{ title: string; body: string; details: readonly string[]; refusal: boolean; recovery?: LocalServiceOutputRecovery }> {
    const copy = resolveReasonCopy({ reasonCode: input.reasonCode, kind: 'localServiceAction', serviceName: input.serviceName,
        serviceNamedByTitle: Boolean(input.serviceName && input.title?.includes(input.serviceName)),
        servicesActionOffered: input.servicesActionOffered, prerequisite: input.prerequisite,
        establishmentFailure: input.establishmentFailure });
    const failure = input.establishmentFailure;
    const startFailure = input.reasonCode === 'plugin_managed_service_establishment_failed';
    const recovery = startFailure && input.serviceTarget ? resolveLocalServiceStartFailure(input.serviceTarget)?.recovery : null;
    return {
        title: copy.title,
        ...(recovery ? { recovery } : {}),
        body: copy.body,
        details: [
            ...(input.serviceName && failure?.cause === 'port_in_use' && failure.port !== undefined
                ? [resolveReasonCopy({ kind: 'localServiceAction', reasonCode: input.reasonCode, establishmentFailure: failure }).body] : []),
            ...(failure?.exitCode !== undefined ? [t('localServices.actions.failure.exitCode', { code: String(failure.exitCode) })] : []),
            ...(failure?.signal ? [failure.signal] : []),
            ...(failure?.lastStderrLine ? [failure.lastStderrLine] : []),
            ...(input.reasonCode ? [input.reasonCode] : []),
        ],
        refusal: input.prerequisite !== undefined || failure?.cause === 'port_in_use' || isLocalServiceActionRefusedByPolicy(input.reasonCode),
    };
}

/**
 * Show the failure in a dialog. Title comes from the caller because only the caller knows which
 * service and which verb; the body comes from the canonical reason-code mapper, with the typed cause
 * in a deliberate Details action. Private transport messages are never displayed.
 */
export function presentLocalServiceActionFailure(input: Readonly<{
    title: string;
    reasonCode: string | null;
    serviceName?: string;
    servicesActionOffered?: boolean;
    prerequisite?: LocalServiceNativePrerequisiteV1;
    establishmentFailure?: LocalServiceEstablishmentFailureV1;
}>): void {
    const { body, details } = describeLocalServiceActionFailure(input);
    Modal.alert(input.title, body, details.length > 0 ? [
        { text: t('common.ok'), style: 'cancel' },
        { text: t('common.details'), onPress: () => Modal.alert(input.title, details.join('\n')) },
    ] : undefined);
}

/** An action needing attention, drawn in place (see `LocalServiceActionFailureNotice`). */
export type LocalServiceActionFailure = Readonly<{
    title: string;
    reasonCode: string | null;
    body: string;
    details: readonly string[];
    refusal: boolean;
    recovery?: LocalServiceOutputRecovery;
    prerequisite?: LocalServiceNativePrerequisiteV1;
    establishmentFailure?: LocalServiceEstablishmentFailureV1;
    /** This Start can settle when its real native binding is observed. Other actions cannot. */
    awaitingNativeStart?: boolean;
    /** Repeats a definitively failed action; unknown outcomes must be inspected instead. */
    retry: (() => void) | null;
}>;

// Keep the cause, not a superseded sentence: a retained notice follows the
// controls currently offered without dispatching the action again.
type LocalServiceActionFailureState = Omit<LocalServiceActionFailure, 'body' | 'details' | 'refusal'>
    & Readonly<{ serviceName?: string; serviceTarget?: LocalServiceLaunchTarget }>;

type LocalServiceActionRunInput = Readonly<{
    id: string;
    failureTitle: string;
    serviceName?: string;
    serviceTarget?: LocalServiceLaunchTarget;
    action: () => Promise<unknown>;
    observeNativeStart?: boolean;
}>;

/** Current failed-start facts use the same presenter as an Open action's retained outcome. */
export type LocalServiceStartFailurePresentation = ReturnType<typeof describeLocalServiceActionFailure>
    & Readonly<{ reasonCode: 'plugin_managed_service_establishment_failed' }>;

export function describeLocalServiceStartFailure(target: LocalServiceLaunchTarget): LocalServiceStartFailurePresentation | null {
    const failure = resolveLocalServiceStartFailure(target);
    if (!failure) return null;
    return { reasonCode: failure.reasonCode, ...describeLocalServiceActionFailure({
        reasonCode: failure.reasonCode, serviceName: failure.serviceName, serviceTarget: target,
    }) };
}

export type LocalServiceActionRunner = Readonly<{
    /** The row currently awaiting a dispatch, so exactly one row shows the in-flight treatment. */
    pendingId: string | null;
    /**
     * Dispatch one action and own its whole visible outcome. Resolves `true` when the action
     * succeeded, so a caller can chain its own success affordance (a `CopiedPill`, a reveal).
     */
    run: (input: LocalServiceActionRunInput) => Promise<boolean>;
    /** `inline` runners keep the latest refusal here, until the next run or `dismissFailure`. */
    failure: LocalServiceActionFailure | null;
    dismissFailure: () => void;
}>;

/**
 * In-flight + failure, owned once for a whole surface.
 *
 * `pendingId` is a single id rather than a set: these actions all mutate the same machine and the
 * surface never dispatches two at once, so a set would model a state that cannot happen.
 *
 * A failure opens a dialog, unless the owner has a place to read it in (`presentation: 'inline'`, a
 * row): then the runner keeps it as `failure` and the owner draws it where the action was taken.
 */
export function useLocalServiceActionRunner(options?: Readonly<{
    presentation?: 'dialog' | 'inline';
    observedNativeBinding?: boolean;
    servicesActionOffered?: boolean;
}>): LocalServiceActionRunner {
    const inline = options?.presentation === 'inline';
    const servicesActionOffered = options?.servicesActionOffered === true;
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<LocalServiceActionFailureState | null>(null);
    // Only a real managed binding settles a lost Start acknowledgement; a
    // refreshed scan or another absent projection cannot prove nonacceptance.
    React.useEffect(() => {
        if (options?.observedNativeBinding) setFailure(current => current?.awaitingNativeStart ? null : current);
    }, [options?.observedNativeBinding, failure?.awaitingNativeStart]);
    const mountedRef = React.useRef(true);
    // Re-arm on mount, not only disarm on cleanup. React replays effects in development, so a
    // guard that is only ever set to `false` never recovers — and the row it belongs to would
    // stay showing its spinner forever after an action that actually succeeded.
    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const run = React.useCallback(async (input: LocalServiceActionRunInput): Promise<boolean> => {
        setPendingId(input.id);
        if (inline) setFailure(null);
        let outcome: LocalServiceActionOutcome;
        try {
            outcome = readLocalServiceActionOutcome(await input.action());
        } catch (error) {
            outcome = readFailureOutcome(error);
        } finally {
            if (mountedRef.current) {
                setPendingId((current) => (current === input.id ? null : current));
            }
        }
        if (outcome.kind === 'failed' || outcome.kind === 'outcome_unknown') {
            const unknown = outcome.kind === 'outcome_unknown';
            const cause = {
                reasonCode: outcome.reasonCode,
                serviceName: input.serviceName,
                serviceTarget: input.serviceTarget,
                ...(outcome.kind === 'failed' && outcome.prerequisite ? { prerequisite: outcome.prerequisite } : {}),
                ...(outcome.kind === 'failed' && outcome.establishmentFailure ? { establishmentFailure: outcome.establishmentFailure } : {}),
            };
            const title = unknown ? t('localServices.rowStatus.unknown') : input.failureTitle;
            if (!inline) presentLocalServiceActionFailure({ title, ...cause, servicesActionOffered });
            else if (mountedRef.current) {
                setFailure({ title, ...cause,
                    ...(unknown && input.observeNativeStart ? { awaitingNativeStart: true } : {}),
                    retry: unknown ? null : () => { void run(input); } });
            }
            return false;
        }
        return outcome.kind === 'succeeded';
    }, [inline, servicesActionOffered]);

    const dismissFailure = React.useCallback(() => setFailure(null), []);
    const presentedFailure = React.useMemo(() => {
        if (!failure) return null;
        const presentation = describeLocalServiceActionFailure({ ...failure, servicesActionOffered });
        return { ...failure, ...presentation, title: failure.serviceTarget && failure.reasonCode === 'plugin_managed_service_establishment_failed'
            ? presentation.title : failure.title };
    }, [failure, servicesActionOffered]);
    return { pendingId, run, failure: presentedFailure, dismissFailure };
}
