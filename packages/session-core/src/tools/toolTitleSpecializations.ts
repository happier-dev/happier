import { readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readBundledAgentPresentation } from '@happier-dev/agents/presentation';
import type { ToolCall } from '../messages/index.js';
import { createSubagentToolPresenter } from './subagentToolPresentation.js';
import type { ToolTitleTranslator } from './toolTitleTranslations.js';

export function resolveDiffToolTitlePresentation(tool: ToolCall, translate: ToolTitleTranslator): Readonly<{ title: string; isTurnDiff: boolean }> {
    const isTurnDiff = readTurnChangeToolMetadataFromToolCall(tool) != null;
    return { isTurnDiff, title: translate(isTurnDiff ? 'tools.names.turnDiff' : 'tools.names.viewDiff') };
}

function agentName(id: string): string {
    return readBundledAgentPresentation(id)?.name ?? id.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[.\-_\s]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/** A published page has no authenticated catalog or Session model metadata. */
export function createPublishedSubagentToolPresenter(translate: ToolTitleTranslator) {
    return createSubagentToolPresenter({
        t: translate, getAgentCore: () => null, resolveAgentIdFromFlavor: () => null,
        formatAgentLikeIdForDisplay: agentName,
        resolveExecutionRunBackendLabel: target => {
            const ref = readBackendTargetRefV2(target);
            return ref.configuredBackendId ?? agentName(ref.backendId);
        },
        resolveExecutionRunTitle: () => 'Change summary',
        describeEffectiveModelMode: () => ({ appliedModelId: null }),
        resolveSessionModelLabel: (_id, _metadata, modelId) => modelId,
    });
}
