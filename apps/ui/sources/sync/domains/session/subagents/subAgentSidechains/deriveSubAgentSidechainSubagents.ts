import type { Message } from '@happier-dev/session-core/messages';
import { deriveSubAgentSidechainSubagents as deriveChildren, type SessionSubagent } from '@happier-dev/session-core/transcript';

import { resolveSubAgentSidechainProviderLabel } from './resolveSubAgentSidechainProviderLabel';

export function deriveSubAgentSidechainSubagents(params: Readonly<{
    messages: readonly Message[];
    flavor?: string | null;
    excludedSidechainIds?: ReadonlySet<string>;
}>): readonly SessionSubagent[] {
    return deriveChildren({
        messages: params.messages,
        excludedSidechainIds: params.excludedSidechainIds,
        providerLabel: resolveSubAgentSidechainProviderLabel(params.flavor),
    });
}
