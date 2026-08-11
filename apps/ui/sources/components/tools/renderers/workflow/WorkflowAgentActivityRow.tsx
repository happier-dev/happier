import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AgentActivityResultDetail } from '@/components/sessions/agentActivity/detail/AgentActivityResultDetail';
import { AgentActivityDisclosure } from '@/components/sessions/agentActivity/row/AgentActivityDisclosure';
import { resolveAgentActivityEntryFromWorkflowAgent } from '@/components/sessions/agentActivity/entry/fromWorkflowAgent';
import type { AgentActivityStaleness } from '@/components/sessions/agentActivity/presentation/agentActivityStaleness';
import type { WorkflowAgentRowViewModel } from '@/components/sessions/workState/sessionWorkflowActivityTypes';

import { WORKFLOW_AGENT_ROW_BLEED_PX, WORKFLOW_AGENT_ROW_DENSITY } from './workflowAgentRowDensity';

/**
 * One workflow agent, in the transcript card and in the work-state popover.
 *
 * **This is not a row implementation.** It is the host adapter both workflow surfaces share: it
 * projects a durable agent snapshot into the row's presentation contract, decides what the expanded
 * body contains, and hands both to the one shared row. It draws nothing itself — no glyph, no
 * status colour, no duration — which is what makes a workflow agent read identically to a subagent
 * in the Agents pane instead of through a second component with its own glyph table.
 *
 * `metaPlacement='inline'` is the load-bearing choice: the provider metrics take the row's
 * right-hand slot rather than a second line, so a dense card of six agents and a popover panel of
 * twenty-four keep the heights they had. Richness is preserved by *disclosure* — the summary or
 * result preview opens below the row — never by widening it.
 */

export type WorkflowAgentActivityRowProps = Readonly<{
    agent: WorkflowAgentRowViewModel;
    /**
     * How long this agent has been silent, resolved by the host from the surface's one clock.
     *
     * A prop rather than a subscription for the reason the row already documents: this component is
     * memoized, so a clock in here would re-render every agent in an expanded run on every tick
     * instead of the few whose note actually changed.
     */
    staleness?: AgentActivityStaleness;
    /**
     * The host's bounded transcript preview for this agent, when it has one.
     *
     * Built by the agent-activity surface through the one open-target resolver and handed down whole,
     * so this adapter never learns what a sidechain is: the host that has a roster passes a body, the
     * host that has only a durable record passes nothing. It WINS over the result summary because it
     * is the richer, live answer to the same question — and the summary keeps the body whenever no
     * transcript was imported, which is every run a released producer published.
     */
    preview?: React.ReactNode;
    showDivider?: boolean;
    testID?: string;
}>;

export const WorkflowAgentActivityRow = React.memo<WorkflowAgentActivityRowProps>((props) => {
    const { agent } = props;
    // Prefer the fuller narrative for the expanded body; the row itself stays compact.
    const detailText = agent.summary ?? agent.resultPreview;

    return (
        <View style={styles.bleed}>
            <AgentActivityDisclosure
                entry={resolveAgentActivityEntryFromWorkflowAgent(agent)}
                density={WORKFLOW_AGENT_ROW_DENSITY}
                metaPlacement="inline"
                staleness={props.staleness}
                showDivider={props.showDivider}
                testID={props.testID}
                {...(props.preview
                    ? { body: props.preview }
                    : detailText
                        ? {
                            body: (
                                <AgentActivityResultDetail
                                    text={detailText}
                                    {...(props.testID ? { detailTestID: `${props.testID}-detail` } : {})}
                                />
                            ),
                        }
                        : null)}
            />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    bleed: {
        // Applied per row rather than to the host's whole body: phase headers are interleaved with
        // these rows and belong on the host's own content edge, so bleeding the container would
        // drag them out of alignment with the run header instead of fixing the rows.
        marginHorizontal: WORKFLOW_AGENT_ROW_BLEED_PX,
    },
}));
WorkflowAgentActivityRow.displayName = 'WorkflowAgentActivityRow';
