import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ConnectedServiceSessionSelection } from '@happier-dev/agents';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { buildNewSessionConnectedServicesSelectionListModel, createConnectServiceOptionId } from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';

import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import { SetupSteps, setupStepTestID, type SetupStep, type SetupStepState } from '@/components/ui/setupBlocks/SetupSteps';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { presentAgentInstallJobFailure } from '@/agents/machineAgents/installJobs/presentAgentInstallJobFailure';
import { AGENT_INSTALL_JOB_VERIFY_STEP_ID, buildAgentInstallJobCliStepId } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { isMachineAgentInstalledBySetup, resolveAgentSetupPhase, type AgentSetupPhase } from './machineAgentPresentation';

/** Exact choices from the connected-account chooser, or the Agent's own login. */
export type AgentSignInChoice = Readonly<{ kind: 'service'; serviceId: string; option: SelectionListOption }> | Readonly<{ kind: 'native' }>;

export type AgentSetupFormHandlers = Readonly<{
    onInstall: () => void;
    onCancelInstall: () => void;
    onRetry: () => void;
    onCheckAgain: () => void;
    onOpenGuide: (url: string) => void;
    onUseService: (serviceId: string, selection: ConnectedServiceSessionSelection & { source: 'connected' }) => void;
    onConnectService: (serviceId: string) => void;
    onOpenNativeSignIn: () => void;
    onShowTerminal: () => void;
    onCancelSignIn: () => void;
    /** Ready: start a session with this agent here (omitted where the surface has its own next step). */
    onStartSession?: () => void;
    onSetUpAnother?: () => void;
}>;

export type AgentSetupFormViewProps = Readonly<{
    agent: MachineAgent;
    machineName: string;
    /** `full`: the machine's Agents section and Settings → Agents. `compact`: the engine popover and Home. */
    layout: 'full' | 'compact';
    session?: MachineAgentSignInSession | null;
    handlers: AgentSetupFormHandlers;
    testID: string;
}>;

// A choice's description (account, reach) needs this much to read whole; narrower panels list the choices one per line.
const SIGN_IN_TILE_MIN_WIDTH = 200;

/** Reuse the chooser's account/pool rows and availability; setup only adapts their actions. */
export function resolveAgentSignInChoices(agent: MachineAgent, handlers: AgentSetupFormHandlers): readonly AgentSignInChoice[] {
    const services = agent.signIn.connectedServices.flatMap((service): AgentSignInChoice[] => {
        const model = buildNewSessionConnectedServicesSelectionListModel({
            supportedServiceIds: [service.serviceId],
            profileOptionsByServiceId: { [service.serviceId]: (service.profiles ?? []).filter(profile => profile.healthy).map(profile => ({
                profileId: profile.profileId, label: profile.profileLabel, providerEmail: profile.providerEmail, status: 'connected',
            })) },
            groupOptionsByServiceId: { [service.serviceId]: [...service.groups ?? []] },
            bindingsByServiceId: {}, includeNativeAuthOption: false, allowDefaultProfileFallback: false,
            setBindingForService: (serviceId, binding) => {
                if (binding.source === 'connected') handlers.onUseService(serviceId, binding);
            },
            onOpenSettings: handlers.onConnectService,
            translate: t, resolveServiceTitle: () => service.title,
            renderRowIcon: () => null, renderBrowseMark: () => null, renderSettingsIcon: () => null,
        });
        return model.rootStep.sections.flatMap(section => section.kind === 'static'
            ? section.options.map(option => ({ kind: 'service' as const, serviceId: service.serviceId, option })) : []);
    });
    return agent.signIn.nativeLogin === 'terminal' ? [...services, { kind: 'native' }] : services;
}

function choiceKey(choice: AgentSignInChoice): string {
    return choice.kind === 'native' ? 'native' : choice.option.id;
}

type JobStep = NonNullable<MachineAgent['job']>['steps'][number];

function stepState(step: JobStep | undefined): SetupStepState {
    return step?.state === 'running' || step?.state === 'done' || step?.state === 'failed' ? step.state : 'upcoming';
}

function aggregateState(steps: readonly JobStep[]): SetupStepState {
    if (steps.some((step) => step.state === 'failed')) return 'failed';
    if (steps.some((step) => step.state === 'running')) return 'running';
    return steps.length > 0 && steps.every((step) => step.state === 'done') ? 'done' : 'upcoming';
}

function bytesDetail(step: JobStep | undefined): string | null {
    return step?.state === 'running' && step.bytesDone !== null && step.bytesTotal
        ? t('machineAgents.progress', { done: formatHappierDataBytes(step.bytesDone, { kind: 'storage' }), total: formatHappierDataBytes(step.bytesTotal, { kind: 'storage' }) })
        : null;
}

/**
 * The one step list of a setup, from the plan before anything runs to sign-in: install the agent, each
 * part it still needs, check that it runs, sign in. The rows never change; the daemon install job drives
 * their states live (its CLI step, its dependency steps, its verify step), and `signIn` says where the
 * last row stands.
 */
function buildSetupSteps(agent: MachineAgent, signIn: SetupStepState, testIDPrefix: string): SetupStep[] {
    const job = agent.job?.intent === 'install' ? agent.job : null;
    const succeeded = job?.outcome?.kind === 'succeeded';
    const cliStepId = buildAgentInstallJobCliStepId(agent);
    const cliStep = job?.steps.find((step) => step.stepId === cliStepId);
    const verifyStep = job?.steps.find((step) => step.stepId === AGENT_INSTALL_JOB_VERIFY_STEP_ID);
    const dependencySteps = job?.steps.filter((step) => step !== cliStep && step !== verifyStep) ?? [];
    const plannedDependencies = agent.dependencies.filter((dependency) => !dependency.installed);
    const row = (key: string, title: string, state: SetupStepState, detail?: string | null): SetupStep => ({
        key, title, state, ...(detail ? { detail } : {}), testID: setupStepTestID(testIDPrefix, key, state),
    });
    const dependencyRows = plannedDependencies.length > 0
        ? plannedDependencies.map((dependency) => row(dependency.key, dependency.title,
            succeeded ? 'done' : aggregateState(dependencySteps), bytesDetail(dependencySteps.find((step) => step.state === 'running'))))
        : dependencySteps.map((step) => row(step.stepId, step.label, succeeded ? 'done' : stepState(step), bytesDetail(step)));
    return [
        row('agent', t('machineAgents.installAgent', { agent: agent.title }), succeeded ? 'done' : stepState(cliStep), bytesDetail(cliStep)),
        ...dependencyRows,
        row('check', t('machineAgents.stepCheck'), succeeded ? 'done' : stepState(verifyStep)),
        row('signIn', t('machineAgents.stepSignIn'), signIn),
    ];
}

/** The steps in their bordered block. */
function Steps(props: Readonly<{ agent: MachineAgent; signIn: SetupStepState; testID: string }>) {
    return (
        <View style={styles.plan}>
            <SetupSteps variant="checklist" steps={buildSetupSteps(props.agent, props.signIn, `${props.testID}.steps`)} />
        </View>
    );
}

function installLead(agent: MachineAgent, machine: string): string {
    const lead = agent.install.mode === 'vendor_recipe'
        ? t('machineAgents.installLeadVendor', { agent: agent.title, machine })
        : t('machineAgents.installLeadManaged', { agent: agent.title, machine });
    const missing = agent.dependencies.filter((dependency) => !dependency.installed);
    const also = missing.length > 0
        ? ` ${t('machineAgents.installAlsoDownloads', {
            what: missing.map((dependency) => dependency.title).join(', ')
                + (agent.install.sizeBytes ? ` (${formatHappierDataBytes(agent.install.sizeBytes, { kind: 'storage' })})` : ''),
        })}`
        : '';
    return `${lead}${also} ${t('machineAgents.installThenSignIn')}`;
}

/**
 * The one agent-setup form (lab `agent-setup`): install → installing → sign in → ready, in two layouts.
 * It renders what the inventory, install-job and sign-in owners report and calls back for every
 * action; it holds only the local choice of how to sign in. Nothing here starts work on mount.
 */
export const AgentSetupFormView = React.memo(function AgentSetupFormView(props: AgentSetupFormViewProps) {
    const { agent, handlers } = props;
    const phase = resolveAgentSetupPhase(agent, props.session);
    const compact = props.layout === 'compact';
    return (
        <View
            testID={props.testID}
            style={compact ? styles.bodyCompact : [styles.body, phase === 'ready' ? null : styles.inset]}
            accessibilityLiveRegion="polite"
        >
            <PhaseBody {...props} phase={phase} compact={compact} handlers={handlers} />
        </View>
    );
});

function PhaseBody(props: AgentSetupFormViewProps & Readonly<{ phase: AgentSetupPhase; compact: boolean }>) {
    const { agent, handlers, machineName: machine, compact, testID } = props;
    // Installed by this setup: the step list carries the flow on into sign-in.
    const installedHere = isMachineAgentInstalledBySetup(agent);
    switch (props.phase) {
        case 'install':
            return (
                <>
                    <Lead text={installLead(agent, machine)} />
                    <Steps agent={agent} signIn="upcoming" testID={testID} />
                    <Actions>
                        {/* The pane is the review of what this installs and where: its press is the confirmation. */}
                        <RoundButton testID={`${testID}.install`} size="small" title={t('machineAgents.installAgent', { agent: agent.title })} onPress={handlers.onInstall} />
                        {!compact && agent.install.guideUrl ? (
                            <RoundButton testID={`${testID}.installMyself`} size="small" display="secondary" title={t('machineAgents.installMyself')} onPress={() => handlers.onOpenGuide(agent.install.guideUrl!)} />
                        ) : null}
                        <View style={styles.grow} />
                        {compact && agent.install.guideUrl ? (
                            <RoundButton testID={`${testID}.guide`} size="small" display="inverted" title={t('machineAgents.actionGuide')} onPress={() => handlers.onOpenGuide(agent.install.guideUrl!)} />
                        ) : null}
                    </Actions>
                </>
            );
        case 'manualInstall':
            return (
                <>
                    <Lead text={t('machineAgents.manualLead', { agent: agent.title, machine })} />
                    <Actions>
                        {agent.install.guideUrl ? (
                            <RoundButton testID={`${testID}.guide`} size="small" title={t('machineAgents.actionGuide')} onPress={() => handlers.onOpenGuide(agent.install.guideUrl!)} />
                        ) : null}
                        <RoundButton testID={`${testID}.checkAgain`} size="small" display="secondary" title={t('machineAgents.checkAgain')} onPress={handlers.onCheckAgain} />
                    </Actions>
                </>
            );
        case 'installing':
            return (
                <>
                    <Lead text={installLead(agent, machine)} />
                    <Steps agent={agent} signIn="upcoming" testID={testID} />
                    {agent.job?.logLine ? <Text style={styles.log} numberOfLines={1}>{agent.job.logLine}</Text> : null}
                    <Actions>
                        <Text style={styles.quiet}>{t('machineAgents.closeNote', { machine })}</Text>
                        <View style={styles.grow} />
                        <RoundButton testID={`${testID}.cancel`} size="small" display="inverted" title={t('machineAgents.actionCancel')} onPress={handlers.onCancelInstall} />
                    </Actions>
                </>
            );
        case 'installFailed': {
            const outcome = agent.job?.outcome?.kind === 'failed' ? agent.job.outcome : null;
            const failure = outcome ? presentAgentInstallJobFailure(outcome) : null;
            const guideUrl = failure?.recovery.guideUrl ?? agent.install.guideUrl;
            return (
                <>
                    {agent.job?.intent === 'install' ? (
                        <>
                            <Lead text={installLead(agent, machine)} />
                            <Steps agent={agent} signIn="upcoming" testID={testID} />
                        </>
                    ) : null}
                    <AttentionBanner
                        testID={`${testID}.failure`}
                        title={failure?.title ?? t('machineAgents.unknown')}
                        description={[failure?.code === 'rate_limited' ? failure.body : outcome?.message ?? failure?.body, t('machineAgents.failedKept')].filter(Boolean).join(' ')}
                        action={failure?.recovery.kind === 'guide' && guideUrl
                            ? { label: failure.recovery.label, onPress: () => handlers.onOpenGuide(guideUrl), testID: `${testID}.failure.guide` }
                            : { label: failure?.recovery.label ?? t('machineAgents.actionRetry'), onPress: handlers.onRetry, testID: `${testID}.retry` }}
                        announce="alert"
                    />
                </>
            );
        }
        case 'signIn':
            return (
                <>
                    {installedHere ? <Steps agent={agent} signIn="current" testID={testID} /> : null}
                    <SignInChoices {...props} />
                </>
            );
        case 'waitingForSignIn':
            return (
                <>
                    {installedHere ? <Steps agent={agent} signIn="running" testID={testID} /> : null}
                    <Lead text={t('machineAgents.waitingLead', { agent: agent.title, machine })} />
                    <Actions>
                        <RoundButton testID={`${testID}.showTerminal`} size="small" display="secondary" title={t('machineAgents.actionShowTerminal')} onPress={handlers.onShowTerminal} />
                        <View style={styles.grow} />
                        <RoundButton testID={`${testID}.cancelSignIn`} size="small" display="inverted" title={t('machineAgents.actionCancel')} onPress={handlers.onCancelSignIn} />
                    </Actions>
                </>
            );
        case 'ready':
            // Full layout opens under a row that already says the status: it shows the setup rows instead.
            if (!compact) return <ReadySetupRows {...props} />;
            return (
                <>
                    <SuccessLine
                        title={t('machineAgents.readyLine', { agent: agent.title, machine })}
                        detail={describeSignedIn(agent)}
                    />
                    {handlers.onStartSession ? (
                        <Actions>
                            <RoundButton testID={`${testID}.startSession`} size="small" title={t('machineAgents.startSessionWith', { agent: agent.title })} onPress={handlers.onStartSession} />
                        </Actions>
                    ) : null}
                </>
            );
        case 'unsupported':
            return <Lead text={t('machineAgents.unsupportedLead', { agent: agent.title, machine })} />;
        case 'checking':
            // Just installed here: the Machine is reading its sign-in, which is the last step running.
            if (installedHere) return <Steps agent={agent} signIn="running" testID={testID} />;
            return <SurfaceStateCard testID={`${testID}.checking`} size="line" kind="loading" title={t('machineAgents.checking')} />;
        case 'unknown':
            return (
                <>
                {installedHere ? <Steps agent={agent} signIn="upcoming" testID={testID} /> : null}
                <SurfaceStateCard
                    testID={`${testID}.unknown`}
                    size="line"
                    kind="unavailable"
                    title={t('machineAgents.unknown')}
                    action={{ label: t('machineAgents.checkAgain'), onPress: handlers.onCheckAgain }}
                />
                </>
            );
    }
}



/** How the agent is signed in, in the sign-in owner's words; null when nothing names it. */
function describeSignedIn(agent: MachineAgent): string | null {
    const via = agent.signIn.via;
    if (via?.kind === 'connected') return t('machineAgents.signedInWith', { label: via.profileLabel ?? via.title });
    if (via?.kind === 'native' && via.accountLabel) return t('machineAgents.signedInAs', { label: via.accountLabel });
    return null;
}

/**
 * A ready agent's setup on one machine, as rows (lab `ad` expanded row): how it signs in (with Change, which opens
 * the same sign-in choices as first setup) and which command line runs it.
 */
function ReadySetupRows(props: AgentSetupFormViewProps & Readonly<{ phase: AgentSetupPhase; compact: boolean }>) {
    const { agent, handlers, testID } = props;
    const [changing, setChanging] = React.useState(false);
    const canChange = agent.signIn.connectedServices.length > 0 || agent.signIn.nativeLogin === 'terminal';
    if (changing) {
        return (
            <View style={styles.changing}>
                <SignInChoices {...props} />
                <Actions>
                    <View style={styles.grow} />
                    <RoundButton testID={`${testID}.keepSignIn`} size="small" display="inverted" title={t('common.cancel')} onPress={() => setChanging(false)} />
                </Actions>
            </View>
        );
    }
    const cli = [agent.version, agent.managed === true ? t('machineAgents.cliByHappier') : null].filter(Boolean).join(' · ');
    return (
        <>
            <View>
                <Item
                    testID={`${testID}.signInRow`}
                    title={t('machineAgents.setupSignInTitle')}
                    subtitle={describeSignedIn(agent) ?? t('machineAgents.signedInHere')}
                    rightElement={canChange ? (
                        <RoundButton testID={`${testID}.changeSignIn`} size="small" display="secondary" title={t('machineAgents.setupChangeSignIn')} onPress={() => setChanging(true)} />
                    ) : undefined}
                    rightElementOutsidePressable
                    showChevron={false}
                />
                <Item
                    testID={`${testID}.cliRow`}
                    title={t('machineAgents.setupCliTitle')}
                    subtitle={cli || t('machineAgents.unknown')}
                    showChevron={false}
                    showDivider={false}
                />
            </View>
            {handlers.onStartSession || handlers.onSetUpAnother ? (
                <Actions>
                    {handlers.onStartSession ? (
                        <RoundButton testID={`${testID}.startSession`} size="small" title={t('machineAgents.startSessionWith', { agent: agent.title })} onPress={handlers.onStartSession} />
                    ) : null}
                    <View style={styles.grow} />
                    {handlers.onSetUpAnother ? (
                        <RoundButton testID={`${testID}.setUpAnother`} size="small" display="inverted" title={t('machineAgents.setUpAnother')} onPress={handlers.onSetUpAnother} />
                    ) : null}
                </Actions>
            ) : null}
        </>
    );
}

function SignInChoices(props: AgentSetupFormViewProps & Readonly<{ compact: boolean }>) {
    const { agent, handlers, machineName: machine, testID } = props;
    const choices = resolveAgentSignInChoices(agent, handlers);
    const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
    const selected = choices.find((choice) => choiceKey(choice) === selectedKey)
        ?? (selectedKey === null ? choices.find(choice => choice.kind === 'native') : null) ?? null;
    if (choices.length === 0) {
        return <Lead text={t('machineAgents.noNativeLogin', { agent: agent.title })} />;
    }
    const options = choices.map((choice) => {
        if (choice.kind === 'native') {
            return {
                id: 'native',
                title: t('machineAgents.signInOn', { machine }),
                subtitle: t('machineAgents.signInOnDetail', { agent: agent.title }),
                icon: 'terminal' as const,
                testID: `${testID}.way.native`,
            };
        }
        return {
            id: choiceKey(choice),
            title: choice.option.label,
            subtitle: choice.option.subtitle,
            icon: 'link' as const,
            disabled: choice.option.disabled,
            testID: `${testID}.way.${choice.option.id}`,
        };
    });
    const primary = selected?.kind === 'native'
        ? { title: t('machineAgents.openSignInTerminal'), onPress: handlers.onOpenNativeSignIn, id: 'openTerminal' }
        : selected?.kind === 'service'
            ? { title: selected.option.id === createConnectServiceOptionId(selected.serviceId)
                ? t('machineAgents.connect') : t('machineAgents.useConnectedAccount', { account: selected.option.label }),
                onPress: () => { selected.option.onSelect?.(); },
                id: selected.option.id === createConnectServiceOptionId(selected.serviceId) ? 'connectService' : 'useService' }
            : { title: t('machineAgents.useThisAccount'), onPress: () => {}, id: 'useService' };
    return (
        <>
            <SelectionTiles
                variant="card"
                selectionMode="single"
                accessibilityLabel={t('machineAgents.signInHow', { agent: agent.title })}
                testIdPrefix={`${testID}.ways`}
                density="compact"
                minimumColumns={1}
                minimumTileWidth={SIGN_IN_TILE_MIN_WIDTH}
                options={options}
                value={selected ? choiceKey(selected) : null}
                onChange={(next) => { if (next) setSelectedKey(next); }}
            />
            {agent.signIn.nativeLogin === 'unsupported' ? <Lead text={t('machineAgents.noNativeLogin', { agent: agent.title })} /> : null}
            <Actions>
                <RoundButton testID={`${testID}.${primary.id}`} size="small" title={primary.title} onPress={primary.onPress} disabled={!selected || (selected.kind === 'service' && selected.option.disabled)} />
            </Actions>
        </>
    );
}

function Lead(props: Readonly<{ text: string }>) {
    return <Text style={styles.lead}>{props.text}</Text>;
}

function Actions(props: Readonly<{ children: React.ReactNode }>) {
    return <View style={styles.actions}>{props.children}</View>;
}

/** The ready beat: a check and one line (lab `af-okline`). */
function SuccessLine(props: Readonly<{ title: string; detail: string | null }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.success} accessibilityRole="text">
            <Icon name="check-circle" size={16} color={theme.colors.state.success.foreground} />
            <Text style={styles.successText}>
                <Text style={styles.successTitle}>{props.title}</Text>
                {props.detail ? <Text style={styles.quiet}>{` · ${props.detail}`}</Text> : null}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 14,
        paddingBottom: theme.space.s16,
    },
    // The full layout opens under a row inside a sheet: its blocks keep the row's own inset (the ready rows are Items and carry theirs).
    inset: {
        paddingHorizontal: theme.space.s16,
    },
    changing: {
        gap: 14,
        paddingHorizontal: theme.space.s16,
    },
    bodyCompact: {
        gap: theme.space.s12,
    },
    lead: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        maxWidth: 560,
    },
    plan: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        overflow: 'hidden',
        paddingHorizontal: theme.space.s12,
    },
    log: {
        ...Typography.mono(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    grow: {
        flexGrow: 1,
    },
    quiet: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    success: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    successText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    successTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));
