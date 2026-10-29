import type { ToolCall } from '../messages/index.js';
import { defaultToolTitleCatalog } from './toolTitleCatalog.js';
import { inferToolNameForRendering } from './toolNameInference.js';
import { resolveToolDisplayTitle, resolveMcpToolTitle } from './toolDisplayTitle.js';
import { defaultToolTitleTranslation } from './toolTitleTranslations.js';
import { resolveToolStatusIndicatorKind, type DeclinedApprovalDisposition, type ToolStatusIndicatorKind } from './toolStatusIndicatorKind.js';

const knownToolKeys = Object.keys(defaultToolTitleCatalog);

export type ToolRowPresentation = Readonly<{ title: string; statusKind: ToolStatusIndicatorKind }>;

/** Pure presentation of a normalized transcript tool call. */
export function resolveToolRowPresentation(tool: ToolCall, declinedApproval: DeclinedApprovalDisposition | null = null): ToolRowPresentation {
    const inferred = inferToolNameForRendering({ toolName: tool.name, toolInput: tool.input,
        toolDescription: tool.description, knownToolKeys });
    const definition = defaultToolTitleCatalog[inferred.normalizedToolName as keyof typeof defaultToolTitleCatalog];
    const title = tool.name.startsWith('mcp__') ? resolveMcpToolTitle(tool.name, tool.permission?.mcpTool)
        : resolveToolDisplayTitle({ tool, normalizedToolName: inferred.normalizedToolName,
            usedInferenceFallback: inferred.source !== 'original' && inferred.normalizedToolName !== tool.name,
            knownTitle: definition?.({ tool, metadata: null }),
            unknownTitle: defaultToolTitleTranslation('tools.common.unknownToolTitle') });
    return { title, statusKind: resolveToolStatusIndicatorKind(tool, declinedApproval) };
}
