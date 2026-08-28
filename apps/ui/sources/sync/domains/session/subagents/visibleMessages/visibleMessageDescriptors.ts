import type { Message } from '@/sync/domains/messages/messageTypes';
import type { AgentUiSessionDeclarationV1 } from '@happier-dev/protocol';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from '@/agents/registry/uiDescriptorDiagnostics';

import type { SessionSubagentVisibleMessagesResolver } from './types';

export type VisibleMessagesDescriptor = NonNullable<
    AgentUiSessionDeclarationV1['visibleMessages']
>;

export type VisibleMessagesDescriptorResult = Readonly<{
    resolveVisibleMessages: SessionSubagentVisibleMessagesResolver;
    diagnostics: readonly UiProjectionDiagnostic[];
}>;

type PluginUiVisibleMessagesDescriptor = Readonly<{
    kind: 'plugin.ui.v1';
    pluginId: string;
    agentId: string;
    version: number;
    session?: Readonly<{
        visibleMessages?: VisibleMessagesDescriptor;
    }>;
}>;

function readAgentText(message: Message): string | null {
    return message.kind === 'agent-text' ? readString(message.text) : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (isRecord(parsed)) return parsed;
        if (typeof parsed === 'string') {
            const reparsed = JSON.parse(parsed) as unknown;
            return isRecord(reparsed) ? reparsed : null;
        }
    } catch {
        return null;
    }
    return null;
}

function readJsonEventType(text: string): string | null {
    return readString(parseJsonObject(text)?.type);
}

function nullResolver(): ReturnType<SessionSubagentVisibleMessagesResolver> {
    return null;
}

function readVisibleMessagesDescriptor(
    value: unknown,
    diagnostics: UiProjectionDiagnostic[],
): VisibleMessagesDescriptor | null {
    if (!isRecord(value) || value.kind !== 'plugin.ui.v1') {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
            'kind',
            'Unsupported visible-message descriptor kind.',
        ));
        return null;
    }

    const pluginDescriptor = value as PluginUiVisibleMessagesDescriptor;
    const inlineDescriptor = pluginDescriptor.session?.visibleMessages;
    if (inlineDescriptor) {
        if (inlineDescriptor.kind === 'session.visibleMessages.v1') return inlineDescriptor;
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
            'session.visibleMessages.kind',
            'Unsupported visible-message descriptor kind.',
        ));
        return null;
    }

    return null;
}

export function createVisibleMessagesResolverFromDescriptor(value: unknown): VisibleMessagesDescriptorResult {
    const diagnostics: UiProjectionDiagnostic[] = [];
    const descriptor = readVisibleMessagesDescriptor(value, diagnostics);
    if (!descriptor) return { resolveVisibleMessages: nullResolver, diagnostics };

    const subagentKinds = new Set(readStringArray(descriptor.subagentKinds));
    const fallbackToolNames = new Set(readStringArray(descriptor.fallbackToolNames));
    const excludedEventTypes = new Set(readStringArray(descriptor.excludeJsonEventTypes));
    if (subagentKinds.size === 0 || excludedEventTypes.size === 0) {
        return { resolveVisibleMessages: nullResolver, diagnostics };
    }

    return {
        diagnostics,
        resolveVisibleMessages: ({ subagent, focusedMessages, tool }) => {
            const matchingSubagent = subagent ? subagentKinds.has(subagent.kind) : false;
            const matchingFallbackTool = fallbackToolNames.has(tool.name);
            if (!matchingSubagent && !matchingFallbackTool) return null;
            return focusedMessages.filter((message) => {
                const text = readAgentText(message);
                if (!text) return true;
                const eventType = readJsonEventType(text);
                return eventType === null || !excludedEventTypes.has(eventType);
            });
        },
    };
}
