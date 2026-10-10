import { AuthoringMemoryKeyV1Schema } from "@happier-dev/protocol/account/authoringMemory";
import { PluginIdSchema } from "@happier-dev/protocol/plugins/plugin-id";
import { classifyAccountJsonKvKey } from "@happier-dev/protocol/account/accountJsonKv";
import * as privacyKit from "privacy-kit";
import { parseProjectAccountRowPhysicalKeyV1, type ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { parseWorkspaceExecutionConfigPhysicalKeyV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { parsePromptLibraryPhysicalKeyV1, type PromptLibraryCatalogKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { REMOTE_HOST_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { parseConnectedAccountCatalogPhysicalKeyV1, type ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, PROFILE_TRANSFER_ACCOUNT_KV_KEY, parseProfilePhysicalKey } from '@happier-dev/protocol/profiles/profileRecordV1';
export { PROFILE_ACCOUNT_KV_PREFIX, PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, PROFILE_TRANSFER_ACCOUNT_KV_KEY,
    buildProfilePhysicalKey, parseProfilePhysicalKey } from '@happier-dev/protocol/profiles/profileRecordV1';
import { QualifiedProjectTrustProjectV1Schema, type QualifiedProjectTrustProjectV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';

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
export const AUTHORING_MEMORY_ACCOUNT_KV_PREFIX =
    "@happier/account/authoring-memory/v1/" as const;
export const PROJECT_TRUST_ACCOUNT_KV_PREFIX = "@happier/account/project-trust/v1/" as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type AccountScopedKvKeyClassification =
    | Readonly<{ kind: "generic" }>
    | Readonly<{ kind: "todo"; keyKind: "index" | "item" }>
    | Readonly<{ kind: "workspace" }>
    | Readonly<{ kind: "pluginAccountStorage"; pluginId: string }>
    | Readonly<{ kind: "pluginDeclarativeSettings"; pluginId: string }>
    | Readonly<{ kind: "accountSessionDraft" }>
    | Readonly<{ kind: "accountAuthoringMemory"; key: string }>
    | Readonly<{ kind: "accountProjectTrust"; project: QualifiedProjectTrustProjectV1 }>
    | Readonly<{ kind: 'accountProjectRow'; key: ProjectAccountRowKeyV1 }>
    | Readonly<{ kind: "workspaceExecutionConfig"; rowId: string }>
    | Readonly<{ kind: 'accountPromptLibrary'; key: PromptLibraryCatalogKeyV1 }>
    | Readonly<{ kind: 'accountAcpCatalog' }>
    | Readonly<{ kind: 'accountMcpServerCatalog' }>
    | Readonly<{ kind: 'accountProviderConnections' }>
    | Readonly<{ kind: 'accountRemoteHosts' }>
    | Readonly<{ kind: 'accountNotificationChannels' }>
    | Readonly<{ kind: 'accountConnectedPresentation' }>
    | Readonly<{ kind: 'accountConnectedAcknowledgements' }>
    | Readonly<{ kind: 'accountConnectedCatalog'; key: ConnectedAccountCatalogKeyV1 }>
    | Readonly<{ kind: 'accountProfile'; profileId: string }>
    | Readonly<{ kind: 'accountProfileReferenceGuard' }>
    | Readonly<{ kind: 'accountProfileTransfer' }>
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

export function buildAuthoringMemoryPhysicalKey(key: string): string {
    return `${AUTHORING_MEMORY_ACCOUNT_KV_PREFIX}${AuthoringMemoryKeyV1Schema.parse(key)}`;
}

export function parseAuthoringMemoryPhysicalKey(physicalKey: string): string | null {
    if (!physicalKey.startsWith(AUTHORING_MEMORY_ACCOUNT_KV_PREFIX)) return null;
    const parsed = AuthoringMemoryKeyV1Schema.safeParse(physicalKey.slice(AUTHORING_MEMORY_ACCOUNT_KV_PREFIX.length));
    return parsed.success ? parsed.data : null;
}

export function buildProjectTrustPhysicalKey(input: QualifiedProjectTrustProjectV1): string {
    const project = QualifiedProjectTrustProjectV1Schema.parse(input);
    return `${PROJECT_TRUST_ACCOUNT_KV_PREFIX}${encodeURIComponent(project.serverId)}/${encodeURIComponent(project.projectId)}`;
}

export function parseProjectTrustPhysicalKey(key: string): QualifiedProjectTrustProjectV1 | null {
    if (!key.startsWith(PROJECT_TRUST_ACCOUNT_KV_PREFIX)) return null;
    const parts = key.slice(PROJECT_TRUST_ACCOUNT_KV_PREFIX.length).split('/');
    if (parts.length !== 2) return null;
    try {
        const project = QualifiedProjectTrustProjectV1Schema.safeParse({ serverId: decodeURIComponent(parts[0]!), projectId: decodeURIComponent(parts[1]!) });
        return project.success && buildProjectTrustPhysicalKey(project.data) === key ? project.data : null;
    } catch { return null; }
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
 * One classifier owns every currently reserved Account UserKV row. Todo and
 * legacy Workspace rows remain public; the named Account domains are private.
 */
export function classifyAccountScopedKvKey(
    key: string,
): AccountScopedKvKeyClassification {
    if (key === ACP_CATALOG_ACCOUNT_ROW_KEY_V1) return { kind: 'accountAcpCatalog' };
    if (key === MCP_SERVER_CATALOG_ACCOUNT_KEY_V1) return { kind: 'accountMcpServerCatalog' };
    if (key === PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1) return { kind: 'accountProviderConnections' };
    if (key === REMOTE_HOST_ACCOUNT_KV_KEY_V1) return { kind: 'accountRemoteHosts' };
    if (key === NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1) return { kind: 'accountNotificationChannels' };
    if (key === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1) return { kind: 'accountConnectedPresentation' };
    if (key === CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1) return { kind: 'accountConnectedAcknowledgements' };
    const connectedCatalogKey = parseConnectedAccountCatalogPhysicalKeyV1(key);
    if (connectedCatalogKey !== null) return { kind: 'accountConnectedCatalog', key: connectedCatalogKey };
    const promptLibraryKey = parsePromptLibraryPhysicalKeyV1(key);
    if (promptLibraryKey !== null) return { kind: 'accountPromptLibrary', key: promptLibraryKey };
    if (key === PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY) return { kind: 'accountProfileReferenceGuard' };
    if (key === PROFILE_TRANSFER_ACCOUNT_KV_KEY) return { kind: 'accountProfileTransfer' };
    const profileId = parseProfilePhysicalKey(key);
    if (profileId !== null) return { kind: 'accountProfile', profileId };
    const projectRowKey = parseProjectAccountRowPhysicalKeyV1(key);
    if (projectRowKey !== null) return { kind: 'accountProjectRow', key: projectRowKey };
    const rowId = parseWorkspaceExecutionConfigPhysicalKeyV1(key);
    if (rowId !== null) return { kind: 'workspaceExecutionConfig', rowId };
    const projectTrust = parseProjectTrustPhysicalKey(key);
    if (projectTrust !== null) return { kind: "accountProjectTrust", project: projectTrust };
    const authoringMemoryKey = parseAuthoringMemoryPhysicalKey(key);
    if (authoringMemoryKey !== null) return { kind: "accountAuthoringMemory", key: authoringMemoryKey };
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

    const accountJsonNamespace = classifyAccountJsonKvKey(key);
    if (accountJsonNamespace === 'workspace') return { kind: 'workspace' };
    if (accountJsonNamespace === 'todo') {
        return {
            kind: "todo",
            keyKind: key === "todo.index" ? "index" : "item",
        };
    }

    return { kind: "generic" };
}

export function isReservedAccountScopedKvKey(key: string): boolean {
    const classification = classifyAccountScopedKvKey(key);
    return classification.kind !== 'generic'
        && classification.kind !== 'todo'
        && classification.kind !== 'workspace';
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
