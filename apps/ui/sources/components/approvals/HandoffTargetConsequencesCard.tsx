import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HandoffWorkspaceActionV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';

import { Text } from '@/components/ui/text/Text';
import { SessionContextChips } from '@/components/sessions/context/SessionContextChips';
import { t } from '@/text';
import {
    resolveWorkspaceSyncModeTranslationKey,
    type WorkspaceSyncModeTranslationKey,
} from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import type { ApprovalEndpointLabels } from './approvalEndpointLabels';

export type HandoffTargetApprovalPresentation = {
    source: ApprovalEndpointLabels;
    destination: ApprovalEndpointLabels;
    modeText: string | null;
    consequenceLines: readonly { key: string; text: string }[];
    decisionLabel: string;
};

/**
 * The selected workspace behavior lives inside the already-persisted Action
 * arguments, so the confirmation reads it from there rather than asking the
 * caller to re-derive it. An unparseable or unrelated shape yields no mode row
 * instead of a guessed label.
 */
function readHandoffWorkspaceActionModeKey(actionArgs: unknown): WorkspaceSyncModeTranslationKey | null {
    if (typeof actionArgs !== 'object' || actionArgs === null) return null;
    // Boundary read into persisted Action arguments; validated by the schema below.
    const workspaceAction = (actionArgs as { workspaceAction?: unknown }).workspaceAction;
    const parsed = HandoffWorkspaceActionV1Schema.safeParse(workspaceAction);
    if (!parsed.success) return null;
    if (parsed.data.kind === 'create_relationship') {
        return resolveWorkspaceSyncModeTranslationKey(parsed.data.mode);
    }
    if (parsed.data.kind === 'copy_once') {
        return resolveWorkspaceSyncModeTranslationKey('copy_once');
    }
    return null;
}

/**
 * One reading of the destination proof, shared by the confirmation card and the
 * decision control so the consequence never gets interpreted twice. Exact
 * mirroring deletes destination-only files, so it replaces the generic approve
 * label with what the person is actually authorizing.
 */
export function describeHandoffTargetApproval(input: Readonly<{
    approval: HandoffTargetReplacementApprovalV1;
    actionArgs: unknown;
    source: ApprovalEndpointLabels;
    destination: ApprovalEndpointLabels;
}>): HandoffTargetApprovalPresentation {
    const machine = input.destination.machineLabel ?? input.approval.machineId;
    const path = input.destination.pathLabel ?? input.approval.canonicalRoot;
    const mirrorsExactly = input.approval.consequences.includes('delete_target_only_files_during_exact_mirror');
    const modeKey = readHandoffWorkspaceActionModeKey(input.actionArgs);

    return {
        source: input.source,
        destination: input.destination,
        modeText: modeKey ? t(modeKey) : null,
        consequenceLines: input.approval.consequences.map((consequence) => ({
            key: consequence,
            text: consequence === 'replace_nonempty_workspace_target'
                ? t('sessionHandoff.targetApproval.replaceTarget', { machine, path })
                : t('sessionHandoff.targetApproval.exactMirror', { machine, path }),
        })),
        decisionLabel: mirrorsExactly
            ? t('sessionHandoff.targetApproval.decision.mirrorAndAllowRemovals')
            : t('sessionHandoff.targetApproval.decision.replaceDestination'),
    };
}

/**
 * The destructive consequences the target daemon observed for this exact
 * destination, named together with both endpoints of the move. They travel as
 * approval subject data, so the person deciding sees what the daemon will
 * actually do rather than a generic action title.
 */
export const HandoffTargetConsequencesCard = React.memo(function HandoffTargetConsequencesCard(props: Readonly<{
    presentation: HandoffTargetApprovalPresentation;
}>) {
    return (
        <View style={styles.card} testID="approvals.handoff-target-consequences">
            <View style={styles.rows}>
                <View style={styles.endpoint}>
                    <Text style={styles.endpointLabel}>{t('sessionHandoff.targetApproval.sourceLabel')}</Text>
                    <SessionContextChips
                        machineLabel={props.presentation.source.machineLabel}
                        pathLabel={props.presentation.source.pathLabel}
                    />
                </View>
                <View style={styles.endpoint}>
                    <Text style={styles.endpointLabel}>{t('sessionHandoff.targetApproval.destinationLabel')}</Text>
                    <SessionContextChips
                        machineLabel={props.presentation.destination.machineLabel}
                        pathLabel={props.presentation.destination.pathLabel}
                    />
                </View>
            </View>
            {props.presentation.modeText ? (
                <View style={styles.endpoint}>
                    <Text style={styles.endpointLabel}>{t('sessionHandoff.targetApproval.modeLabel')}</Text>
                    <Text style={styles.value}>{props.presentation.modeText}</Text>
                </View>
            ) : null}
            <View style={styles.rows}>
                {props.presentation.consequenceLines.map((line) => (
                    <Text key={line.key} style={styles.value}>{line.text}</Text>
                ))}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // Sheet content of the approval page section titled "What happens at the destination".
    card: {
        gap: 12,
    },
    rows: {
        gap: 8,
    },
    endpoint: {
        gap: 6,
    },
    endpointLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    value: {
        fontSize: 14,
        color: theme.colors.text.primary,
    },
}));
