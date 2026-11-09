import * as React from 'react';
import { readHappierActionToolResultCandidates } from '@happier-dev/protocol/actions/happierActionToolResult';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { readAcknowledgedActionResult, type AcknowledgedActionResult } from '@/components/approvals/actionResultFacts';
import { readHappierActionCallId } from '@/components/sessions/transcript/references/happierActionToolResult';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { executeAcknowledgedActionInverse } from '@/sync/ops/actions/executeAcknowledgedActionInverse';
import { useSessionOrganizationProjection } from '@/sync/store/hooks';
import { t } from '@/text';

import { useToolHeaderActions } from '../../shell/presentation/ToolHeaderActionsContext';

/** A completed `session.section.set` call's committed result, read only from its strict acknowledged shape. */
export function readSessionSectionMoveFact(tool: ToolCall): AcknowledgedActionResult | null {
    if (tool.state !== 'completed') return null;
    const actionId = readHappierActionCallId(tool.name, tool.input);
    if (actionId !== 'session.section.set') return null;
    for (const candidate of readHappierActionToolResultCandidates(tool.result, tool.input)) {
        const fact = readAcknowledgedActionResult({ actionId, result: candidate });
        if (fact) return fact;
    }
    return null;
}

/**
 * An agent's committed section move in words (lab `clsections:agent`): "Moved this session to Launch 0.3", with
 * Undo on the row header when the Home that holds it is bound. Undo re-checks membership on activation and runs
 * the captured inverse through the ordinary Action path; a move made since is kept and explained.
 */
export function SessionSectionMoveResult(props: Readonly<{ fact: AcknowledgedActionResult; serverId?: string | null }>) {
    const { theme } = useUnistyles();
    const serverId = props.serverId ?? null;
    const projection = useSessionOrganizationProjection(serverId);
    const sectionId = props.fact.sectionId;
    const display = sectionId ? projection?.foldersById[sectionId]?.displayState ?? null : null;
    const value = display?.status === 'available' ? display.value as Readonly<{ name?: unknown }> | null : null;
    const sectionName = typeof value?.name === 'string' && value.name.trim() ? value.name : t('common.unavailable');
    const resolution = useServerCredentialAccountScopeResolution(serverId);
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const [phase, setPhase] = React.useState<'idle' | 'busy' | 'undone'>('idle');
    const fact = props.fact;
    const undo = React.useCallback(async () => {
        if (!scope) return;
        setPhase('busy');
        const result = await executeAcknowledgedActionInverse(fact, scope).catch(() => null);
        if (result?.ok) { setPhase('undone'); return; }
        setPhase('idle');
        Modal.alert(t('sessionsList.sectionMoveUndoFailed'), result?.errorCode === 'section_membership_changed'
            ? t('sessionsList.sectionMoveChangedSince') : result?.error ?? t('errors.unknownError'));
    }, [fact, scope]);
    const headerAction = React.useMemo(() => fact.inverse && scope && phase !== 'undone' ? (
        <RoundButton size="mini" display="secondary" title={t('sessionsList.sectionMoveUndo')}
            leading={<Icon name="arrow-arc-left" size={13} color={theme.colors.text.secondary} />}
            loading={phase === 'busy'} disabled={phase === 'busy'} onPress={() => { void undo(); }}
            testID="session-section-move-undo" />
    ) : null, [fact.inverse, phase, scope, theme.colors.text.secondary, undo]);
    useToolHeaderActions(headerAction);
    return (
        <Text variant="body" style={styles.line} testID="session-section-move-result">
            {sectionId ? t('sessionsList.sectionMovedTo', { section: sectionName }) : t('sessionsList.sectionMovedBack')}
            {phase === 'undone' ? <Text variant="body" style={styles.undone}>{` · ${t('sessionsList.sectionMoveUndone')}`}</Text> : null}
        </Text>
    );
}

const styles = StyleSheet.create((theme) => ({
    line: { color: theme.colors.text.secondary },
    undone: { color: theme.colors.text.tertiary },
}));
