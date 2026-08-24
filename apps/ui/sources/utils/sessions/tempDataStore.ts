import { randomUUID } from '@/platform/randomUUID';
import type { AgentId } from '@/agents/catalog/catalog';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type {
    AcpConfigOptionOverridesV1,
    BackendTargetRefV2,
    ComposerAttachmentAuthorValueV1,
    SessionMcpSelectionV1,
    SessionModelSelectionV1,
    SessionSpawnSourceContextV1,
} from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/protocol';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { BackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import type { PluginEventAutomationEditSeed } from '@/components/automations/editor/pluginEventAutomationEditSeed';

export interface TempDataEntry {
    data: any;
    timestamp: number;
}

/**
 * Author-shaped input that exists only between a trusted host selection and
 * the mounted New Session composer.  It is deliberately not a draft format:
 * the mounted composer resolves contribution authority and mints the finished
 * attachment records before the New Session draft persists them.
 */
export type NewSessionPluginAttachmentSeedV1 = Readonly<{
    pluginId: string;
    attachmentLocalId: string;
    value: ComposerAttachmentAuthorValueV1;
}>;

export type NewSessionPluginSeedHandoffV1 = Readonly<{
    attachments?: readonly NewSessionPluginAttachmentSeedV1[];
    placementCandidates?: readonly PluginUiSessionPlacementCandidateV1[];
}>;

export interface NewSessionData {
    prompt?: string;
    machineId?: string;
    directory?: string;
    path?: string;
    replacePersistedDraftSelections?: boolean;
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
    agentType?: AgentId;
    backendTarget?: BackendTargetRefV2;
    selectedProfileId?: string | null;
    transcriptStorage?: 'persisted' | 'direct';
    permissionMode?: PermissionMode;
    modelSelection?: SessionModelSelectionV1 | null;
    /** Read-only compatibility input. New temp-data writers use `modelSelection`. */
    modelMode?: ModelMode;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    codexBackendMode?: CodexBackendMode | null;
    mcpSelection?: SessionMcpSelectionV1 | null;
    automationDraft?: NewSessionAutomationDraft | null;
    /** One-shot direct-detail handoff; never persisted or indexed by this store. */
    eventAutomationEditSeed?: PluginEventAutomationEditSeed;
    /** UI-only server scope for an Event existing-session target. */
    eventAutomationExistingSessionServerId?: string | null;
    /** One-shot Session → Event authoring handoff; never persisted by this store. */
    eventAutomationInitialTarget?: Readonly<{
        kind: 'existingSession';
        sessionId: string;
        serverId: string;
    }>;
    backendNewSessionOptionStateByTargetKey?: BackendNewSessionOptionStateByTargetKey;
    agentNewSessionOptionStateByAgentId?: BackendNewSessionOptionStateByTargetKey;
    resumeSessionId?: string;
    taskId?: string;
    taskTitle?: string;
    /**
     * One-shot continuation recipe for a configurable Replay-seeded child.
     *
     * This is required semantics for the created Session, not an ignorable hint:
     * the daemon resolves the source transcript before creating the child. It is
     * semantically distinct from a Session mention — a mention says "this Session
     * is available to inspect", this says "create this Session as a continuation".
     */
    sourceContext?: SessionSpawnSourceContextV1;
    /**
     * The server the source Session lives on. V1 requires source and target to
     * match, and authoring must say so rather than silently dropping the recipe.
     */
    sourceContextServerId?: string | null;
    /**
     * One-shot host → mounted-composer input. It is consumed with this
     * `NewSessionData` entry and is never a second persisted New Session draft.
     */
    pluginNewSessionSeed?: NewSessionPluginSeedHandoffV1;
}

// In-memory store for temporary data
const tempDataMap = new Map<string, TempDataEntry>();

// Cleanup entries older than 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_AGE = 10 * 60 * 1000; // 10 minutes

// Auto-cleanup old entries
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tempDataMap.entries()) {
        if (now - entry.timestamp > MAX_AGE) {
            tempDataMap.delete(key);
        }
    }
}, CLEANUP_INTERVAL);

/**
 * Store temporary data and return a UUID key
 */
export function storeTempData(data: any): string {
    const key = randomUUID();
    tempDataMap.set(key, {
        data,
        timestamp: Date.now()
    });
    return key;
}

/**
 * Retrieve and remove temporary data by key
 * Data is removed after retrieval to prevent reuse
 */
export function getTempData<T = any>(key: string): T | null {
    const entry = tempDataMap.get(key);
    if (entry) {
        tempDataMap.delete(key); // Remove after retrieval
        return entry.data as T;
    }
    return null;
}

/**
 * Peek at temporary data without removing it
 */
export function peekTempData<T = any>(key: string): T | null {
    const entry = tempDataMap.get(key);
    return entry ? entry.data as T : null;
}

/**
 * Clear all temporary data (useful for testing)
 */
export function clearTempData(): void {
    tempDataMap.clear();
}
