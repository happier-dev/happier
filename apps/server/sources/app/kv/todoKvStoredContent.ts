import { StoredJsonContentEnvelopeSchema } from "@happier-dev/protocol";

export type TodoKvStoredContentClassification =
    | Readonly<{ domain: "generic" }>
    | Readonly<{
        domain: "todo";
        keyKind: "index" | "item";
        representation:
            | "legacy_encrypted"
            | "malformed_marker"
            | "current_encrypted"
            | "current_plain";
    }>;

export class TodoKvStoredContentUpgradeRequiredError extends Error {
    constructor() {
        super("Current account stored-content protocol is required for this Todo value");
        this.name = "TodoKvStoredContentUpgradeRequiredError";
    }
}

export class TodoKvStoredContentModeMismatchError extends Error {
    constructor() {
        super("Todo stored-content representation does not match its owning mode");
        this.name = "TodoKvStoredContentModeMismatchError";
    }
}

function classifyTodoKey(key: string): "index" | "item" | null {
    if (key === "todo.index") {
        return "index";
    }
    if (key.startsWith("todo.") && key.length > "todo.".length) {
        return "item";
    }
    return null;
}

function hasOwnProperty(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

export function isTodoKvKey(key: string): boolean {
    return classifyTodoKey(key) !== null;
}

function todoRepresentationMatchesMode(
    representation: Extract<
        TodoKvStoredContentClassification,
        { domain: "todo" }
    >["representation"],
    mode: "plain" | "e2ee",
): boolean {
    if (representation === "malformed_marker") return false;
    return mode === "plain"
        ? representation === "current_plain"
        : representation === "legacy_encrypted"
            || representation === "current_encrypted";
}

export function assertTodoKvStoredContentMatchesAccountMode(
    params: Readonly<{
        key: string;
        value: Uint8Array;
        accountMode: "plain" | "e2ee";
    }>,
): void {
    const classification = classifyTodoKvStoredContent({
        key: params.key,
        value: params.value,
    });
    if (
        classification.domain === "todo"
        && !todoRepresentationMatchesMode(
            classification.representation,
            params.accountMode,
        )
    ) {
        throw new TodoKvStoredContentModeMismatchError();
    }
}

/**
 * Classifies only the Todo-owned portion of the generic KV namespace.
 * All non-Todo keys remain opaque, regardless of whether their bytes resemble a
 * canonical stored-content envelope.
 */
export function classifyTodoKvStoredContent(params: Readonly<{
    key: string;
    value: Uint8Array;
}>): TodoKvStoredContentClassification {
    const keyKind = classifyTodoKey(params.key);
    if (keyKind === null) {
        return { domain: "generic" };
    }

    try {
        const decoded: unknown = JSON.parse(
            new TextDecoder().decode(params.value),
        );
        const parsed = StoredJsonContentEnvelopeSchema.safeParse(decoded);
        if (parsed.success) {
            const hasRequiredPayload = decoded !== null
                && typeof decoded === "object"
                && (parsed.data.t === "plain"
                    ? hasOwnProperty(decoded, "v")
                    : hasOwnProperty(decoded, "c"));
            if (!hasRequiredPayload) {
                return {
                    domain: "todo",
                    keyKind,
                    representation: "malformed_marker",
                };
            }
            return {
                domain: "todo",
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
                domain: "todo",
                keyKind,
                representation: "malformed_marker",
            };
        }
    } catch {
        // Released Todo values are opaque account ciphertext, not JSON envelopes.
    }

    return {
        domain: "todo",
        keyKind,
        representation: "legacy_encrypted",
    };
}

export function assertTodoKvMutationStoredContent(params: Readonly<{
    key: string;
    persistedValue: Uint8Array | null;
    nextValue: Uint8Array | null;
    accountMode: "plain" | "e2ee" | null;
    supportsCurrentProtocol: boolean;
}>): void {
    const persisted = params.persistedValue === null
        ? null
        : classifyTodoKvStoredContent({
            key: params.key,
            value: params.persistedValue,
        });
    const next = params.nextValue === null
        ? null
        : classifyTodoKvStoredContent({
            key: params.key,
            value: params.nextValue,
        });
    const todo = persisted?.domain === "todo"
        ? persisted
        : next?.domain === "todo"
            ? next
            : null;
    if (todo === null) {
        return;
    }

    const persistedRepresentation = persisted?.domain === "todo"
        ? persisted.representation
        : null;
    const nextRepresentation = next?.domain === "todo"
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
        throw new TodoKvStoredContentUpgradeRequiredError();
    }
    if (persistedRepresentation !== null) {
        if (
            params.accountMode === null
            || !todoRepresentationMatchesMode(
                persistedRepresentation,
                params.accountMode,
            )
        ) {
            throw new TodoKvStoredContentModeMismatchError();
        }
    }
    if (nextRepresentation !== null) {
        if (
            params.accountMode === null
            || !todoRepresentationMatchesMode(
                nextRepresentation,
                params.accountMode,
            )
        ) {
            throw new TodoKvStoredContentModeMismatchError();
        }
    }

    if (
        persistedRepresentation !== null
        && nextRepresentation !== null
        && persistedRepresentation !== nextRepresentation
    ) {
        throw new TodoKvStoredContentModeMismatchError();
    }
}

/**
 * The Account transition owner may replace an exact, versioned Todo row across
 * modes after it has validated the complete migration inventory. This assertion
 * remains narrower than public KV mutation admission: it requires an existing
 * Todo value, a non-null replacement, and an actual transition to `toMode`.
 */
export function assertTodoKvAccountEncryptionTransitionStoredContent(
    params: Readonly<{
        key: string;
        persistedValue: Uint8Array;
        nextValue: Uint8Array;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
    }>,
): void {
    const persisted = classifyTodoKvStoredContent({
        key: params.key,
        value: params.persistedValue,
    });
    const next = classifyTodoKvStoredContent({
        key: params.key,
        value: params.nextValue,
    });
    if (persisted.domain !== "todo" || next.domain !== "todo") {
        throw new TodoKvStoredContentModeMismatchError();
    }

    if (
        params.fromMode === params.toMode
        || !todoRepresentationMatchesMode(
            persisted.representation,
            params.fromMode,
        )
        || !todoRepresentationMatchesMode(
            next.representation,
            params.toMode,
        )
    ) {
        throw new TodoKvStoredContentModeMismatchError();
    }
}
