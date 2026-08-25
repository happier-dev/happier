import { PluginIdSchema } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import { isTodoKvKey } from "./todoKvStoredContent";

/**
 * UserKVStore is shared with pre-plugin generic KV, so Account-owned domains
 * need physical names that cannot be addressed by that public API. These are
 * direct, inspectable canonical identities: no hash or secondary lookup table
 * decides which plugin owns a row.
 */
export const ACCOUNT_SCOPED_KV_RESERVED_PREFIX = "@happier/" as const;
export const PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX =
    "@happier/account/plugin-storage/v1/" as const;
export const PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX =
    "@happier/account/plugin-settings/v1/" as const;
export const ACCOUNT_SESSION_DRAFT_KV_PREFIX =
    "@happier/account/session-draft/v1/" as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type AccountScopedKvKeyClassification =
    | Readonly<{ kind: "generic" }>
    | Readonly<{ kind: "todo"; keyKind: "index" | "item" }>
    | Readonly<{ kind: "pluginAccountStorage"; pluginId: string }>
    | Readonly<{ kind: "pluginDeclarativeSettings"; pluginId: string }>
    | Readonly<{ kind: "accountSessionDraft" }>
    | Readonly<{ kind: "reservedUnknown" }>;

export class AccountScopedKvReservedKeyError extends Error {
    constructor() {
        super("Reserved AccountScopedKv keys are not addressable through public KV");
        this.name = "AccountScopedKvReservedKeyError";
    }
}

function parsePluginIdAtPrefix(
    key: string,
    prefix: string,
): string | null {
    if (!key.startsWith(prefix)) return null;
    const parsed = PluginIdSchema.safeParse(key.slice(prefix.length));
    return parsed.success ? parsed.data : null;
}

export function buildPluginAccountStoragePhysicalKey(pluginId: string): string {
    return `${PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX}${PluginIdSchema.parse(pluginId)}`;
}

export function buildPluginDeclarativeSettingsPhysicalKey(pluginId: string): string {
    return `${PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX}${PluginIdSchema.parse(pluginId)}`;
}

/**
 * Reserved Account-KV rows persist canonical JSON as opaque base64 bytes. The
 * domain owner still validates the decoded value against its own schema.
 */
export function encodeAccountScopedKvJson(value: unknown): string | null {
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === "string"
            ? privacyKit.encodeBase64(textEncoder.encode(serialized))
            : null;
    } catch {
        return null;
    }
}

/** Throws for malformed UTF-8 or JSON so domain readers fail closed. */
export function decodeAccountScopedKvJson(value: Uint8Array): unknown {
    return JSON.parse(textDecoder.decode(value));
}

/**
 * One classifier owns every currently reserved Account UserKV row. Todo is a
 * legacy public arm; the two plugin arms are private server namespaces.
 */
export function classifyAccountScopedKvKey(
    key: string,
): AccountScopedKvKeyClassification {
    if (key.startsWith(ACCOUNT_SESSION_DRAFT_KV_PREFIX)) {
        return { kind: "accountSessionDraft" };
    }
    const pluginAccountStorage = parsePluginIdAtPrefix(
        key,
        PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX,
    );
    if (pluginAccountStorage !== null) {
        return { kind: "pluginAccountStorage", pluginId: pluginAccountStorage };
    }

    const pluginDeclarativeSettings = parsePluginIdAtPrefix(
        key,
        PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX,
    );
    if (pluginDeclarativeSettings !== null) {
        return {
            kind: "pluginDeclarativeSettings",
            pluginId: pluginDeclarativeSettings,
        };
    }

    if (key.startsWith(ACCOUNT_SCOPED_KV_RESERVED_PREFIX)) {
        return { kind: "reservedUnknown" };
    }

    if (isTodoKvKey(key)) {
        return {
            kind: "todo",
            keyKind: key === "todo.index" ? "index" : "item",
        };
    }

    return { kind: "generic" };
}

export function isReservedAccountScopedKvKey(key: string): boolean {
    const classification = classifyAccountScopedKvKey(key);
    return classification.kind === "pluginAccountStorage"
        || classification.kind === "pluginDeclarativeSettings"
        || classification.kind === "accountSessionDraft"
        || classification.kind === "reservedUnknown";
}

/**
 * Public generic KV may retain its historical generic and Todo keys, but it
 * cannot disclose or mutate any host-private AccountScopedKv row.
 */
export function assertPublicGenericKvKey(key: string): void {
    if (isReservedAccountScopedKvKey(key)) {
        throw new AccountScopedKvReservedKeyError();
    }
}

/**
 * A prefix such as "@" or "@happier" could enumerate reserved rows even if it
 * does not itself contain the full reserved marker, so reject every prefix
 * that overlaps the reserved namespace.
 */
export function assertPublicGenericKvPrefix(prefix: string | undefined): void {
    if (!prefix) return;
    if (
        prefix.startsWith(ACCOUNT_SCOPED_KV_RESERVED_PREFIX)
        || ACCOUNT_SCOPED_KV_RESERVED_PREFIX.startsWith(prefix)
    ) {
        throw new AccountScopedKvReservedKeyError();
    }
}
