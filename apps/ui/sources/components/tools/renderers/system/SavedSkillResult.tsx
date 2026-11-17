import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SkillLibraryActionResultByIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { RestartSessionRunnerResultV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { HappierSavedSkillCard, HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX, resolveHappierWorkStatusGlyphColor,
    type HappierWorkStatusTone } from '@happier-dev/plugin-ui/presentation';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { renderWorkUpdateCardSurface, useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { useSkillMakers } from '@/components/settings/skills/useSkillMakers';
import { skillDisplayName, skillHref, useSkillsDestination } from '@/components/settings/skills/skillsCollectionModel';
import { sessionSkillApplyNotice, type SessionCapabilityApplyNoticeKey } from '@/components/sessions/capabilities/sessionCapabilityApplyNotice';
import { useSessionSkillApplicationFacts } from '@/sync/domains/capabilities/session/useSessionCapabilities';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

type SavedSkill = SkillLibraryActionResultByIdV1['skills.create'];
export { readSavedSkillResult } from './savedSkillResultModel';
import { readSavedSkillAttachFailure } from './savedSkillResultModel';

/** Decoration is carried by the acknowledgment; application is read from this Session's pushed metadata. */
export function SavedSkillResult(props: Readonly<{ fact: SavedSkill; sessionId?: string; serverId?: string }>) {
    const router = useRouter();
    const theme = useWorkTheme();
    const active = useActiveServerSnapshot(!props.serverId);
    const serverId = props.serverId ?? active.serverId;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const destination = useSkillsDestination(binding?.scope);
    const execution = useMountedActionExecution(binding?.scope);
    const facts = useSessionSkillApplicationFacts(props.sessionId ?? '', props.fact.skillId, serverId);
    const { running, machineId } = facts;
    const machine = useMachinePresenceSummary(serverId, machineId);
    const makerItems = React.useMemo(() => [{ creator: props.fact.summary?.creator }], [props.fact.summary?.creator]);
    const maker = useSkillMakers(makerItems, binding?.scope ?? null)(makerItems[0]!);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const name = skillDisplayName(props.fact.summary?.name, props.fact.skillId);
    const notice = props.sessionId ? sessionSkillApplyNotice({
        facts, title: name, sessionRunning: running === true, inclusion: props.fact.inclusion,
        applyTiming: facts.timing ? facts.timing === 'restart_to_apply'
            ? { t: facts.timing, restartBy: facts.timingRestartBy! } : { t: facts.timing }
            : props.fact.inclusion?.ok ? props.fact.inclusion.applyTiming : null,
        machineOnline: machine.reachability === 'unknown' ? null : machine.reachability === 'reachable',
        machineName: machine.sentenceName ?? machine.name ?? '', turnSettled: facts.turnSettled,
    }) : null;
    const knownNotAttached = facts.selected === false || facts.selected === null && props.fact.incomplete === 'session_include';
    const notAttached = Boolean(props.sessionId) && knownNotAttached && (!notice || notice.key === 'newSessionsOnly');
    const includedHere = Boolean(props.sessionId) && props.fact.includedInSessionId === props.sessionId;
    // The Bot that saved it when that is this session; otherwise the generic "This session".
    const user = maker.openSessionId && maker.openSessionId === props.sessionId ? maker.label : t('capabilities.session.thisSession');
    const state = savedSkillState(notice?.key ?? null, notice?.text ?? null, notAttached, user);
    const attach = async () => {
        setBusy(true); setError(null);
        try {
            if (!props.sessionId) return;
            const result = await execution.execute('session.capabilities.set', {
                sessionId: props.sessionId, kind: 'skill', id: props.fact.skillId, state: 'on',
            }, { defaultSessionId: props.sessionId });
            setError(readSavedSkillAttachFailure(result));
        } catch (failure) { setError(resolveActionExecutionErrorMessage(failure, t('capabilities.skills.saved.attachFailed'))); }
        finally { setBusy(false); }
    };
    const restart = async () => {
        if (!props.sessionId || !machineId) return;
        setBusy(true); setError(null);
        try {
            const result = await execution.execute('session.runtime.refresh', { sessionId: props.sessionId, machineId, serverId },
                { defaultSessionId: props.sessionId });
            const refreshed = result.ok ? RestartSessionRunnerResultV1Schema.safeParse(result.result) : null;
            if (!result.ok || !refreshed?.success || !refreshed.data.ok) setError(t('capabilities.session.restart.failed'));
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(false); }
    };
    const recovery = notAttached
        ? <RoundButton testID="saved-skill-attach" title={t('capabilities.skills.saved.attachAgain')} size="small" display="secondary"
            disabled={!execution.ready || busy} loading={busy} action={attach} />
        : notice?.restart && machineId ? <RoundButton testID="saved-skill-restart" title={t('capabilities.skills.saved.restartNow')}
            size="small" display="secondary" disabled={notice.restart !== 'enabled' || !execution.ready || busy} loading={busy} action={restart} /> : null;
    return <View style={styles.container}>
        <HappierSavedSkillCard testID="saved-skill-result" name={name} description={props.fact.summary?.description ?? null}
            savedLabel={t('capabilities.skills.saved.saved')}
            scopeLabel={includedHere ? t('capabilities.skills.saved.onlyUses', { name: user }) : undefined}
            status={state.word} statusDetail={state.detail ?? undefined} statusTone={state.tone}
            statusMark={<Icon name={state.icon} size={HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX} color={resolveHappierWorkStatusGlyphColor(state.tone, theme.colors)} />}
            theme={theme} host={WORK_HOST} renderSurface={renderWorkUpdateCardSurface}
            mark={<Icon name="lightbulb" size={HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX} color={theme.colors.secondaryText} />}
            viewControl={<RoundButton testID="saved-skill-view" title={destination.unavailableLabel ?? t('capabilities.skills.saved.view')} size="small" display="inverted"
                disabled={!destination.available}
                onPress={() => { if (destination.available) router.push(skillHref(props.fact.skillId)); }} />}
            recoveryControl={recovery} />
        {error ? <Text testID="saved-skill-error" variant="meta" style={styles.error}>{error}</Text> : null}
    </View>;
}

type SavedSkillState = Readonly<{ word: string; detail: string | null; tone: HappierWorkStatusTone;
    icon: 'check-circle' | 'circle' | 'arrow-clockwise' | 'warning-circle' }>;

/** The footer's one state line: a word and what it means, coloured only when the person must act. */
export function savedSkillState(key: SessionCapabilityApplyNoticeKey | null, text: string | null, notAttached: boolean, user: string): SavedSkillState {
    // A refusal names its own reason ("Applies to new sessions"); otherwise the plain consequence.
    if (notAttached) return { word: t('capabilities.skills.saved.notAttached'),
        detail: key === 'newSessionsOnly' && text ? text : t('capabilities.skills.saved.notAttachedDetail'), tone: 'danger', icon: 'warning-circle' };
    switch (key) {
        case 'addedNow': return { word: t('capabilities.skills.saved.liveNow'), detail: t('capabilities.skills.saved.liveNowDetail', { name: user }), tone: 'neutral', icon: 'check-circle' };
        case 'joinsNextTurn': case 'pendingNextTurn':
            return { word: t('capabilities.skills.saved.loadsAfterTurn'), detail: t('capabilities.skills.saved.loadsAfterTurnDetail'), tone: 'neutral', icon: 'circle' };
        case 'restart': return { word: t('capabilities.skills.saved.needsRestart'), detail: t('capabilities.skills.saved.restartDetail'), tone: 'attention', icon: 'arrow-clockwise' };
        case 'restartTerminal': return { word: t('capabilities.skills.saved.needsRestart'), detail: t('capabilities.skills.saved.restartTerminalDetail'), tone: 'attention', icon: 'arrow-clockwise' };
        case 'cannotResume': return { word: text ?? t('capabilities.skills.saved.saved'), detail: null, tone: 'danger', icon: 'warning-circle' };
        default: return { word: text ?? t('capabilities.skills.saved.saved'), detail: null, tone: 'neutral', icon: 'circle' };
    }
}

const styles = StyleSheet.create(theme => ({
    container: { gap: theme.space.s8 },
    error: { color: theme.colors.status.error },
}));
