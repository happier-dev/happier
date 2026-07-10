import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceId,
} from './connectedServiceBindings.js';

/**
 * Agent-friendly connected-services selection normalizer — the ONE boundary that turns the simple
 * forms an agent naturally reaches for into a canonical {@link ConnectedServiceBindingsV1}. This is
 * the canonical contract shared with remote-dev (kept aligned; see F4).
 *
 * Accepted input (any of):
 *  - `undefined` / `null` → no explicit selection; the run/session uses the account default.
 *  - a string token, or an array of string tokens, each one of:
 *      - `"<serviceId>"`                     → the NAMED service's account default. This is an
 *                                              explicit per-service intent: it is REPRESENTED in
 *                                              {@link NormalizeConnectedServiceSelectionResult.defaultServiceIds},
 *                                              never silently dropped. Resolving it to a concrete
 *                                              binding requires account settings, so it happens in a
 *                                              settings-aware consumer (see the run-start policy below).
 *      - `"<serviceId>:<profileId>"`         → pin the run to that connected profile. `profileId` may
 *                                              itself contain `:` (e.g. `work:us`); the entire suffix
 *                                              after the service prefix is preserved.
 *      - `"<serviceId>:profile:<profileId>"` → pin the run to that connected profile (explicit).
 *      - `"<serviceId>:group:<groupId>"`     → bind to that account pool/group (auto-rotates when the
 *                                              pool has autoSwitch enabled). Group ids are strict and
 *                                              never contain `:`.
 *      - `"<serviceId>:native"`              → opt out; use the runner's inherited account.
 *  - a full `{ v: 1, bindingsByServiceId: { ... } }` object (the canonical power form).
 *
 * Malformed input is rejected with a typed error naming the valid forms — never silently dropped.
 * The result carries `bindings` (explicit pins) alongside `defaultServiceIds` (services asking for
 * their stored account default). The three previously-conflated states — "no selection supplied",
 * "a named service wants its account default", and "no explicit binding" — are now distinct.
 */

export type NormalizeConnectedServiceSelectionResult =
    | Readonly<{
        ok: true;
        bindings: ConnectedServiceBindingsV1 | undefined;
        /** Services whose bare token requested their stored account default (explicit per-service intent). */
        defaultServiceIds: readonly ConnectedServiceId[];
    }>
    | Readonly<{ ok: false; error: string }>;

export type NormalizeConnectedServiceSelectionForRunStartResult =
    | Readonly<{ ok: true; bindings: ConnectedServiceBindingsV1 | undefined }>
    | Readonly<{ ok: false; error: string }>;

export const CONNECTED_SERVICE_SELECTION_VALID_FORMS =
    'Valid forms: "<serviceId>" (account default), "<serviceId>:<profileId>", '
    + '"<serviceId>:profile:<profileId>", "<serviceId>:group:<groupId>", "<serviceId>:native", '
    + 'an array of those, or a full { v: 1, bindingsByServiceId: {...} } object. '
    + 'serviceId is e.g. "openai-codex".';

function invalid(reason: string): Readonly<{ ok: false; error: string }> {
    return { ok: false, error: `${reason} ${CONNECTED_SERVICE_SELECTION_VALID_FORMS}` };
}

type SelectionVariant =
    | Readonly<{ kind: 'default' }>
    | Readonly<{ kind: 'binding'; binding: ConnectedServiceBindingSelectionV1 }>;

type TokenParse =
    | Readonly<{ ok: true; serviceId: ConnectedServiceId; variant: SelectionVariant }>
    | Readonly<{ ok: false; error: string }>;

function parseSelectionToken(rawToken: string): TokenParse {
    const token = rawToken.trim();
    if (!token) return invalid('Empty connected-services selection.');

    // Preserve the ENTIRE remaining suffix as the value: only the service prefix and an optional
    // recognised kind keyword are consumed. profileId legally contains ':' — group ids never do.
    const parts = token.split(':');
    const serviceIdRaw = (parts[0] ?? '').trim();
    const serviceParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!serviceParsed.success) {
        return invalid(`Unknown connected service id "${serviceIdRaw}".`);
    }
    const serviceId = serviceParsed.data;

    // "<serviceId>" → the named service's account default (explicit per-service intent).
    if (parts.length === 1) {
        return { ok: true, serviceId, variant: { kind: 'default' } };
    }

    const kindOrProfile = (parts[1] ?? '').trim();

    if (parts.length === 2) {
        if (kindOrProfile === 'native') {
            return { ok: true, serviceId, variant: { kind: 'binding', binding: { source: 'native' } } };
        }
        if (kindOrProfile === 'group') return invalid(`"${serviceId}:group" is missing a group id.`);
        if (kindOrProfile === 'profile') return invalid(`"${serviceId}:profile" is missing a profile id.`);
        // "<serviceId>:<profileId>"
        const profileParsed = ConnectedServiceProfileIdSchema.safeParse(kindOrProfile);
        if (!profileParsed.success) return invalid(`Invalid profile id "${kindOrProfile}".`);
        return {
            ok: true,
            serviceId,
            variant: { kind: 'binding', binding: { source: 'connected', selection: 'profile', profileId: profileParsed.data } },
        };
    }

    // parts.length >= 3
    if (kindOrProfile === 'group') {
        // Group ids are strict and never contain ':' — exactly one value segment is allowed.
        if (parts.length > 3) return invalid(`Invalid group id "${parts.slice(2).join(':')}" (group ids cannot contain ":").`);
        const groupValue = (parts[2] ?? '').trim();
        const groupParsed = ConnectedServiceAuthGroupIdSchema.safeParse(groupValue);
        if (!groupParsed.success) return invalid(`Invalid group id "${groupValue}".`);
        return {
            ok: true,
            serviceId,
            variant: { kind: 'binding', binding: { source: 'connected', selection: 'group', groupId: groupParsed.data } },
        };
    }

    // Either an explicit "<serviceId>:profile:<profileId>" or a colon-bearing shorthand
    // "<serviceId>:<profileId>" — in both cases the whole remaining suffix is the profile id.
    const profileValue = kindOrProfile === 'profile' ? parts.slice(2).join(':') : parts.slice(1).join(':');
    const profileParsed = ConnectedServiceProfileIdSchema.safeParse(profileValue);
    if (!profileParsed.success) return invalid(`Invalid profile id "${profileValue}".`);
    return {
        ok: true,
        serviceId,
        variant: { kind: 'binding', binding: { source: 'connected', selection: 'profile', profileId: profileParsed.data } },
    };
}

function normalizeTokens(tokens: readonly string[]): NormalizeConnectedServiceSelectionResult {
    const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
    const defaultServiceIds: ConnectedServiceId[] = [];
    const seen = new Set<string>();

    for (const rawToken of tokens) {
        const parsed = parseSelectionToken(rawToken);
        if (!parsed.ok) return parsed;
        // Duplicate detection runs on the parsed selection BEFORE resolution, so a bare token and an
        // explicit token for the same service (any order) are rejected rather than silently merged.
        if (seen.has(parsed.serviceId)) {
            return invalid(`Duplicate selection for service "${parsed.serviceId}".`);
        }
        seen.add(parsed.serviceId);
        if (parsed.variant.kind === 'default') {
            defaultServiceIds.push(parsed.serviceId);
            continue;
        }
        bindingsByServiceId[parsed.serviceId] = parsed.variant.binding;
    }

    let bindings: ConnectedServiceBindingsV1 | undefined;
    if (Object.keys(bindingsByServiceId).length > 0) {
        const parsed = ConnectedServiceBindingsV1Schema.safeParse({ v: 1, bindingsByServiceId });
        if (!parsed.success) return invalid('Invalid connected-services selection.');
        bindings = parsed.data;
    }
    return { ok: true, bindings, defaultServiceIds };
}

export function normalizeConnectedServiceSelectionInput(
    input: unknown,
): NormalizeConnectedServiceSelectionResult {
    if (input === undefined || input === null) {
        return { ok: true, bindings: undefined, defaultServiceIds: [] };
    }

    if (typeof input === 'string') {
        return normalizeTokens([input]);
    }

    if (Array.isArray(input)) {
        if (input.some((entry) => typeof entry !== 'string')) {
            return invalid('Connected-services array entries must be strings.');
        }
        return normalizeTokens(input as string[]);
    }

    if (typeof input === 'object') {
        // Canonical power form: a full bindings object.
        const parsed = ConnectedServiceBindingsV1Schema.safeParse(input);
        if (parsed.success) {
            const hasBinding = Object.keys(parsed.data.bindingsByServiceId).length > 0;
            return { ok: true, bindings: hasBinding ? parsed.data : undefined, defaultServiceIds: [] };
        }
        return invalid('Invalid connected-services object.');
    }

    return invalid('Unsupported connected-services selection type.');
}

/**
 * Boundary policy for run-start consumers (execution.run.start, subagents.delegate/plan, voice_agent.start,
 * the manual execution-run tool) that lack account settings and therefore cannot resolve a per-service
 * default to a concrete binding at this layer.
 *
 * - Explicit-only or empty selections pass through unchanged.
 * - A PURE per-service-default selection (bare tokens only) yields `bindings: undefined`, deferring to
 *   the downstream, settings-aware account-defaulting owner (the documented "account default" contract).
 * - A MIXED selection (a bare default token alongside explicit pins for other services) FAILS CLOSED:
 *   honoring the bare service's account default here would require a per-service default merge that this
 *   settings-less boundary cannot perform, and silently dropping it selected the wrong account (RO-F5).
 *   The caller is told to omit the field for all-defaults or to pin every service explicitly.
 */
export function normalizeConnectedServiceSelectionForRunStart(
    input: unknown,
): NormalizeConnectedServiceSelectionForRunStartResult {
    const normalized = normalizeConnectedServiceSelectionInput(input);
    if (!normalized.ok) return normalized;
    if (normalized.defaultServiceIds.length > 0 && normalized.bindings) {
        return invalid(
            `A bare service default token [${normalized.defaultServiceIds.join(', ')}] cannot be combined with `
            + 'explicit connected-service selections for other services in the same request.',
        );
    }
    return { ok: true, bindings: normalized.bindings };
}
