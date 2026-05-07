import { randomUUID } from '@/platform/randomUUID';
import type { AgentId } from '@/agents/catalog/catalog';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV1, SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/agents';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

export interface TempDataEntry {
    data: any;
    timestamp: number;
}

export interface NewSessionData {
    prompt?: string;
    machineId?: string;
    directory?: string;
    path?: string;
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
    agentType?: AgentId;
    backendTarget?: BackendTargetRefV1;
    selectedProfileId?: string | null;
    transcriptStorage?: 'persisted' | 'direct';
    permissionMode?: PermissionMode;
    modelMode?: ModelMode;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    codexBackendMode?: CodexBackendMode | null;
    mcpSelection?: SessionMcpSelectionV1 | null;
    automationDraft?: NewSessionAutomationDraft | null;
    agentNewSessionOptionStateByAgentId?: Record<string, Record<string, unknown>>;
    resumeSessionId?: string;
    replacePersistedDraftSelections?: boolean;
    taskId?: string;
    taskTitle?: string;
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
