import { randomUUID } from '@/platform/randomUUID';
import type { AgentId } from '@/agents/catalog/catalog';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type {
    AcpConfigOptionOverridesV1} from '@happier-dev/protocol/sessions/metadata/overrides';
import type {
    AgentExecutionTargetV1} from '@happier-dev/protocol/agents/executionTargetV1';
import type {
    BackendTargetRefV2} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type {
    RuntimeDescriptorV1} from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import type {
    SessionCapabilitySelectionV1} from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type {
    SessionModelSelectionV1} from '@happier-dev/protocol/providers/selection/v1';
import type {
    SessionSpawnSourceContextV1} from '@happier-dev/protocol/sessions/creation/sessionSpawnSourceContextV1';
import type {
    SessionAuthoringExecutionTargetV2,
    TemporaryComputerActivationRefV1} from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import type {
    SessionOrganizationPlacementV1} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type {
    SessionInitialAccessDraftV1} from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import type {
    SessionInitialTriggerV1,
} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { BackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import type { SessionIdentityAdditions } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { SessionPromptStackV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { SessionInstructionsAuthoringDraft } from '@/sync/domains/state/sessionInstructionsDraft';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';

export interface TempDataEntry {
    data: any;
    timestamp: number;
}

export type NewSessionPluginSeedHandoffV1 = Readonly<{
    placementCandidates?: readonly PluginUiSessionPlacementCandidateV1[];
}>;

export interface NewSessionData {
    sessionName?: string;
    initialSessionFacts?: SessionIdentityAdditions;
    memoryEnabled?: boolean;
    isolationOverride?: 'directly';
    promptStack?: SessionPromptStackV1;
    instructionsDraft?: SessionInstructionsAuthoringDraft | null;
    prompt?: string;
    machineId?: string;
    directory?: string;
    path?: string;
    /** `managed`: start without a folder (the machine keeps a private one for the session). */
    directoryKind?: 'managed';
    executionTarget?: SessionAuthoringExecutionTargetV2 | null;
    /** Reviewed local intent returned by the ordinary Machine picker; never an allocation. */
    managedMachineSelection?: ManagedMachineSelectionDraft | null;
    /** One-shot picker continuation, never persisted with the authoring draft. */
    managedMachineUseOptions?: import('@/components/sessions/new/components/machineSelection/managedMachineSelection').ManagedMachineUseOptions;
    temporaryComputerActivationRef?: TemporaryComputerActivationRefV1 | null;
    organizationPlacement?: SessionOrganizationPlacementV1;
    access?: SessionInitialAccessDraftV1 | null;
    initialTriggers?: SessionInitialTriggerV1[];
    primaryTeamId?: string | null;
    replacePersistedDraftSelections?: boolean;
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
    agentType?: AgentId;
    agentTarget?: AgentExecutionTargetV1 | null;
    backendTarget?: BackendTargetRefV2;
    selectedProfileId?: string | null;
    approvalProfileId?: string | null;
    transcriptStorage?: 'persisted' | 'direct';
    permissionMode?: PermissionMode;
    modelSelection?: SessionModelSelectionV1 | null;
    /** Read-only compatibility input. New temp-data writers use `modelSelection`. */
    modelMode?: ModelMode;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    capabilitySelection?: SessionCapabilitySelectionV1 | null;
    automationDraft?: NewSessionAutomationDraft | null;
    backendNewSessionOptionStateByTargetKey?: BackendNewSessionOptionStateByTargetKey;
    agentNewSessionOptionStateByAgentId?: BackendNewSessionOptionStateByTargetKey;
    resumeSessionId?: string;
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
     * One-shot host → mounted New Session placement choice. Attachment requests
     * use the Account + draft keyed pre-admission owner instead, because route
     * temp data is destructively consumed before a Composer remount.
     */
    pluginNewSessionSeed?: NewSessionPluginSeedHandoffV1;
}

// In-memory store for temporary data
const tempDataMap = new Map<string, TempDataEntry>();

// Entries older than this are abandoned navigation data: expired on read and pruned at the next
// store, so pending data arms no timer.
const MAX_AGE = 10 * 60 * 1000; // 10 minutes

function isExpired(entry: TempDataEntry, now: number): boolean {
    return now - entry.timestamp > MAX_AGE;
}

/**
 * Store temporary data and return a UUID key
 */
export function storeTempData(data: any): string {
    const key = randomUUID();
    const now = Date.now();
    for (const [staleKey, entry] of tempDataMap) if (isExpired(entry, now)) tempDataMap.delete(staleKey);
    tempDataMap.set(key, {
        data,
        timestamp: now
    });
    return key;
}

/**
 * Retrieve and remove temporary data by key
 * Data is removed after retrieval to prevent reuse
 */
export function getTempData<T = any>(key: string): T | null {
    const entry = tempDataMap.get(key);
    if (!entry) return null;
    tempDataMap.delete(key); // Remove after retrieval
    return isExpired(entry, Date.now()) ? null : entry.data as T;
}

/**
 * Peek at temporary data without removing it
 */
export function peekTempData<T = any>(key: string): T | null {
    const entry = tempDataMap.get(key);
    if (!entry) return null;
    if (!isExpired(entry, Date.now())) return entry.data as T;
    tempDataMap.delete(key);
    return null;
}

/**
 * Clear all temporary data (useful for testing)
 */
export function clearTempData(): void {
    tempDataMap.clear();
}
