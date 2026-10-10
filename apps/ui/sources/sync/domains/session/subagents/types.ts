import type { ExecutionRunLaunchOrigin, ParticipantRecipientV1 } from '@happier-dev/protocol';

export type SessionSubagentKind = 'execution_run' | 'agent_team_member' | 'subagent_sidechain';
export type SessionSubagentStatus = 'running' | 'succeeded' | 'failed' | 'timedOut' | 'cancelled' | 'terminated' | 'unknown';

export type SessionSubagentRunRef = Readonly<{
    runId: string;
    /** Parsed at the canonical transcript boundary; display provenance only, never authority. */
    launchOrigin?: ExecutionRunLaunchOrigin | null;
    backendId?: string | null;
    intent?: string | null;
    runClass?: string | null;
    ioMode?: string | null;
}>;

export type SessionSubagent = Readonly<{
    id: string;
    kind: SessionSubagentKind;
    status: SessionSubagentStatus;
    /** Current work, separate from a retained execution-run handle's lifecycle. */
    isActive?: boolean;
    display: Readonly<{
        title: string;
        subtitle?: string;
        accentName?: string;
        providerLabel?: string;
        groupKey?: string;
        groupLabel?: string;
    }>;
    transcript: Readonly<{
        sidechainId?: string;
        toolMessageRouteId?: string;
        toolId?: string;
    }>;
    runRef?: SessionSubagentRunRef;
    recipient: ParticipantRecipientV1 | null;
    capabilities: Readonly<{
        canOpen: boolean;
        canSend: boolean;
        canStop: boolean;
        canLaunchChild: boolean;
        canDelete: boolean;
        canOpenAdvancedRun: boolean;
    }>;
    timestamps: Readonly<{
        startedAtMs?: number;
        updatedAtMs?: number;
        finishedAtMs?: number;
    }>;
}>;

export type SessionSubagentActiveExecutionRunState = Readonly<{
    runId: string;
    status?: string | null;
    runClass?: string | null;
    turnInFlight?: boolean | null;
}>;
