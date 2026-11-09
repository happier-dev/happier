import { StoredJsonContentEnvelopeSchema, TaskResourceStoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { classifyAccountJsonKvKey, type AccountJsonKvNamespace } from '@happier-dev/protocol/account/accountJsonKv';

export type AccountJsonKvStoredContentClassification =
    | Readonly<{ domain: "generic" }>
    | Readonly<{
        domain: AccountJsonKvNamespace;
        keyKind: "index" | "item";
        representation:
            | "legacy_encrypted"
            | "malformed_marker"
            | "current_encrypted"
            | "current_resource_encrypted"
            | "current_plain";
    }>;

export class AccountJsonKvStoredContentUpgradeRequiredError extends Error {
    constructor() {
        super("Current account stored-content protocol is required for this Account JSON value");
        this.name = "AccountJsonKvStoredContentUpgradeRequiredError";
    }
}

export class AccountJsonKvStoredContentModeMismatchError extends Error {
    constructor() {
        super("Account JSON stored-content representation does not match its owning mode");
        this.name = "AccountJsonKvStoredContentModeMismatchError";
    }
}

function hasOwnProperty(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

export function isAccountJsonKvKey(key: string): boolean {
    return classifyAccountJsonKvKey(key) !== null;
}

function accountJsonKvRepresentationMatchesMode(
    representation: Extract<
        AccountJsonKvStoredContentClassification,
        { domain: AccountJsonKvNamespace }
    >["representation"],
    mode: "plain" | "e2ee",
    usage?: "task_resource",
): boolean {
    if (representation === "malformed_marker") return false;
    if (representation === "current_resource_encrypted") {
        return usage === "task_resource" && mode === "e2ee";
    }
    return mode === "plain"
        ? representation === "current_plain"
        : representation === "legacy_encrypted"
            || representation === "current_encrypted";
}

export function assertAccountJsonKvStoredContentMatchesAccountMode(
    params: Readonly<{
        key: string;
        value: Uint8Array;
        accountMode: "plain" | "e2ee";
        usage?: "task_resource";
    }>,
): void {
    const classification = classifyAccountJsonKvStoredContent({
        key: params.key,
        value: params.value,
    });
    if (
        classification.domain !== "generic"
        && !accountJsonKvRepresentationMatchesMode(
            classification.representation,
            params.accountMode,
            params.usage,
        )
    ) {
        throw new AccountJsonKvStoredContentModeMismatchError();
    }
}

/**
 * Classifies the Account-json portion of the public KV namespace.
 * Other keys remain opaque, regardless of whether their bytes resemble a
 * canonical stored-content envelope.
 */
export function classifyAccountJsonKvStoredContent(params: Readonly<{
    key: string;
    value: Uint8Array;
}>): AccountJsonKvStoredContentClassification {
    const domain = classifyAccountJsonKvKey(params.key);
    if (domain === null) {
        return { domain: "generic" };
    }
    const keyKind = params.key === 'todo.index' ? 'index' : 'item';

    try {
        const decoded: unknown = JSON.parse(
            new TextDecoder().decode(params.value),
        );
        if (decoded !== null && typeof decoded === "object" && hasOwnProperty(decoded, "k")) {
            return {
                domain,
                keyKind,
                representation: domain === "todo" && keyKind === "item"
                    && TaskResourceStoredJsonContentEnvelopeSchema.safeParse(decoded).success
                    ? "current_resource_encrypted"
                    : "malformed_marker",
            };
        }
        const parsed = StoredJsonContentEnvelopeSchema.safeParse(decoded);
        if (parsed.success) {
            const hasRequiredPayload = decoded !== null
                && typeof decoded === "object"
                && (parsed.data.t === "plain"
                    ? hasOwnProperty(decoded, "v")
                    : hasOwnProperty(decoded, "c"));
            if (!hasRequiredPayload) {
                return {
                    domain,
                    keyKind,
                    representation: "malformed_marker",
                };
            }
            return {
                domain,
                keyKind,
                representation: parsed.data.t === "plain"
                    ? "current_plain"
                    : "current_encrypted",
            };
        }
        if (
            decoded !== null
            && typeof decoded === "object"
            && !Array.isArray(decoded)
            && hasOwnProperty(decoded, "t")
        ) {
            return {
                domain,
                keyKind,
                representation: "malformed_marker",
            };
        }
    } catch {
        // Released Account JSON values are opaque account ciphertext, not JSON envelopes.
    }

    return {
        domain,
        keyKind,
        representation: "legacy_encrypted",
    };
}

export function assertAccountJsonKvMutationStoredContent(params: Readonly<{
    key: string;
    persistedValue: Uint8Array | null;
    nextValue: Uint8Array | null;
    accountMode: "plain" | "e2ee" | null;
    supportsCurrentProtocol: boolean;
    usage?: "task_resource" | "task_resource_promotion";
}>): void {
    const persisted = params.persistedValue === null
        ? null
        : classifyAccountJsonKvStoredContent({
            key: params.key,
            value: params.persistedValue,
        });
    const next = params.nextValue === null
        ? null
        : classifyAccountJsonKvStoredContent({
            key: params.key,
            value: params.nextValue,
        });
    const accountJson = persisted && persisted.domain !== "generic"
        ? persisted
        : next && next.domain !== "generic"
            ? next
            : null;
    if (accountJson === null) {
        return;
    }

    const persistedRepresentation = persisted && persisted.domain !== "generic"
        ? persisted.representation
        : null;
    const nextRepresentation = next && next.domain !== "generic"
        ? next.representation
        : null;
    const touchesCurrentRepresentation =
        persistedRepresentation?.startsWith("current_") === true
        || nextRepresentation?.startsWith("current_") === true;
    const createsForPlainAccount =
        persistedRepresentation === null
        && nextRepresentation !== null
        && params.accountMode === "plain";

    if (
        !params.supportsCurrentProtocol
        && (touchesCurrentRepresentation || createsForPlainAccount)
    ) {
        throw new AccountJsonKvStoredContentUpgradeRequiredError();
    }
    // Only the task grant transaction may change an Account-sealed task into
    // resource-key ciphertext; ordinary mutations retain their representation.
    if (params.usage === "task_resource_promotion") {
        if (accountJson.domain !== "todo" || accountJson.keyKind !== "item"
            || params.accountMode !== "e2ee"
            || (persistedRepresentation !== "legacy_encrypted" && persistedRepresentation !== "current_encrypted")
            || nextRepresentation !== "current_resource_encrypted") {
            throw new AccountJsonKvStoredContentModeMismatchError();
        }
        return;
    }
    if (persistedRepresentation !== null) {
        if (
            params.accountMode === null
            || !accountJsonKvRepresentationMatchesMode(
                persistedRepresentation,
                params.accountMode,
                params.usage,
            )
        ) {
            throw new AccountJsonKvStoredContentModeMismatchError();
        }
    }
    if (nextRepresentation !== null) {
        if (
            params.accountMode === null
            || !accountJsonKvRepresentationMatchesMode(
                nextRepresentation,
                params.accountMode,
                params.usage,
            )
        ) {
            throw new AccountJsonKvStoredContentModeMismatchError();
        }
    }

    if (
        persistedRepresentation !== null
        && nextRepresentation !== null
        && persistedRepresentation !== nextRepresentation
    ) {
        throw new AccountJsonKvStoredContentModeMismatchError();
    }
}

/**
 * The Account transition owner may replace an exact, versioned Account JSON row across
 * modes after it has validated the complete migration inventory. This assertion
 * remains narrower than public KV mutation admission: it requires an existing
 * Account JSON value, a non-null replacement, and an actual transition to `toMode`.
 */
export function assertAccountJsonKvAccountEncryptionTransitionStoredContent(
    params: Readonly<{
        key: string;
        persistedValue: Uint8Array;
        nextValue: Uint8Array;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
    }>,
): void {
    const persisted = classifyAccountJsonKvStoredContent({
        key: params.key,
        value: params.persistedValue,
    });
    const next = classifyAccountJsonKvStoredContent({
        key: params.key,
        value: params.nextValue,
    });
    if (persisted.domain === "generic" || next.domain === "generic") {
        throw new AccountJsonKvStoredContentModeMismatchError();
    }

    if (
        params.fromMode === params.toMode
        || !accountJsonKvRepresentationMatchesMode(
            persisted.representation,
            params.fromMode,
        )
        || !accountJsonKvRepresentationMatchesMode(
            next.representation,
            params.toMode,
        )
    ) {
        throw new AccountJsonKvStoredContentModeMismatchError();
    }
}
