import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { AgentUiSessionDeclarationV1 } from '@happier-dev/protocol';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from '@/agents/registry/uiDescriptorDiagnostics';

import type {
    SessionProviderBehavior,
    SessionProviderParticipantBehavior,
    SessionProviderSubagentBehavior,
} from './sessionProviderBehaviorTypes';
import { createAgentTeamSessionProviderBehavior } from './agent/team/behavior';
import type { AgentTeamSessionProviderDescriptor } from './agent/team/types';

export type SessionProviderBehaviorDescriptor = NonNullable<
    AgentUiSessionDeclarationV1['providerBehavior']
>;

export type SessionProviderBehaviorDescriptorResult = Readonly<{
    behavior: SessionProviderBehavior;
    diagnostics: readonly UiProjectionDiagnostic[];
}>;

type PluginUiSessionDescriptor = Readonly<{
    kind: 'plugin.ui.v1';
    pluginId: string;
    agentId: string;
    version: number;
    session?: Readonly<{
        providerBehavior?: SessionProviderBehaviorDescriptor;
    }>;
}>;

function isToolCallMessage(message: Message): message is ToolCallMessage {
    return message.kind === 'tool-call';
}

function readToolInputString(message: ToolCallMessage, inputKey: string): string | null {
    const input = isRecord(message.tool.input) ? message.tool.input : null;
    return readString(input?.[inputKey]);
}

function readJsonEventType(value: string): string | null {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!isRecord(parsed)) return null;
        return readString(parsed.type);
    } catch {
        return null;
    }
}

function readSessionProviderBehaviorDescriptor(
    value: unknown,
    diagnostics: UiProjectionDiagnostic[],
): SessionProviderBehaviorDescriptor | null {
    if (!isRecord(value) || value.kind !== 'plugin.ui.v1') {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
            'kind',
            'Unsupported session provider behavior descriptor kind.',
        ));
        return null;
    }

    const pluginDescriptor = value as PluginUiSessionDescriptor;
    const inlineDescriptor = pluginDescriptor.session?.providerBehavior;
    if (inlineDescriptor) {
        if (inlineDescriptor.kind === 'session.providerBehavior.v1') return inlineDescriptor;
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
            'session.providerBehavior.kind',
            'Unsupported session provider behavior descriptor kind.',
        ));
        return null;
    }

    return null;
}

function readAgentTeamDescriptor(
    value: unknown,
    diagnostics: UiProjectionDiagnostic[],
): AgentTeamSessionProviderDescriptor | null {
    if (!value) return null;
    if (!isRecord(value) || value.kind !== 'session.agentTeamBehavior.v1') {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
            'session.providerBehavior.agentTeam.kind',
            'Unsupported agent team behavior descriptor kind.',
        ));
        return null;
    }

    const tools = isRecord(value.tools) ? value.tools : null;
    const descriptor: AgentTeamSessionProviderDescriptor = {
        kind: 'session.agentTeamBehavior.v1',
        snapshotKey: readString(value.snapshotKey) ?? '',
        providerLabel: readString(value.providerLabel) ?? '',
        flavorAliases: readStringArray(value.flavorAliases),
        tools: {
            teamCreate: readStringArray(tools?.teamCreate),
            teamDelete: readStringArray(tools?.teamDelete),
            teamSendMessage: readStringArray(tools?.teamSendMessage),
            subagentSpawn: readStringArray(tools?.subagentSpawn),
            activeTeamFallbackSubagentSpawn: readStringArray(tools?.activeTeamFallbackSubagentSpawn),
            configMutation: readStringArray(tools?.configMutation),
        },
        ...(isRecord(value.configTeamPath)
            ? {
                configTeamPath: {
                    rootDirectory: readString(value.configTeamPath.rootDirectory) ?? '',
                    teamsDirectory: readString(value.configTeamPath.teamsDirectory) ?? '',
                    filename: readString(value.configTeamPath.filename) ?? '',
                },
            }
            : {}),
        ...(isRecord(value.lifecycleEvents)
            ? {
                lifecycleEvents: {
                    ignoreActivityPreview: readStringArray(value.lifecycleEvents.ignoreActivityPreview),
                    shutdownApproved: readString(value.lifecycleEvents.shutdownApproved) ?? undefined,
                },
            }
            : {}),
    };

    if (
        !descriptor.snapshotKey
        || !descriptor.providerLabel
        || descriptor.flavorAliases.length === 0
        || descriptor.tools.teamCreate.length === 0
        || descriptor.tools.teamDelete.length === 0
        || descriptor.tools.teamSendMessage.length === 0
        || descriptor.tools.subagentSpawn.length === 0
    ) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'session.providerBehavior.agentTeam',
            'Agent team behavior descriptor is missing required fields.',
        ));
        return null;
    }

    return descriptor;
}

export function createSessionProviderBehaviorFromDescriptor(value: unknown): SessionProviderBehaviorDescriptorResult {
    const diagnostics: UiProjectionDiagnostic[] = [];
    const descriptor = readSessionProviderBehaviorDescriptor(value, diagnostics);
    if (!descriptor) {
        return { behavior: {}, diagnostics };
    }

    const sidechainIds = descriptor.participants?.sidechainIds;
    const previewText = descriptor.subagents?.ignoreActivityPreviewText;
    const agentTeamDescriptor = readAgentTeamDescriptor(descriptor.agentTeam, diagnostics);
    const agentTeamBehavior = agentTeamDescriptor ? createAgentTeamSessionProviderBehavior(agentTeamDescriptor) : {};
    let participants: SessionProviderParticipantBehavior | undefined = agentTeamBehavior.participants;
    let subagents: SessionProviderSubagentBehavior | undefined = agentTeamBehavior.subagents;

    if (sidechainIds?.kind === 'toolCallInputString') {
        const toolNames = new Set(readStringArray(sidechainIds.toolNames));
        const inputKey = readString(sidechainIds.inputKey);
        if (toolNames.size > 0 && inputKey) {
            participants = {
                ...(participants ?? {}),
                deriveSidechainIds: ({ messages }) => {
                    const ids = new Set<string>();
                    for (const message of messages) {
                        if (!isToolCallMessage(message)) continue;
                        if (!toolNames.has(message.tool.name)) continue;
                        const id = readToolInputString(message, inputKey);
                        if (id) ids.add(id);
                    }
                    return [...ids];
                },
            };
        }
    } else if (sidechainIds) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            'participants.sidechainIds',
            `Unsupported sidechain id descriptor kind '${String((sidechainIds as unknown as { kind?: unknown }).kind)}'.`,
        ));
    }

    if (previewText?.kind === 'jsonEventType') {
        const recipientKinds = new Set(readStringArray(previewText.recipientKinds));
        const eventTypes = new Set(readStringArray(previewText.eventTypes));
        if (recipientKinds.size > 0 && eventTypes.size > 0) {
            subagents = {
                ...(subagents ?? {}),
                shouldIgnoreActivityPreviewText: ({ subagent, text }) => {
                    if (!recipientKinds.has(subagent.kind)) return false;
                    const eventType = readJsonEventType(text);
                    return eventType !== null && eventTypes.has(eventType);
                },
            };
        }
    } else if (previewText) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            'subagents.ignoreActivityPreviewText',
            `Unsupported preview text descriptor kind '${String((previewText as unknown as { kind?: unknown }).kind)}'.`,
        ));
    }

    return {
        behavior: {
            ...(participants ? { participants } : {}),
            ...(subagents ? { subagents } : {}),
        },
        diagnostics,
    };
}
