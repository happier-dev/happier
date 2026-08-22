import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    ComposerAttachmentRuntime,
    PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
    compilePluginJsonSchema,
    ComposerAttachmentDraftV1Schema,
    ComposerAttachmentInputV1Schema,
    ComposerAttachmentMessageAcceptedV1Schema,
    ComposerAttachmentPrepareRequestV1Schema,
    ComposerAttachmentPrepareResultV1Schema,
    ComposerAttachmentResolveRequestV1Schema,
    ComposerAttachmentResolveResultV1Schema,
    isValidPluginJsonSchemaValue,
    readComposerAttachmentRuntimeRegistrationFieldsV1,
    type ComposerAttachmentDraftV1,
    type ComposerAttachmentInputV1,
    type ComposerAttachmentMessageAcceptedV1,
    type ComposerAttachmentPrepareRequestV1,
    type ComposerAttachmentPrepareResultV1,
    type ComposerAttachmentResolveRequestV1,
    type ComposerAttachmentResolveResultV1,
    type PluginJsonSchemaV2,
    type PluginLocalizedStringV2,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import { runWithOptionalTimeout } from '@/plugins/runtime/lifecycle/utils';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

type GenerationLifecycle = Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

export type TargetComposerAttachmentInvocationContextFactory = (
    input: Readonly<{
        attachment: PluginContributionIdentityV1;
        generation: string;
        sessionId: string;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>,
) => Readonly<{
    context: PluginInvocationContext;
    complete(): void;
}>;

export type TargetComposerAttachmentPhase =
    | 'prepareForSend'
    | 'resolveForDispatch'
    | 'afterMessageAccepted';

type TargetComposerAttachmentAdmissionInput =
    | Readonly<{
        phase: 'draft';
        attachments: readonly ComposerAttachmentDraftV1[];
    }>
    | Readonly<{
        phase: 'prepared';
        attachments: readonly ComposerAttachmentInputV1[];
    }>;

const COMPOSER_ATTACHMENT_CALLBACK_TIMEOUT_MS = 5_000;

type ComposerAttachmentRegistration = TargetRegistration & Readonly<{
    registration: Extract<ContributionRuntimeRegistration, { family: 'composerAttachments' }>;
}>;

type ComposerAttachmentDeclaration = Readonly<{
    attachment: PluginContributionIdentityV1;
    title: PluginLocalizedStringV2;
    cardinality: 'one' | 'many';
    valueSchema: PluginJsonSchemaV2;
    preparedValueSchema?: PluginJsonSchemaV2;
    runtime?: unknown;
}>;

type CompiledComposerAttachmentDeclaration = ComposerAttachmentDeclaration & Readonly<{
    typeLabel: string;
    valueValidator: ReturnType<typeof compilePluginJsonSchema>;
    preparedValueValidator: ReturnType<typeof compilePluginJsonSchema>;
}>;

function unavailableError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_unavailable',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' is unavailable`,
    });
}

function callbackUnavailableError(
    attachment: PluginContributionIdentityV1,
    phase: TargetComposerAttachmentPhase,
): PluginError {
    return new PluginError({
        code: 'composer_attachment_callback_unavailable',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' does not provide '${phase}'`,
    });
}

function staleError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'plugin_generation_stale',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' is no longer current`,
    });
}

function notCurrentError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_not_current',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' result is no longer current`,
    });
}

function timeoutError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_timed_out',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' did not answer within its callback budget`,
    });
}

function invalidRequestError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_request_invalid',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' received an invalid request`,
    });
}

function invalidResultError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_result_invalid',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' returned an invalid result`,
    });
}

function invalidValueError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_value_invalid',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' value does not satisfy its declared schema`,
    });
}

function invalidCardinalityError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_cardinality_invalid',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' exceeds its declared cardinality`,
    });
}

function invalidDeclarationError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_declaration_invalid',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' has an invalid declaration`,
    });
}

function resultMismatchError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_result_mismatch',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' did not return one outcome per requested instance`,
    });
}

function duplicateRegistrationError(attachment: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_attachment_registration_duplicate',
        message: `Composer attachment '${attachment.pluginId}/${attachment.localId}' registered more than once`,
    });
}

function isComposerAttachmentRegistration(
    registration: ContributionRuntimeRegistration,
): registration is Extract<ContributionRuntimeRegistration, { family: 'composerAttachments' }> {
    return registration.family === 'composerAttachments';
}

function hasPhase(
    runtime: ComposerAttachmentRuntime,
    phase: TargetComposerAttachmentPhase,
): boolean {
    return typeof runtime[phase] === 'function';
}

function correlateOutcomes<T extends Readonly<{ instanceId: string }>>(input: Readonly<{
    attachment: PluginContributionIdentityV1;
    requested: readonly Readonly<{ instanceId: string }>[];
    outcomes: readonly T[];
}>): readonly T[] {
    if (input.outcomes.length !== input.requested.length) {
        throw resultMismatchError(input.attachment);
    }
    const requestedIds = new Set(input.requested.map((attachment) => attachment.instanceId));
    const outcomesById = new Map<string, T>();
    for (const outcome of input.outcomes) {
        if (!requestedIds.has(outcome.instanceId) || outcomesById.has(outcome.instanceId)) {
            throw resultMismatchError(input.attachment);
        }
        outcomesById.set(outcome.instanceId, outcome);
    }
    const ordered: T[] = [];
    for (const requested of input.requested) {
        const outcome = outcomesById.get(requested.instanceId);
        if (!outcome) throw resultMismatchError(input.attachment);
        ordered.push(outcome);
    }
    return Object.freeze(ordered);
}

/**
 * Family adapter over activation's authoritative registrations. It validates
 * the frozen callback boundary and the declaration-backed semantic admission
 * that runs before persistence. Invocation context is created by the resolved
 * runtime registry so callers supply only the public lifecycle DTO and
 * cancellation signal; persistence and binary custody remain outside this
 * adapter.
 */
export function createTargetComposerAttachmentRegistry(params: Readonly<{
    targetRegistrations: readonly TargetRegistration[];
    /**
     * The activated static contribution catalog is authoritative for whether a
     * lifecycle callback is required. A missing runtime descriptor means the
     * contentless attachment is direct for that phase; it never grants an
     * undeclared callback registration authority.
     */
    declaredAttachments?: readonly ComposerAttachmentDeclaration[];
    resolveGenerationLifecycle(pluginId: string): GenerationLifecycle;
    createInvocationContext: TargetComposerAttachmentInvocationContextFactory;
    /**
     * Composer attachments are demand-ready: a plugin that only contributes
     * them stays dormant through daemon cold start and is activated here, by
     * the exact attachment a composer staged. Activation publishes into the
     * generation-owned `targetRegistrations` array this adapter already reads.
     */
    activateAttachmentOnDemand(attachment: PluginContributionIdentityV1): Promise<void>;
    callbackTimeoutMs?: number;
}>): Readonly<{
    list(): readonly PluginContributionIdentityV1[];
    isDeclared(attachment: PluginContributionIdentityV1): boolean;
    requires(input: Readonly<{
        attachment: PluginContributionIdentityV1;
        phase: TargetComposerAttachmentPhase;
    }>): boolean;
    supports(input: Readonly<{
        attachment: PluginContributionIdentityV1;
        phase: TargetComposerAttachmentPhase;
    }>): Promise<boolean>;
    admit(input: Extract<TargetComposerAttachmentAdmissionInput, { phase: 'draft' }>): readonly ComposerAttachmentDraftV1[];
    admit(input: Extract<TargetComposerAttachmentAdmissionInput, { phase: 'prepared' }>): readonly ComposerAttachmentInputV1[];
    prepareForSend(input: Readonly<{
        attachment: PluginContributionIdentityV1;
        request: ComposerAttachmentPrepareRequestV1;
        signal: AbortSignal;
    }>): Promise<ComposerAttachmentPrepareResultV1>;
    resolveForDispatch(input: Readonly<{
        attachment: PluginContributionIdentityV1;
        request: ComposerAttachmentResolveRequestV1;
        signal: AbortSignal;
    }>): Promise<ComposerAttachmentResolveResultV1>;
    afterMessageAccepted(input: Readonly<{
        attachment: PluginContributionIdentityV1;
        event: ComposerAttachmentMessageAcceptedV1;
        signal: AbortSignal;
    }>): Promise<void>;
}> {
    const callbackTimeoutMs = typeof params.callbackTimeoutMs === 'number'
        && Number.isFinite(params.callbackTimeoutMs)
        && params.callbackTimeoutMs > 0
        ? Math.trunc(params.callbackTimeoutMs)
        : COMPOSER_ATTACHMENT_CALLBACK_TIMEOUT_MS;

    const declarationKey = (attachment: PluginContributionIdentityV1): string => (
        `${attachment.pluginId}\u0000${attachment.localId}`
    );
    const declarationsByKey = new Map<string, CompiledComposerAttachmentDeclaration>();
    for (const candidate of params.declaredAttachments ?? []) {
        const key = declarationKey(candidate.attachment);
        if (declarationsByKey.has(key)) {
            throw duplicateRegistrationError(candidate.attachment);
        }
        try {
            declarationsByKey.set(key, Object.freeze({
                ...candidate,
                typeLabel: typeof candidate.title === 'string'
                    ? candidate.title
                    : candidate.title.fallback,
                valueValidator: compilePluginJsonSchema(candidate.valueSchema),
                preparedValueValidator: compilePluginJsonSchema(
                    candidate.preparedValueSchema ?? candidate.valueSchema,
                ),
            }));
        } catch {
            throw invalidDeclarationError(candidate.attachment);
        }
    }

    const attachmentRegistrationKeys = new Set<string>();
    for (const candidate of params.targetRegistrations) {
        if (!isComposerAttachmentRegistration(candidate.registration)) continue;
        const attachment = Object.freeze({
            pluginId: candidate.pluginId,
            localId: candidate.registration.localId,
        });
        const key = declarationKey(attachment);
        if (attachmentRegistrationKeys.has(key)) {
            throw duplicateRegistrationError(attachment);
        }
        attachmentRegistrationKeys.add(key);
    }

    function find(attachment: PluginContributionIdentityV1): ComposerAttachmentRegistration | null {
        const entry = [...params.targetRegistrations].reverse().find((candidate) => (
            candidate.pluginId === attachment.pluginId
            && isComposerAttachmentRegistration(candidate.registration)
            && candidate.registration.localId === attachment.localId
        ));
        return entry && isComposerAttachmentRegistration(entry.registration)
            ? entry as ComposerAttachmentRegistration
            : null;
    }

    function findDeclaration(
        attachment: PluginContributionIdentityV1,
    ): CompiledComposerAttachmentDeclaration | null {
        return declarationsByKey.get(declarationKey(attachment)) ?? null;
    }

    function isEntryCurrent(entry: ComposerAttachmentRegistration, lifecycle: GenerationLifecycle): boolean {
        return lifecycle.isCurrent() && params.targetRegistrations.includes(entry);
    }

    /**
     * Reaches the attachment's runtime registration, activating its dormant
     * plugin when this generation has not registered it yet. An already
     * current registration is used directly so a staged draft never re-enters
     * the registry-wide demand refresh on the send path.
     */
    async function ensureActivated(attachment: PluginContributionIdentityV1): Promise<void> {
        const entry = find(attachment);
        if (entry && isEntryCurrent(entry, params.resolveGenerationLifecycle(attachment.pluginId))) return;
        await params.activateAttachmentOnDemand(attachment);
    }

    async function invoke<TResult>(paramsForCall: Readonly<{
        attachment: PluginContributionIdentityV1;
        phase: TargetComposerAttachmentPhase;
        sessionId: string;
        signal: AbortSignal;
        operation(runtime: ComposerAttachmentRuntime, context: PluginInvocationContext): Promise<TResult>;
    }>): Promise<TResult> {
        await ensureActivated(paramsForCall.attachment);
        const entry = find(paramsForCall.attachment);
        if (!entry) throw unavailableError(paramsForCall.attachment);
        const lifecycle = params.resolveGenerationLifecycle(paramsForCall.attachment.pluginId);
        if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.attachment);
        if (!hasPhase(entry.registration.value, paramsForCall.phase)) {
            throw callbackUnavailableError(paramsForCall.attachment, paramsForCall.phase);
        }

        const timeout = new AbortController();
        const signal = AbortSignal.any([
            paramsForCall.signal,
            lifecycle.retirementSignal,
            timeout.signal,
        ]);
        const abortError = (): PluginError => {
            if (timeout.signal.aborted) return timeoutError(paramsForCall.attachment);
            if (lifecycle.retirementSignal.aborted || !isEntryCurrent(entry, lifecycle)) {
                return staleError(paramsForCall.attachment);
            }
            return notCurrentError(paramsForCall.attachment);
        };
        let invocation: ReturnType<TargetComposerAttachmentInvocationContextFactory> | null = null;
        let removeAbortListener = () => {};
        try {
            if (signal.aborted) throw abortError();
            const createdInvocation = params.createInvocationContext({
                attachment: paramsForCall.attachment,
                generation: entry.generation,
                sessionId: paramsForCall.sessionId,
                signal,
                isCurrent: () => !signal.aborted && isEntryCurrent(entry, lifecycle),
            });
            invocation = createdInvocation;
            if (signal.aborted) throw abortError();
            if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.attachment);
            const aborted = new Promise<never>((_resolve, reject) => {
                const rejectAbort = () => reject(abortError());
                if (signal.aborted) {
                    rejectAbort();
                    return;
                }
                signal.addEventListener('abort', rejectAbort, { once: true });
                removeAbortListener = () => signal.removeEventListener('abort', rejectAbort);
            });
            const result = await runWithOptionalTimeout(
                callbackTimeoutMs,
                async () => await Promise.race([
                    paramsForCall.operation(entry.registration.value, createdInvocation.context),
                    aborted,
                ]),
                () => {
                    const error = timeoutError(paramsForCall.attachment);
                    timeout.abort(error);
                    return error;
                },
            );
            if (signal.aborted) throw abortError();
            if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.attachment);
            return result;
        } catch (error) {
            if (signal.aborted) throw abortError();
            if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.attachment);
            if (paramsForCall.phase === 'afterMessageAccepted') {
                try {
                    invocation?.context.services.logger.diagnostic({
                        code: 'plugin_composer_attachment_after_message_accepted_failed',
                        severity: 'error',
                        message: 'Composer attachment post-acceptance callback failed',
                    });
                } catch {
                    // Diagnostic delivery is observational and cannot replace the callback failure.
                }
            }
            throw error;
        } finally {
            removeAbortListener();
            invocation?.complete();
        }
    }

    function admitAttachments<TAttachment extends ComposerAttachmentDraftV1 | ComposerAttachmentInputV1>(
        input: Readonly<{
            phase: 'draft' | 'prepared';
            attachments: readonly TAttachment[];
        }>,
        parse: (value: unknown) => TAttachment | null,
    ): readonly TAttachment[] {
        const admitted: TAttachment[] = [];
        const cardinalityOneAttachmentKeys = new Set<string>();
        for (const attachment of input.attachments) {
            const declaration = findDeclaration(attachment.attachment);
            if (!declaration) throw unavailableError(attachment.attachment);
            const lifecycle = params.resolveGenerationLifecycle(attachment.attachment.pluginId);
            if (!lifecycle.isCurrent() || lifecycle.retirementSignal.aborted) {
                throw staleError(attachment.attachment);
            }
            const attachmentKey = declarationKey(attachment.attachment);
            if (declaration.cardinality === 'one') {
                if (cardinalityOneAttachmentKeys.has(attachmentKey)) {
                    throw invalidCardinalityError(attachment.attachment);
                }
                cardinalityOneAttachmentKeys.add(attachmentKey);
            }
            const validator = input.phase === 'draft'
                ? declaration.valueValidator
                : declaration.preparedValueValidator;
            if (!isValidPluginJsonSchemaValue(validator, attachment.value)) {
                throw invalidValueError(attachment.attachment);
            }
            const normalized = parse({
                ...attachment,
                presentation: {
                    ...attachment.presentation,
                    typeLabel: declaration.typeLabel,
                },
            });
            if (!normalized) {
                throw invalidDeclarationError(attachment.attachment);
            }
            admitted.push(normalized);
        }
        return Object.freeze(admitted);
    }

    function admit(input: Extract<TargetComposerAttachmentAdmissionInput, { phase: 'draft' }>): readonly ComposerAttachmentDraftV1[];
    function admit(input: Extract<TargetComposerAttachmentAdmissionInput, { phase: 'prepared' }>): readonly ComposerAttachmentInputV1[];
    function admit(input: TargetComposerAttachmentAdmissionInput): readonly ComposerAttachmentDraftV1[] | readonly ComposerAttachmentInputV1[] {
        if (input.phase === 'draft') {
            return admitAttachments(input, (value) => {
                const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
                return parsed.success ? parsed.data : null;
            });
        }
        return admitAttachments(input, (value) => {
            const parsed = ComposerAttachmentInputV1Schema.safeParse(value);
            return parsed.success ? parsed.data : null;
        });
    }

    return Object.freeze({
        /**
         * Currently ACTIVATED attachment registrations only. Because attachments
         * are demand-ready, a declared attachment whose plugin is still dormant
         * is absent here, so this is not a declaration-discovery oracle: use
         * `isDeclared`/`requires` (declaration-backed) or the static contribution
         * projection for that. Treating an absence here as "the plugin does not
         * contribute this attachment" turns cold start into a false negative.
         */
        list() {
            const identities: PluginContributionIdentityV1[] = [];
            const seen = new Set<string>();
            for (const candidate of params.targetRegistrations) {
                if (
                    !isComposerAttachmentRegistration(candidate.registration)
                ) continue;
                const identity = { pluginId: candidate.pluginId, localId: candidate.registration.localId };
                const key = `${identity.pluginId}\u0000${identity.localId}`;
                if (seen.has(key)) continue;
                const lifecycle = params.resolveGenerationLifecycle(identity.pluginId);
                if (!isEntryCurrent(candidate as ComposerAttachmentRegistration, lifecycle)) continue;
                seen.add(key);
                identities.push(Object.freeze(identity));
            }
            return Object.freeze(identities);
        },
        isDeclared(attachment) {
            return findDeclaration(attachment) !== null;
        },
        requires(input) {
            const declaration = findDeclaration(input.attachment);
            return declaration !== null
                && readComposerAttachmentRuntimeRegistrationFieldsV1(
                    declaration.runtime,
                ).includes(input.phase);
        },
        async supports(input) {
            await ensureActivated(input.attachment);
            const entry = find(input.attachment);
            if (!entry) return false;
            const lifecycle = params.resolveGenerationLifecycle(input.attachment.pluginId);
            return isEntryCurrent(entry, lifecycle) && hasPhase(entry.registration.value, input.phase);
        },
        admit,
        async prepareForSend(input) {
            const request = ComposerAttachmentPrepareRequestV1Schema.safeParse(input.request);
            if (!request.success) throw invalidRequestError(input.attachment);
            const result = await invoke({
                attachment: input.attachment,
                phase: 'prepareForSend',
                sessionId: request.data.sessionId,
                signal: input.signal,
                operation: async (runtime, context) => {
                    const callback = runtime.prepareForSend;
                    if (!callback) {
                        throw callbackUnavailableError(input.attachment, 'prepareForSend');
                    }
                    return await callback(request.data, context);
                },
            });
            const parsed = ComposerAttachmentPrepareResultV1Schema.safeParse(result);
            if (!parsed.success) throw invalidResultError(input.attachment);
            return Object.freeze({
                ...parsed.data,
                attachments: correlateOutcomes({
                    attachment: input.attachment,
                    requested: request.data.attachments,
                    outcomes: parsed.data.attachments,
                }),
            });
        },
        async resolveForDispatch(input) {
            const request = ComposerAttachmentResolveRequestV1Schema.safeParse(input.request);
            if (!request.success) throw invalidRequestError(input.attachment);
            const result = await invoke({
                attachment: input.attachment,
                phase: 'resolveForDispatch',
                sessionId: request.data.sessionId,
                signal: input.signal,
                operation: async (runtime, context) => {
                    const callback = runtime.resolveForDispatch;
                    if (!callback) {
                        throw callbackUnavailableError(input.attachment, 'resolveForDispatch');
                    }
                    return await callback(request.data, context);
                },
            });
            const parsed = ComposerAttachmentResolveResultV1Schema.safeParse(result);
            if (!parsed.success) throw invalidResultError(input.attachment);
            return Object.freeze({
                ...parsed.data,
                attachments: correlateOutcomes({
                    attachment: input.attachment,
                    requested: request.data.attachments,
                    outcomes: parsed.data.attachments,
                }),
            });
        },
        async afterMessageAccepted(input) {
            const event = ComposerAttachmentMessageAcceptedV1Schema.safeParse(input.event);
            if (!event.success) throw invalidRequestError(input.attachment);
            const result = await invoke<unknown>({
                attachment: input.attachment,
                phase: 'afterMessageAccepted',
                sessionId: event.data.sessionId,
                signal: input.signal,
                operation: async (runtime, context) => {
                    const callback = runtime.afterMessageAccepted;
                    if (!callback) {
                        throw callbackUnavailableError(input.attachment, 'afterMessageAccepted');
                    }
                    return await callback(event.data, context);
                },
            });
            if (result !== undefined) throw invalidResultError(input.attachment);
        },
    });
}
