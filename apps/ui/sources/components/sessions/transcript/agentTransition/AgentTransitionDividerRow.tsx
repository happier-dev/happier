import * as React from 'react';

import type { SessionAgentTransitionDividerV1 } from '@happier-dev/protocol';

import { getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { t } from '@/text';

/**
 * The Agent an id names, as a reader would recognize it.
 *
 * A divider is durable and its ids outlive the catalog: a Session switched to an
 * Agent that has since been removed still has to render truthfully. The raw id
 * is a worse label than a display name but a far better one than nothing, so an
 * unknown id degrades to itself rather than to "Unknown".
 */
function resolveAgentLabel(agentId: string): string {
    return isAgentId(agentId) ? t(getAgentCore(agentId).displayNameKey) : agentId;
}

/**
 * The boundary where this Session changed Agent.
 *
 * The divider is stored as an ordinary `type:'message'` agent event so that a
 * reader which predates the feature still shows something truthful. A reader
 * that understands the sidecar owes the user more than that prose: this is a
 * structural boundary in the conversation, and the transcript already has one
 * treatment for structural boundaries. It reuses that treatment — the same rule
 * the fork-lineage divider follows — rather than adding a second one.
 */
export function AgentTransitionDividerRow(props: Readonly<{
    divider: SessionAgentTransitionDividerV1;
}>): React.ReactElement {
    const from = resolveAgentLabel(props.divider.fromAgentId);
    const to = resolveAgentLabel(props.divider.toAgentId);

    return (
        <TranscriptSeparatorRow
            testID="transcript-agent-transition-divider"
            titleTestID="transcript-agent-transition-divider-title"
            iconName="arrows-left-right"
            title={t('session.agentContinuation.dividerTitle', { from, to })}
        />
    );
}
