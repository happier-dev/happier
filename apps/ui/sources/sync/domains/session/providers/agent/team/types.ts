import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

export type AgentTeamSessionProviderDescriptor = Readonly<{
    kind: 'session.agentTeamBehavior.v1';
    snapshotKey: string;
    providerLabel: string;
    flavorAliases: readonly string[];
    tools: Readonly<{
        teamCreate: readonly string[];
        teamDelete: readonly string[];
        teamSendMessage: readonly string[];
        subagentSpawn: readonly string[];
        activeTeamFallbackSubagentSpawn?: readonly string[];
        configMutation?: readonly string[];
    }>;
    configTeamPath?: Readonly<{
        rootDirectory: string;
        teamsDirectory: string;
        filename: string;
    }>;
    lifecycleEvents?: Readonly<{
        ignoreActivityPreview?: readonly string[];
        shutdownApproved?: string;
    }>;
}>;

export type AgentTeamToolCall = Readonly<{
    id?: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    input: unknown;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: unknown;
}>;

export type AgentTeamUserTextMessage = Readonly<{
    kind: 'user-text';
    id: string;
    createdAt: number;
    text: string;
    meta?: unknown;
}>;

export type AgentTeamAgentTextMessage = Readonly<{
    kind: 'agent-text';
    id: string;
    createdAt: number;
    text: string;
    meta?: unknown;
}>;

export type AgentTeamToolCallMessage = Readonly<{
    kind: 'tool-call';
    id: string;
    seq?: number;
    createdAt: number;
    tool: AgentTeamToolCall;
    children: readonly AgentTeamMessage[];
    meta?: unknown;
}>;

export type AgentTeamEventMessage = Readonly<{
    kind: 'agent-event';
    id: string;
    createdAt: number;
    event?: unknown;
    meta?: unknown;
}>;

export type AgentTeamMessage =
    | AgentTeamUserTextMessage
    | AgentTeamAgentTextMessage
    | AgentTeamToolCallMessage
    | AgentTeamEventMessage;

export type AgentTeamSessionParticipantTarget = Readonly<{
    key: string;
    displayLabel?: string;
    accentName?: string;
    recipient: ParticipantRecipientV1;
}>;

export type AgentTeamSessionSubagent = Readonly<{
    id: string;
    kind: 'agent_team_member';
    status: 'running' | 'terminated';
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

export type AgentTeamReadableSessionSubagent = Readonly<{
    id: string;
    kind: string;
    status: string;
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
    recipient: ParticipantRecipientV1 | null;
    capabilities: Readonly<{
        canOpen: boolean;
        canSend: boolean;
        canStop: boolean;
        canLaunchChild: boolean;
        canDelete: boolean;
        canOpenAdvancedRun: boolean;
    }>;
    timestamps?: Readonly<{
        startedAtMs?: number;
        updatedAtMs?: number;
        finishedAtMs?: number;
    }>;
}>;

export type AgentTeamSessionProviderBehavior = Readonly<{
    participants?: Readonly<{
        deriveSnapshot?: (ctx: Readonly<{
            flavor: string | null;
            messages: readonly AgentTeamMessage[];
        }>) => Readonly<Record<string, unknown>> | null;
        deriveSidechainIds?: (ctx: Readonly<{
            flavor: string | null;
            messages: readonly AgentTeamMessage[];
        }>) => readonly string[];
        deriveTargets?: (ctx: Readonly<{
            session: Readonly<{ metadata?: Record<string, unknown> | null }>;
            messages: readonly AgentTeamMessage[];
            currentTargets: readonly AgentTeamSessionParticipantTarget[];
        }>) => readonly AgentTeamSessionParticipantTarget[];
    }>;
    subagents?: Readonly<{
        deriveSubagents?: (ctx: Readonly<{
            flavor: string | null;
            messages: readonly AgentTeamMessage[];
        }>) => readonly AgentTeamSessionSubagent[];
        shouldIgnoreActivityPreviewText?: (ctx: Readonly<{
            subagent: AgentTeamReadableSessionSubagent;
            text: string;
        }>) => boolean;
        resolveAutoRecipient?: (ctx: AgentTeamSessionSubagentAutoRecipientContext) => ParticipantRecipientV1 | null;
    }>;
}>;

export type AgentTeamSessionSubagentAutoRecipientContext = Readonly<{
    session: Readonly<{ metadata?: Record<string, unknown> | null }>;
    tool: AgentTeamToolCall;
    messages: readonly AgentTeamMessage[];
    focusedMessages?: readonly AgentTeamMessage[];
    subagents: readonly AgentTeamReadableSessionSubagent[];
}>;
