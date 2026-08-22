import { PluginError } from '@happier-dev/plugin-sdk';
import type { ComposerReferenceRuntime } from '@happier-dev/plugin-sdk';
import {
    ComposerReferenceCandidatePageV1Schema,
    ComposerReferenceResolutionV1Schema,
    normalizeComposerReferenceQueryV1,
    type ComposerReferenceCandidatePageV1,
    type ComposerReferenceResolutionV1,
    type ComposerReferenceTriggerV1,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { ResolvedComposerReferenceContribution } from '@/plugins/projection/registry/types';
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

/**
 * Matches the existing bounded dynamic-resource callback budget. A reference
 * runtime is trusted but must never hold a Composer query or prompt dispatch
 * indefinitely.
 */
const COMPOSER_REFERENCE_CALLBACK_TIMEOUT_MS = 5_000;

type ComposerReferenceRegistration = TargetRegistration & Readonly<{
    registration: Extract<ContributionRuntimeRegistration, { family: 'composerReferences' }>;
}>;

function unavailableError(reference: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_reference_unavailable',
        message: `Composer reference '${reference.pluginId}/${reference.localId}' is unavailable`,
    });
}

function staleError(reference: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'plugin_generation_stale',
        message: `Composer reference '${reference.pluginId}/${reference.localId}' is no longer current`,
    });
}

function notCurrentError(reference: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_reference_not_current',
        message: `Composer reference '${reference.pluginId}/${reference.localId}' result is no longer current`,
    });
}

function timeoutError(reference: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_reference_timed_out',
        message: `Composer reference '${reference.pluginId}/${reference.localId}' did not answer within its callback budget`,
    });
}

function invalidResultError(reference: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_reference_result_invalid',
        message: `Composer reference '${reference.pluginId}/${reference.localId}' returned an invalid result`,
    });
}

function candidateMismatchError(reference: PluginContributionIdentityV1): PluginError {
    return new PluginError({
        code: 'composer_reference_candidate_mismatch',
        message: `Composer reference '${reference.pluginId}/${reference.localId}' resolved a different candidate`,
    });
}

function isComposerReferenceRegistration(
    registration: ContributionRuntimeRegistration,
): registration is Extract<ContributionRuntimeRegistration, { family: 'composerReferences' }> {
    return registration.family === 'composerReferences';
}

/**
 * Family adapter over activation's authoritative registrations. Manifest rights
 * are enforced before a registration enters this list, so this adapter adds no
 * second declaration registry; it binds only the exact qualified identity that
 * activation admitted. A retained registration's generation is contributor
 * provenance, not the public projection revision; lifecycle plus exact entry
 * membership are the currentness authority below.
 */
export function createTargetComposerReferenceRegistry(params: Readonly<{
    composerReferences: readonly ResolvedComposerReferenceContribution[];
    targetRegistrations: readonly TargetRegistration[];
    resolveGenerationLifecycle(pluginId: string): GenerationLifecycle;
    callbackTimeoutMs?: number;
}>): Readonly<{
    list(): readonly PluginContributionIdentityV1[];
    search(input: Readonly<{
        reference: PluginContributionIdentityV1;
        query: string;
        trigger: ComposerReferenceTriggerV1;
        signal: AbortSignal;
    }>): Promise<ComposerReferenceCandidatePageV1>;
    resolve(input: Readonly<{
        reference: PluginContributionIdentityV1;
        candidateId: string;
        signal: AbortSignal;
    }>): Promise<ComposerReferenceResolutionV1>;
}> {
    const callbackTimeoutMs = typeof params.callbackTimeoutMs === 'number'
        && Number.isFinite(params.callbackTimeoutMs)
        && params.callbackTimeoutMs > 0
        ? Math.trunc(params.callbackTimeoutMs)
        : COMPOSER_REFERENCE_CALLBACK_TIMEOUT_MS;

    const declarations = new Map(params.composerReferences.flatMap((declaration) => (
        declaration.pluginId === declaration.identity.pluginId
        && declaration.identity.localId === declaration.definition.id
            ? [[`${declaration.pluginId}/${declaration.identity.localId}`, declaration] as const]
            : []
    )));

    function findDeclaration(
        reference: PluginContributionIdentityV1,
    ): ResolvedComposerReferenceContribution | null {
        return declarations.get(`${reference.pluginId}/${reference.localId}`) ?? null;
    }

    function find(reference: PluginContributionIdentityV1): ComposerReferenceRegistration | null {
        if (!findDeclaration(reference)) return null;
        const entry = [...params.targetRegistrations].reverse().find((candidate) => (
            candidate.pluginId === reference.pluginId
            && isComposerReferenceRegistration(candidate.registration)
            && candidate.registration.localId === reference.localId
        ));
        return entry && isComposerReferenceRegistration(entry.registration)
            ? entry as ComposerReferenceRegistration
            : null;
    }

    function isEntryCurrent(entry: ComposerReferenceRegistration, lifecycle: GenerationLifecycle): boolean {
        return lifecycle.isCurrent() && params.targetRegistrations.includes(entry);
    }

    async function invoke<TResult>(paramsForCall: Readonly<{
        reference: PluginContributionIdentityV1;
        signal: AbortSignal;
        operation(runtime: ComposerReferenceRuntime, signal: AbortSignal): Promise<TResult>;
    }>): Promise<TResult> {
        const entry = find(paramsForCall.reference);
        if (!entry) throw unavailableError(paramsForCall.reference);
        const lifecycle = params.resolveGenerationLifecycle(paramsForCall.reference.pluginId);
        if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.reference);

        const timeout = new AbortController();
        const signal = AbortSignal.any([
            paramsForCall.signal,
            lifecycle.retirementSignal,
            timeout.signal,
        ]);
        const abortError = (): PluginError => {
            if (timeout.signal.aborted) return timeoutError(paramsForCall.reference);
            if (lifecycle.retirementSignal.aborted || !isEntryCurrent(entry, lifecycle)) {
                return staleError(paramsForCall.reference);
            }
            return notCurrentError(paramsForCall.reference);
        };
        let removeAbortListener = () => {};
        try {
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
                    paramsForCall.operation(entry.registration.value, signal),
                    aborted,
                ]),
                () => {
                    const error = timeoutError(paramsForCall.reference);
                    timeout.abort(error);
                    return error;
                },
            );
            if (signal.aborted) throw abortError();
            if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.reference);
            return result;
        } catch (error) {
            if (signal.aborted) throw abortError();
            if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.reference);
            throw error;
        } finally {
            removeAbortListener();
        }
    }

    return Object.freeze({
        list() {
            const identities: PluginContributionIdentityV1[] = [];
            const seen = new Set<string>();
            for (const candidate of params.targetRegistrations) {
                if (
                    !isComposerReferenceRegistration(candidate.registration)
                ) continue;
                const identity = { pluginId: candidate.pluginId, localId: candidate.registration.localId };
                if (!findDeclaration(identity)) continue;
                const key = `${identity.pluginId}\u0000${identity.localId}`;
                if (seen.has(key)) continue;
                const lifecycle = params.resolveGenerationLifecycle(identity.pluginId);
                if (!isEntryCurrent(candidate as ComposerReferenceRegistration, lifecycle)) continue;
                seen.add(key);
                identities.push(Object.freeze(identity));
            }
            return Object.freeze(identities);
        },
        async search(input) {
            const query = normalizeComposerReferenceQueryV1(input.query);
            const declaration = findDeclaration(input.reference);
            if (!declaration || !declaration.definition.triggers.includes(input.trigger)) {
                throw unavailableError(input.reference);
            }
            const result = await invoke({
                reference: input.reference,
                signal: input.signal,
                operation: async (runtime, signal) => await runtime.search(query, signal),
            });
            const parsed = ComposerReferenceCandidatePageV1Schema.safeParse(result);
            if (!parsed.success) throw invalidResultError(input.reference);
            return parsed.data;
        },
        async resolve(input) {
            const result = await invoke({
                reference: input.reference,
                signal: input.signal,
                operation: async (runtime, signal) => await runtime.resolve(input.candidateId, signal),
            });
            const parsed = ComposerReferenceResolutionV1Schema.safeParse(result);
            if (!parsed.success) throw invalidResultError(input.reference);
            if (parsed.data.id !== input.candidateId) throw candidateMismatchError(input.reference);
            return parsed.data;
        },
    });
}
