import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import type {
    TriageActionProfilePreferencesV1,
    TriageProfileCheckoutPreferenceV1,
    TriageProfilePlacementPreferenceV1,
} from './actionLaunch.js';

/**
 * The two references a configured Triage action carries, resolved through the
 * host Actions that own them.
 *
 * `profileId` names a `LaunchProfileV2` and `promptInvocationId` names a
 * `PromptInvocationEntryV1`. Both belong to Account-owned catalogs Triage does
 * not hold, and both are resolved AT PRESS TIME rather than copied into the
 * Triage record: editing the prompt in the Library, or the placement preference
 * on the profile, changes what every action referencing it does, with no
 * migration and no stale snapshot.
 *
 * Neither read is authoritative about anything. The profile read returns
 * PREFERENCES that `actionLaunch.ts` weighs against the action's own
 * requirement, and the prompt read returns the exact text the same slash
 * command would produce in a composer, rendered by the Library's own expansion
 * owner rather than by a second renderer here.
 */

/** The two host Actions this module invokes, and nothing else. */
export const TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1 = 'sessions.spawn.profiles.list';
export const TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1 = 'prompts.invocation.resolve';
export const TRIAGE_PROMPT_INVOCATIONS_LIST_ACTION_ID_V1 = 'prompts.invocations.list';

export type TriageActionResolutionHostV1 = Readonly<{
    executeAction(
        action: string,
        input: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<unknown>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

function readPlacementPreference(value: unknown): TriageProfilePlacementPreferenceV1 | undefined {
    if (value === 'automatic' || value === 'ask') return value;
    if (!isRecord(value)) return undefined;
    const fixed = value.fixed;
    if (!isRecord(fixed)) return undefined;
    const serverId = readNonEmptyString(fixed.serverId);
    const machineId = readNonEmptyString(fixed.machineId);
    // A pinned placement names a machine. Half of one is not a weaker pin, it
    // is a target nothing can run on, and admitting it would send a press to a
    // server with no machine.
    if (serverId === null || machineId === null) return undefined;
    const directory = readNonEmptyString(value.directory);
    return {
        fixed: { serverId, machineId },
        ...(directory === null ? {} : { directory }),
    };
}

function readCheckoutPreference(value: unknown): TriageProfileCheckoutPreferenceV1 | undefined {
    return value === 'reuse_workspace' || value === 'create_worktree' || value === 'ask'
        ? value
        : undefined;
}

export type TriageActionProfileReadV1 =
    | Readonly<{
        status: 'read';
        profileId: string;
        preferences: TriageActionProfilePreferencesV1;
        /** The profile's preferred agent in the host's own local-id vocabulary. */
        preferredAgentTargetKey?: string;
    }>
    /** The catalog answered and holds no profile with that id. */
    | Readonly<{ status: 'unknownProfile'; profileId: string }>
    /** The answer was partial, so this id may be outside its visible rows. */
    | Readonly<{
        status: 'notVisible';
        profileId: string;
        reason: 'truncated' | 'unreadable';
    }>
    /** Nothing answered. Deliberately distinct from "the profile is gone". */
    | Readonly<{ status: 'unavailable'; profileId: string }>;

/**
 * One Launch Profile as the editor offers it.
 *
 * The record stores the profile's STABLE id, and nobody can type one. Offering
 * the list is therefore not a convenience: a text field for the id makes a
 * correct reference unwritable, and the member stays configured-looking and
 * inert — the exact defect this vertical exists to remove.
 */
export type TriageLaunchProfileOptionV1 = Readonly<{ id: string; name: string }>;

export type TriageLaunchProfilesReadV1 =
    | Readonly<{
        status: 'read';
        profiles: readonly TriageLaunchProfileOptionV1[];
        /**
         * Whether the catalog answered completely, was bounded, or retained
         * rows this host cannot read.
         *
         * A reader may only conclude "your account does not hold this profile"
         * from `complete`. The other two arms name why absence is inconclusive.
         */
        coverage: 'complete' | 'truncated' | 'unreadable';
    }>
    | Readonly<{ status: 'unavailable' }>;

/**
 * The one call to the profiles catalog.
 *
 * The press path and the editor ask the same host Action the same way; the
 * press then picks its one profile out of the answer. A second reader here
 * would be a second opinion about what the catalog said.
 *
 * It scopes by no agent, and that is the point: a Triage action picks a profile
 * FIRST and the profile then supplies the agent, so there is no agent to name
 * here. It asks for no bound either — a bound is what makes an absent row
 * ambiguous, and Triage has to tell "deleted" from "not sent".
 */
async function readTriageLaunchProfileItemsV1(
    host: TriageActionResolutionHostV1,
    options?: PluginCancellationOptions,
): Promise<Readonly<{
    items: readonly unknown[];
    coverage: 'complete' | 'truncated' | 'unreadable';
}> | null> {
    let result: unknown;
    try {
        result = await host.executeAction(TRIAGE_SPAWN_PROFILES_LIST_ACTION_ID_V1, {}, options);
    } catch {
        return null;
    }
    if (!isRecord(result) || !Array.isArray(result.items) || result.coverage === 'unavailable') {
        return null;
    }
    const coverage = result.coverage === 'truncated' || result.coverage === 'unreadable'
        ? result.coverage
        : result.truncated === true
            ? 'truncated'
            : 'complete';
    return { items: result.items, coverage };
}

export async function readTriageLaunchProfilesV1(
    host: TriageActionResolutionHostV1,
    options?: PluginCancellationOptions,
): Promise<TriageLaunchProfilesReadV1> {
    const answer = await readTriageLaunchProfileItemsV1(host, options);
    if (answer === null) return { status: 'unavailable' };
    const profiles: TriageLaunchProfileOptionV1[] = [];
    for (const item of answer.items) {
        if (!isRecord(item)) continue;
        const id = readNonEmptyString(item.id);
        if (id === null) continue;
        // A profile with no readable name is still a real profile a person may
        // have configured an action against; showing its id beats hiding it.
        profiles.push({ id, name: readNonEmptyString(item.name) ?? id });
    }
    return { status: 'read', profiles, coverage: answer.coverage };
}

export async function readTriageActionProfileV1(
    host: TriageActionResolutionHostV1,
    profileId: string,
    options?: PluginCancellationOptions,
): Promise<TriageActionProfileReadV1> {
    const answer = await readTriageLaunchProfileItemsV1(host, options);
    if (answer === null) return { status: 'unavailable', profileId };

    const match = answer.items.find(
        (item) => isRecord(item) && readNonEmptyString(item.id) === profileId,
    );
    // Absence from a bounded or unreadable answer is not absence from the
    // account. Keep the reason typed so the editor can distinguish "not sent"
    // from "written by a newer schema" and neither becomes deletion.
    if (!isRecord(match)) {
        return answer.coverage === 'complete'
            ? { status: 'unknownProfile', profileId }
            : { status: 'notVisible', profileId, reason: answer.coverage };
    }

    const placement = readPlacementPreference(match.placement);
    const checkout = readCheckoutPreference(match.checkout);
    const preferredAgentTargetKey = readNonEmptyString(match.preferredAgentTargetKey);
    return {
        status: 'read',
        profileId,
        preferences: {
            ...(placement === undefined ? {} : { placement }),
            ...(checkout === undefined ? {} : { checkout }),
        },
        ...(preferredAgentTargetKey === null ? {} : { preferredAgentTargetKey }),
    };
}

export type TriageActionPromptReadV1 =
    | Readonly<{ status: 'resolved'; invocationId: string; text: string }>
    /**
     * The Library holds no invocation with that id. It is a different answer
     * from `unavailable` because it needs a different thing from the reader:
     * the reference has to be repointed, not retried.
     */
    | Readonly<{ status: 'unknownInvocation'; invocationId: string }>
    /** The invocation resolved, but not to a prompt that can be delivered. */
    | Readonly<{ status: 'invalidInvocation'; invocationId: string }>
    | Readonly<{ status: 'unavailable'; invocationId: string }>;

export async function readTriageActionPromptV1(
    host: TriageActionResolutionHostV1,
    invocationId: string,
    options?: PluginCancellationOptions,
): Promise<TriageActionPromptReadV1> {
    let result: unknown;
    try {
        result = await host.executeAction(
            TRIAGE_PROMPT_INVOCATION_RESOLVE_ACTION_ID_V1,
            { invocationId },
            options,
        );
    } catch {
        return { status: 'unavailable', invocationId };
    }
    if (!isRecord(result)) return { status: 'unavailable', invocationId };
    if (result.status === 'unknownInvocation') return { status: 'unknownInvocation', invocationId };
    const text = typeof result.text === 'string' ? result.text : '';
    // The Library owns the words. Triage neither trims them to a bound of its
    // own nor rewrites them; the only thing it refuses is an empty resolution,
    // which is not a prompt.
    if (result.status === 'resolved' && text.trim().length === 0) {
        return { status: 'invalidInvocation', invocationId };
    }
    if (result.status !== 'resolved') {
        return { status: 'unavailable', invocationId };
    }
    return { status: 'resolved', invocationId, text };
}

/**
 * One Prompt Library invocation as the editor offers it.
 *
 * The reader picks by the words they know — the slash token and the title — and
 * the STABLE id is what gets stored. Offering a text field for the id instead
 * would have made a correct reference untypeable and the member unusable, which
 * is how a stored member stays inert while looking configured.
 */
export type TriagePromptInvocationOptionV1 = Readonly<{
    id: string;
    token: string;
    title: string;
}>;

export type TriagePromptInvocationsReadV1 =
    | Readonly<{
        status: 'read';
        invocations: readonly TriagePromptInvocationOptionV1[];
        coverage: 'complete' | 'truncated';
    }>
    | Readonly<{ status: 'unavailable' }>;

export async function readTriagePromptInvocationsV1(
    host: TriageActionResolutionHostV1,
    options?: PluginCancellationOptions,
): Promise<TriagePromptInvocationsReadV1> {
    let result: unknown;
    try {
        result = await host.executeAction(TRIAGE_PROMPT_INVOCATIONS_LIST_ACTION_ID_V1, {}, options);
    } catch {
        return { status: 'unavailable' };
    }
    if (!isRecord(result) || !Array.isArray(result.items) || result.coverage === 'unavailable') {
        return { status: 'unavailable' };
    }
    const invocations: TriagePromptInvocationOptionV1[] = [];
    for (const item of result.items) {
        if (!isRecord(item)) continue;
        const id = readNonEmptyString(item.id);
        const token = readNonEmptyString(item.token);
        if (id === null || token === null) continue;
        // A missing title is not a missing invocation: the token is what a
        // person types and it is enough to recognise one by.
        invocations.push({ id, token, title: readNonEmptyString(item.title) ?? token });
    }
    return {
        status: 'read',
        invocations,
        coverage: result.coverage === 'complete' ? 'complete' : 'truncated',
    };
}

/**
 * Both of a pressed action's references, resolved BEFORE anything happens.
 *
 * This exists because resolving them one at a time, interleaved with the start,
 * made a broken reference fail in the one place it must not: after the side
 * effects. A missing profile was read as "no preference" and the Session was
 * created with the account defaults the person had explicitly configured away
 * from; a missing prompt was only noticed once the Session existed, was linked
 * and was open, at which point the honest options are to leave it empty or to
 * substitute something Triage invented. Neither is acceptable — a configured
 * reference that cannot be honoured is not the same as no preference, and a
 * generic prompt silently standing in for a broken configured one is the
 * silent-failure class this program keeps producing.
 *
 * So the resolution is one step with one verdict, and the caller may not create
 * anything until it says `resolved`:
 *
 *  - `null` on either member is not a failure. It is the approved default: the
 *    generic new-Session flow chooses the profile, and no prompt is delivered.
 *  - A configured id the owning catalog does not hold is `referenceMissing`.
 *    The reference has to be repointed; retrying cannot help.
 *  - A configured id whose owner did not answer is `referenceUnavailable`.
 *    Retrying is exactly what can help, which is why it is a different verdict.
 *
 * It decides nothing else. Placement still belongs to `actionLaunch.ts`, and
 * the resolved values are handed back for it to weigh.
 */
export type TriageActionReferenceKindV1 = 'profile' | 'prompt';

export type TriageActionReferencesV1 =
    | Readonly<{
        status: 'resolved';
        /** Absent when the action names no profile: the generic flow chooses. */
        profile?: Extract<TriageActionProfileReadV1, Readonly<{ status: 'read' }>>;
        /** Absent when the action names no prompt: nothing is delivered. */
        prompt?: Extract<TriageActionPromptReadV1, Readonly<{ status: 'resolved' }>>;
    }>
    /** The catalog answered and does not hold this reference. Repoint it. */
    | Readonly<{ status: 'referenceMissing'; reference: TriageActionReferenceKindV1; id: string }>
    /** A profile may exist outside the rows this host could project. */
    | Readonly<{
        status: 'referenceNotVisible';
        reference: 'profile';
        id: string;
        reason: 'truncated' | 'unreadable';
    }>
    /** The owner answered for the reference, but its value cannot be used. */
    | Readonly<{ status: 'referenceInvalid'; reference: 'prompt'; id: string }>
    /** The catalog did not answer. The reference may well still be good. */
    | Readonly<{
        status: 'referenceUnavailable';
        reference: TriageActionReferenceKindV1;
        id: string;
    }>;

export async function resolveTriageActionReferencesV1(
    host: TriageActionResolutionHostV1,
    action: Readonly<{
        profileId: string | null;
        target: Readonly<{ promptInvocationId: string | null }>;
    }>,
    options?: PluginCancellationOptions,
): Promise<TriageActionReferencesV1> {
    const profile = action.profileId === null
        ? null
        : await readTriageActionProfileV1(host, action.profileId, options);
    if (profile !== null && profile.status !== 'read') {
        if (profile.status === 'notVisible') {
            return {
                status: 'referenceNotVisible',
                reference: 'profile',
                id: profile.profileId,
                reason: profile.reason,
            };
        }
        return {
            status: profile.status === 'unknownProfile' ? 'referenceMissing' : 'referenceUnavailable',
            reference: 'profile',
            id: profile.profileId,
        };
    }

    const invocationId = action.target.promptInvocationId;
    const prompt = invocationId === null
        ? null
        : await readTriageActionPromptV1(host, invocationId, options);
    if (prompt !== null && prompt.status !== 'resolved') {
        if (prompt.status === 'invalidInvocation') {
            return { status: 'referenceInvalid', reference: 'prompt', id: prompt.invocationId };
        }
        return {
            status: prompt.status === 'unknownInvocation'
                ? 'referenceMissing'
                : 'referenceUnavailable',
            reference: 'prompt',
            id: prompt.invocationId,
        };
    }

    return {
        status: 'resolved',
        ...(profile === null ? {} : { profile }),
        ...(prompt === null ? {} : { prompt }),
    };
}
