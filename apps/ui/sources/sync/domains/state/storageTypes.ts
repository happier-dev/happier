import { z } from "zod";
import { PERMISSION_MODES } from "@/constants/PermissionModes";
import type { PermissionMode } from "@/constants/PermissionModes";
import type { ModelMode } from "@/sync/domains/permissions/permissionTypes";

//
// Agent states
//

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    profileId: z.string().nullable().optional(), // Session-scoped profile identity (non-secret)
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexSessionId: z.string().optional(), // Codex session/conversation ID (uuid)
    geminiSessionId: z.string().optional(), // Gemini ACP session ID (opaque)
    opencodeSessionId: z.string().optional(), // OpenCode ACP session ID (opaque)
    auggieSessionId: z.string().optional(), // Auggie ACP session ID (opaque)
    qwenSessionId: z.string().optional(), // Qwen Code ACP session ID (opaque)
    kimiSessionId: z.string().optional(), // Kimi ACP session ID (opaque)
    auggieAllowIndexing: z.boolean().optional(), // Auggie indexing enablement (spawn-time)
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    slashCommandDetails: z.array(z.object({
        command: z.string(),
        description: z.string().optional(),
    })).optional(),
    acpHistoryImportV1: z.object({
        v: z.literal(1),
        provider: z.string(),
        remoteSessionId: z.string(),
        importedAt: z.number(),
        lastImportedFingerprint: z.string().optional(),
    }).optional(),
    acpSessionModesV1: z.object({
        v: z.literal(1),
        provider: z.string(),
        updatedAt: z.number(),
        currentModeId: z.string(),
        availableModes: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
        })),
    }).optional(),
    /**
     * ACP session models (if supported by the provider's ACP agent).
     *
     * NOTE: This is an UNSTABLE ACP feature and may be unsupported by some agents.
     */
    acpSessionModelsV1: z.object({
        v: z.literal(1),
        provider: z.string(),
        updatedAt: z.number(),
        currentModelId: z.string(),
        availableModels: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
        })),
    }).optional(),
    /**
     * ACP session configuration options (if supported by the provider's ACP agent).
     */
    acpConfigOptionsV1: z.object({
        v: z.literal(1),
        provider: z.string(),
        updatedAt: z.number(),
        configOptions: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            type: z.string(),
            currentValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
            options: z.array(z.object({
                value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
                name: z.string(),
                description: z.string().optional(),
            })).optional(),
        })),
    }).optional(),
    /**
     * Desired ACP session mode override selected by the user (UI/CLI).
     *
     * This is distinct from `acpSessionModesV1`:
     * - `acpSessionModesV1` mirrors the agent-reported current state.
     * - `acpSessionModeOverrideV1` is the user's requested mode, applied by the runner when possible.
     */
    acpSessionModeOverrideV1: z.object({
        v: z.literal(1),
        updatedAt: z.number(),
        modeId: z.string(),
    }).optional(),
    /**
     * Desired ACP config option overrides selected by the user (UI/CLI).
     */
    acpConfigOptionOverridesV1: z.object({
        v: z.literal(1),
        updatedAt: z.number(),
        overrides: z.record(z.string(), z.object({
            updatedAt: z.number(),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        })),
    }).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    hostPid: z.number().optional(), // Process ID of the session
    terminal: z.object({
        mode: z.enum(['plain', 'tmux']),
        requested: z.enum(['plain', 'tmux']).optional(),
        fallbackReason: z.string().optional(),
        tmux: z.object({
            target: z.string(),
            tmpDir: z.string().optional(),
        }).optional(),
    }).optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    // Published by happy-cli so the app can seed permission state even before there are messages.
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    permissionModeUpdatedAt: z.number().optional(),
    /**
     * Session-level model override selected by the user (UI/CLI).
     *
     * This mirrors the permission/mode override pattern:
     * - Stored in session metadata for cross-device consistency
     * - Applied to outgoing user messages via `message.meta.model` where supported
     */
    modelOverrideV1: z.object({
        v: z.literal(1),
        updatedAt: z.number(),
        modelId: z.string(),
    }).optional(),
    /**
     * Local-only markers for committed transcript messages that should be treated as discarded
     * (e.g. when the user switches to terminal control and abandons unprocessed remote messages).
     */
    discardedCommittedMessageLocalIds: z.array(z.string()).optional(),
    readStateV1: z.object({
        v: z.literal(1),
        sessionSeq: z.number(),
        pendingActivityAt: z.number(),
        updatedAt: z.number(),
    }).optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish()
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'approved_execpolicy_amendment', 'denied', 'abort']).nullish()
    })).nullish(),
    /**
     * Optional agent capabilities negotiated via agentState.
     * This must be permissive for backward/forward compatibility across agent versions.
     */
    capabilities: z.object({
        askUserQuestionAnswersInPermission: z.boolean().optional(),
        inFlightSteer: z.boolean().optional(),
    }).nullish(),
}).passthrough();

export type AgentState = z.infer<typeof AgentStateSchema>;

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    active: boolean,
    activeAt: number,
    /**
     * Server-side pending queue (V2) summary fields.
     * Optional for mixed-version safety with older servers.
     */
    pendingVersion?: number,
    pendingCount?: number,
    metadata: Metadata | null,
    metadataVersion: number,
    agentState: AgentState | null,
    agentStateVersion: number,
    thinking: boolean,
    thinkingAt: number,
    presence: "online" | number, // "online" when active, timestamp when last seen
    optimisticThinkingAt?: number | null; // Local-only timestamp used for immediate "processing" UI feedback after submit
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: PermissionMode | null; // Local permission mode, not synced to server
    permissionModeUpdatedAt?: number | null; // Local timestamp to coordinate inferred (from last message) vs user-selected mode, not synced to server
    modelMode?: ModelMode | null; // Local model mode, not synced to server
    modelModeUpdatedAt?: number | null; // Local timestamp used to arbitrate model overrides across devices, not synced to server
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
    } | null;
    // Sharing-related fields
    owner?: string; // User ID of the session owner (for shared sessions)
    ownerProfile?: {
        id: string;
        username: string | null;
        firstName: string | null;
        lastName: string | null;
        avatar: string | null;
    }; // Owner profile information (for shared sessions)
    accessLevel?: 'view' | 'edit' | 'admin'; // Access level for shared sessions
    canApprovePermissions?: boolean; // Whether the current user can approve permission prompts for this shared session
}

export interface PendingMessage {
    id: string;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
    text: string;
    displayText?: string;
    rawRecord: any;
}

export interface DiscardedPendingMessage extends PendingMessage {
    discardedAt: number;
    discardedReason: 'switch_to_local' | 'manual';
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
}

//
// Machine states
//

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    happyHomeDir: z.string(), // Directory for Happier auth, settings, logs (usually .happy/ or .happy-dev/)
    homeDir: z.string(), // User's home directory (matches CLI field name)
    // Optional fields that may be added in future versions
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(), // Custom display name for the machine
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    // Daemon status fields
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']).optional()
});

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export interface Machine {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;  // Changed from lastActiveAt to activeAt for consistency
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: any | null;  // Dynamic daemon state (runtime info)
    daemonStateVersion: number;
}

//
// Git Status
//

export interface GitStatus {
    branch: string | null;
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    lastUpdatedAt: number;
    // Line change statistics - separated by staged vs unstaged
    stagedLinesAdded: number;
    stagedLinesRemoved: number;
    unstagedLinesAdded: number;
    unstagedLinesRemoved: number;
    // Computed totals
    linesAdded: number;      // stagedLinesAdded + unstagedLinesAdded
    linesRemoved: number;    // stagedLinesRemoved + unstagedLinesRemoved
    linesChanged: number;    // Total lines that were modified (added + removed)
    // Branch tracking information (from porcelain v2)
    upstreamBranch?: string | null; // Name of upstream branch
    aheadCount?: number; // Commits ahead of upstream
    behindCount?: number; // Commits behind upstream
    stashCount?: number; // Number of stash entries
}

export type GitEntryKind =
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'untracked'
    | 'conflicted';

export interface GitPathStats {
    stagedAdded: number;
    stagedRemoved: number;
    unstagedAdded: number;
    unstagedRemoved: number;
    isBinary: boolean;
}

export interface GitWorkingEntry {
    path: string;
    previousPath: string | null;
    kind: GitEntryKind;
    indexStatus: string;
    worktreeStatus: string;
    hasStagedDelta: boolean;
    hasUnstagedDelta: boolean;
    stats: GitPathStats;
}

export interface GitWorkingSnapshot {
    projectKey: string;
    fetchedAt: number;
    repo: {
        isGitRepo: boolean;
        rootPath: string | null;
    };
    branch: {
        head: string | null;
        upstream: string | null;
        ahead: number;
        behind: number;
        detached: boolean;
    };
    stashCount: number;
    hasConflicts: boolean;
    entries: GitWorkingEntry[];
    totals: {
        stagedFiles: number;
        unstagedFiles: number;
        untrackedFiles: number;
        stagedAdded: number;
        stagedRemoved: number;
        unstagedAdded: number;
        unstagedRemoved: number;
    };
}
