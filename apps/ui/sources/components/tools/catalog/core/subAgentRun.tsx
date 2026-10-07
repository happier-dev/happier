import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { ICON_TASK } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { SubAgentRunInputV2Schema } from '@happier-dev/protocol/tools/v2/schemas';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveSubagentToolPresentation } from './subAgentPresentation';

export const coreSubAgentRunTools = {
    SubAgentRun: {
        title: (opts: { metadata: Metadata | null; tool: ToolCall }) => resolveSubagentToolPresentation(opts).title,
        icon: (size: number, color: string, opts?: { metadata: Metadata | null; tool: ToolCall }) => {
            const agentId = opts ? resolveSubagentToolPresentation(opts).iconAgentId : null;
            return agentId ? <AgentIcon agentId={agentId} size={size} /> : ICON_TASK(size, color);
        },
        isMutable: true,
        extractSubtitle: (opts: { metadata: Metadata | null; tool: ToolCall }) => {
            const input = opts.tool.input as any;
            const rawLabel = typeof input?.label === 'string' ? input.label : null;
            const label = rawLabel ? rawLabel.trim() : '';
            if (label) return label;

            const desc = typeof opts.tool.description === 'string' ? opts.tool.description.trim() : '';
            if (desc) return desc;

            const summary = typeof (opts.tool.result as any)?.summary === 'string' ? String((opts.tool.result as any).summary).trim() : '';
            if (summary) return summary;

            const intent = typeof input?.intent === 'string' ? input.intent.trim() : '';
            const backendId = typeof input?.backendId === 'string' ? input.backendId.trim() : '';
            if (intent && backendId) return `${intent} · ${backendId}`;
            if (intent) return intent;
            if (backendId) return backendId;

            return null;
        },
        input: SubAgentRunInputV2Schema,
    },
} satisfies Record<string, KnownToolDefinition>;
