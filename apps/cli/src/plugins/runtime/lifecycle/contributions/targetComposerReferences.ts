import { PluginError } from '@happier-dev/plugin-sdk';
import type { ComposerReferenceRuntime, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { ComposerReferenceCandidatePageV1Schema, ComposerReferenceResolutionV1Schema, normalizeComposerReferenceQueryV1 } from '@happier-dev/protocol/plugins/contributions/composer-reference-providers';
import type { ComposerReferenceCandidatePageV1, ComposerReferenceResolutionV1, ComposerReferenceTriggerV1, PluginContributionIdentityV1 } from '@happier-dev/protocol';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { ResolvedComposerReferenceContribution } from '@/plugins/projection/registry/types';

type TargetRegistration = Readonly<{
    pluginId: string;
    occurrenceId: string;
    registration: ContributionRuntimeRegistration;
}>;

type OccurrenceLifecycle = Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

export type TargetComposerReferenceInvocationContextFactory = (
    input: Readonly<{
        reference: PluginContributionIdentityV1;
        occurrenceId: string;
        sessionId?: string;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>,
) => Readonly<{
    context: PluginInvocationContext;
    complete(): void;
}>;

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
    resolveOccurrenceLifecycle(pluginId: string): OccurrenceLifecycle;
    createInvocationContext: TargetComposerReferenceInvocationContextFactory;
}>): Readonly<{
    list(): readonly PluginContributionIdentityV1[];
    search(input: Readonly<{
        reference: PluginContributionIdentityV1;
        query: string;
        trigger: ComposerReferenceTriggerV1;
        signal: AbortSignal;
        sessionId?: string;
    }>): Promise<ComposerReferenceCandidatePageV1>;
    resolve(input: Readonly<{
        reference: PluginContributionIdentityV1;
        candidateId: string;
        signal: AbortSignal;
        sessionId?: string;
    }>): Promise<ComposerReferenceResolutionV1>;
}> {
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

    function isEntryCurrent(entry: ComposerReferenceRegistration, lifecycle: OccurrenceLifecycle): boolean {
        return lifecycle.isCurrent() && params.targetRegistrations.includes(entry);
    }

    async function invoke<TResult>(paramsForCall: Readonly<{
        reference: PluginContributionIdentityV1;
        signal: AbortSignal;
        sessionId?: string;
        operation(runtime: ComposerReferenceRuntime, context: PluginInvocationContext): Promise<TResult>;
    }>): Promise<TResult> {
        const entry = find(paramsForCall.reference);
        if (!entry) throw unavailableError(paramsForCall.reference);
        const lifecycle = params.resolveOccurrenceLifecycle(paramsForCall.reference.pluginId);
        if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.reference);

        const signal = AbortSignal.any([
            paramsForCall.signal,
            lifecycle.retirementSignal,
        ]);
        const abortError = (): PluginError => {
            if (lifecycle.retirementSignal.aborted || !isEntryCurrent(entry, lifecycle)) {
                return staleError(paramsForCall.reference);
            }
            return notCurrentError(paramsForCall.reference);
        };
        let removeAbortListener = () => {};
        let invocation: ReturnType<TargetComposerReferenceInvocationContextFactory> | null = null;
        try {
            if (signal.aborted) throw abortError();
            const aborted = new Promise<never>((_resolve, reject) => {
                const rejectAbort = () => reject(abortError());
                if (signal.aborted) {
                    rejectAbort();
                    return;
                }
                signal.addEventListener('abort', rejectAbort, { once: true });
                removeAbortListener = () => signal.removeEventListener('abort', rejectAbort);
            });
            const createdInvocation = params.createInvocationContext({
                reference: paramsForCall.reference,
                occurrenceId: entry.occurrenceId,
                ...(paramsForCall.sessionId ? { sessionId: paramsForCall.sessionId } : {}),
                signal,
                isCurrent: () => !signal.aborted && isEntryCurrent(entry, lifecycle),
            });
            invocation = createdInvocation;
            const result = await Promise.race([
                paramsForCall.operation(entry.registration.value, createdInvocation.context),
                aborted,
            ]);
            if (signal.aborted) throw abortError();
            if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.reference);
            return result;
        } catch (error) {
            if (signal.aborted) throw abortError();
            if (!isEntryCurrent(entry, lifecycle)) throw staleError(paramsForCall.reference);
            throw error;
        } finally {
            removeAbortListener();
            invocation?.complete();
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
                const lifecycle = params.resolveOccurrenceLifecycle(identity.pluginId);
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
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                operation: async (runtime, context) => await runtime.search(query, context),
            });
            const parsed = ComposerReferenceCandidatePageV1Schema.safeParse(result);
            if (!parsed.success) throw invalidResultError(input.reference);
            return parsed.data;
        },
        async resolve(input) {
            const result = await invoke({
                reference: input.reference,
                signal: input.signal,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                operation: async (runtime, context) => await runtime.resolve(input.candidateId, context),
            });
            const parsed = ComposerReferenceResolutionV1Schema.safeParse(result);
            if (!parsed.success) throw invalidResultError(input.reference);
            if (parsed.data.id !== input.candidateId) throw candidateMismatchError(input.reference);
            return parsed.data;
        },
    });
}
