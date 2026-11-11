import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands, type CurrentUiContextCommandInvocation,
    type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { skillHref, useSkillsDestination } from '@/components/settings/skills/skillsCollectionModel';
import { useSkillMakers } from '@/components/settings/skills/useSkillMakers';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { Text } from '@/components/ui/text/Text';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { executeSessionLifecycleAction } from '@/components/sessions/actions/sessionActionExecution';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

import { SessionCapabilitiesContent, sessionCapabilityRowRemovalState, type SessionCapabilitiesChange, type SessionCapabilitiesUndo } from './SessionCapabilitiesContent';
import { buildSessionCapabilitiesModel } from './sessionCapabilitiesModel';
import { CLOSED_DETAIL, useSessionCapabilitiesDetail } from './useSessionCapabilitiesDetail';
import { useExistingSessionCapabilitiesPopover } from './useSessionCapabilitiesPopover';
import { useSessionCapabilityRestart } from './sessionCapabilityRestart';

/** The Session destination borrows the composer's capability owner and its existing Actions. */
export function SessionSkillsPane(props: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const serverId = props.serverId ?? null;
    const router = useRouter();
    const session = useSessionViewShellSession(props.sessionId, serverId);
    const status = useSessionStatus(session, { subscribeToSession: false, subscribeToTranscript: false });
    const turnSettled = !status?.awareness.operational.reasons.some(reason =>
        reason === 'working' || reason === 'permission_required' || reason === 'action_required');
    const identity = useSessionMachineDisplayIdentity(props.sessionId, serverId);
    const presence = useMachinePresenceSummary(serverId, identity.machineId);
    const machineOnline = presence.reachability === 'unknown' ? null : presence.reachability === 'reachable';
    const machineName = presence.sentenceName ?? presence.name ?? t('common.machine');
    const presentation = React.useMemo(() => ({ ...CLOSED_DETAIL, machineName, machineOnline, turnSettled }), [machineName, machineOnline, turnSettled]);
    const owner = useExistingSessionCapabilitiesPopover({ kind: 'session', sessionId: props.sessionId, serverId,
        readOnly: session?.access?.capabilities.submitAgentInput !== true }, presentation);
    const demand = React.useRef(owner.demandPreview);
    demand.current = owner.demandPreview;
    React.useEffect(() => { demand.current(); }, [props.sessionId, serverId]);
    const onRetry = React.useCallback((factsKey?: string) => { void owner.refresh(factsKey); }, [owner.refresh]);
    const target = React.useMemo(() => ({ sessionId: props.sessionId, metadata: owner.metadata }), [props.sessionId, owner.metadata]);
    const skillIds = React.useMemo(() => owner.model.groups.flatMap(group => group.kind === 'skills'
        ? group.rows.map(row => row.id) : []), [owner.model.groups]);
    const selectedDemand = React.useMemo(() => ({ skillIds, enabled: owner.modelInput.view !== null }), [skillIds, owner.modelInput.view]);
    const { detail, library } = useSessionCapabilitiesDetail(serverId, machineOnline, onRetry, target, owner.modelInput,
        machineName, undefined, selectedDemand);
    const makers = useSkillMakers(library.items, library.scope);
    const skills = React.useMemo(() => new Map(library.items.map(item => [item.skillId, item])), [library.items]);
    const destination = useSkillsDestination(library.scope);
    const openSkill = React.useCallback((id: string) => {
        if (destination.available) router.push(skillHref(id) as never);
    }, [router, destination.available]);
    const openMaker = React.useCallback((sessionId: string) => {
        if (library.scope) router.push(buildScopedSessionRouteHref({ serverId: library.scope.serverId, sessionId }) as never);
    }, [router, library.scope]);
    const skillDetails = React.useCallback((id: string) => {
        const item = skills.get(id);
        const maker = item ? makers(item) : null;
        const makerSessionId = maker?.openSessionId;
        return { description: item?.description, onPress: destination.available ? () => openSkill(id) : undefined,
            mark: maker?.face ? <SessionBotFace facts={maker.face} size={20} motion={false} /> : undefined,
            note: <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                {maker ? <Text variant="meta" style={styles.quiet}>{maker.label}</Text> : null}
                <TextLinkButton size="meta" label={destination.unavailableLabel ?? t('capabilities.skills.saved.view')}
                    disabled={!destination.available} onPress={() => openSkill(id)} />
                {makerSessionId ? <TextLinkButton size="meta" label={t('capabilities.skills.maker.openSession')}
                    onPress={() => openMaker(makerSessionId)} /> : null}
            </View> };
    }, [skills, makers, openSkill, openMaker, destination.available, destination.unavailableLabel]);
    const skillSection = React.useCallback((id: string) => {
        const item = skills.get(id);
        const maker = item ? makers(item) : null;
        if (maker?.kind === 'bot' && maker.openSessionId === props.sessionId) return { key: 'this-session', title: t('capabilities.skills.pane.thisBot'), order: 0 };
        if (maker?.kind === 'you') return { key: 'yours', title: t('capabilities.skills.pane.yours'), order: 1 };
        if (maker?.kind === 'registry') return { key: 'registries', title: t('capabilities.skills.pane.registries'), order: 2 };
        return { key: 'other', title: t('capabilities.skills.pane.other'), order: 3 };
    }, [skills, makers, props.sessionId]);
    const model = React.useMemo(() => buildSessionCapabilitiesModel({ ...presentation, ...detail, ...owner.modelInput }),
        [presentation, detail, owner.modelInput]);
    const execution = useMountedActionExecution(library.scope);
    const stop = React.useCallback(async (invocation?: CurrentUiContextCommandInvocation) => (await executeSessionLifecycleAction('session.stop', props.sessionId,
        { serverId, stopIntent: 'lifecycle_control', ...(invocation ? { mountedCommand: { invocation, engine: execution } } : {}) })).success,
    [execution.execute, execution.executeForCaller, execution.binding, props.sessionId, serverId]);
    const resume = React.useCallback(async (invocation?: CurrentUiContextCommandInvocation) => {
        const input = { sessionId: props.sessionId, serverId, intent: 'resume' };
        const result = await (invocation ? invocation.execute(execution, 'session.open', input) : execution.execute('session.open', input));
        return result.ok && typeof result.result === 'object' && result.result !== null
            && 'status' in result.result && result.result.status === 'opened';
    }, [execution.execute, execution.executeForCaller, execution.binding, props.sessionId, serverId]);
    const restart = useSessionCapabilityRestart({ notice: model.applyNotice, stop, resume });
    const reportFailure = React.useCallback((result: Readonly<{ ok: boolean; message?: string }>) => {
        if (!result.ok && result.message !== 'read_only') publishPresentationNotice({ key: `session-capabilities:${props.sessionId}`,
            message: t('capabilities.control.changeFailed'), severity: 'error' });
    }, [props.sessionId]);
    const onChange = React.useCallback(async (change: Parameters<SessionCapabilitiesChange>[0], invocation?: CurrentUiContextCommandInvocation) => {
        const result = await owner.setItem(change.kind, change.id, change.state, undefined, invocation);
        reportFailure(result);
        return result;
    }, [owner.setItem, reportFailure]);
    const undo = React.useMemo<SessionCapabilitiesUndo | null>(() => owner.undoReceipt ? {
        ...owner.undoReceipt, onUndo: () => { void owner.undoLast().then(reportFailure); },
    } : null, [owner.undoReceipt, owner.undoLast, reportFailure]);
    const onOpen = React.useCallback(() => {
        if (destination.available) router.push(SETTINGS_ROUTES.skills as never);
    }, [router, destination.available]);
    const [adding, setAdding] = React.useState(false);
    const commands = React.useMemo<readonly CurrentUiContextLocalCommand[]>(() => [
        { key: 'session.skills.add', title: t('capabilities.session.sheet.add'), invoke: () => setAdding(true) },
        ...(destination.available ? [{ key: 'session.skills.browse', title: t('capabilities.skills.pane.allSkills'), invoke: onOpen }] : []),
        { key: 'session.skills.retry', title: t('capabilities.status.fix.tryAgain'), invoke: () => onRetry() },
        ...(undo ? [{ key: 'session.skills.undo', title: t('common.undo'), invoke: async (_input, _context, invocation) => {
            reportFailure(await owner.undoLast(invocation));
        } }] satisfies CurrentUiContextLocalCommand[] : []),
        ...(restart.badge?.onPress ? [{ key: 'session.skills.restart', title: t('capabilities.skills.saved.restartNow'),
            invoke: async (_input, _context, invocation) => { await restart.restart(invocation); } }] satisfies CurrentUiContextLocalCommand[] : []),
        ...model.groups.flatMap(group => group.kind === 'skills' ? group.rows.flatMap(row => {
            const removalState = sessionCapabilityRowRemovalState(row);
            const rowAction = row.action;
            const item = skills.get(row.id);
            const makerSessionId = item ? makers(item).openSessionId : null;
            return [
            ...(destination.available ? [{ key: `session.skills.view:${row.id}`, title: row.title, invoke: () => openSkill(row.id) }] : []),
            ...(makerSessionId ? [{ key: `session.skills.maker:${row.id}`, title: t('capabilities.skills.maker.openSession'),
                invoke: () => openMaker(makerSessionId) }] : []),
            ...(rowAction.kind === 'turn_on' ? [{ key: `session.skills.turn-on:${row.id}`,
                title: t('capabilities.session.sheet.turnOnLabel', { item: row.title }),
                invoke: async (_input, _context, invocation) => { await onChange({ kind: 'skill', id: row.id, state: rowAction.state }, invocation); } }] satisfies CurrentUiContextLocalCommand[] : []),
            ...(removalState !== null ? [{ key: `session.skills.remove:${row.id}`,
                title: t('capabilities.session.sheet.removeLabel', { item: row.title }),
                invoke: async (_input, _context, invocation) => { await onChange({ kind: 'skill', id: row.id, state: removalState }, invocation); } }] satisfies CurrentUiContextLocalCommand[] : []),
            ];
        }) : []),
    ], [onOpen, onRetry, undo, owner.undoLast, reportFailure, restart.badge, restart.restart, model.groups, skills, makers, openSkill, openMaker, onChange, destination.available]);
    useCurrentUiContextLocalCommands(commands);
    return <View style={{ flex: 1, minHeight: 0 }}>
        <SessionCapabilitiesContent kind="skills" model={model} onChange={onChange} undo={undo}
            skillDetails={skillDetails} skillSection={skillSection} adding={adding} onAddingChange={setAdding}
            onRetry={onRetry} onOpen={onOpen} openUnavailableReason={destination.unavailableLabel}
            machineName={machineName} testID="session-skills" />
        {restart.badge ? <View testID="session-skills:apply">
            <Text variant="meta" style={styles.quiet}>{restart.badge.label}</Text>
            {restart.badge.onPress ? <TextLinkButton label={t('capabilities.skills.saved.restartNow')} onPress={restart.badge.onPress} /> : null}
        </View> : null}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    quiet: { color: theme.colors.text.secondary },
}));
