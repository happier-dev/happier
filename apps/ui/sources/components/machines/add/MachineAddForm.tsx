import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RemoteSshChecklistPromptCard } from '@/components/onboarding/checklists/remoteSsh/RemoteSshChecklistPromptCard';
import { HomePairingPanel } from '@/components/auth/pairing/HomePairingPanel';
import { SshCredentialsFields } from '@/components/ssh/SshCredentialsFields';
import { useSshHostKeyTrustSheet } from '@/components/ssh/SshHostKeyTrustSheet';
import type { RemoteSshBootstrapPrompt } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { OsCommandBlock } from '@/components/ui/code/blocks/OsCommandBlock';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ThisComputerServiceNotice } from '@/components/settings/machines/localControl/ThisComputerServiceNotice';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MachineDataDisclosureSection } from './MachineDataDisclosureSection';
import { SetupPathPanel, type SetupPath } from '@/components/ui/setupBlocks/SetupPathPanel';
import { Text } from '@/components/ui/text/Text';
import { HAPPIER_DESKTOP_DOWNLOAD_URL } from '@/constants/downloadUrls';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { resolveMachineAddInitialPath, type MachineAddPathId, type MachineAddRoutePath } from './machineAddPaths';
import { readMachineAddDevice } from './useMachineAddPaths';
import {
    MachineAddFailureNotice,
    MachineAddPaneHeader,
    MachineAddPageLeadProvider,
    type MachineAddPageLead,
    MachineAddStepList,
    MachineArrivedCard,
    MachineNotSeeingNotice,
    MachineWatchLine,
} from './MachineAddPanes';
import { useMachineAddFlow } from './useMachineAddFlow';
import { updateMachineAddFlowDraft, useMachineAddFlowDraftSelector } from './machineAddFlowStore';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ThisComputerAgentsPane } from '@/components/machines/agents/ThisComputerAgentsPane';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachine } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { MachineProvisionerPicker, type ManagedProvisionerSelection } from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { useDeviceType } from '@/utils/platform/responsive';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

export type MachineAddFormLayout = 'page' | 'panel';

/** A way's short name: the bar's segment, the phone's row and the title of the page a phone pushes for it. */
export function machineAddWayTitle(way: MachineAddRoutePath): string {
    switch (way) {
        case 'thisComputer': return t('addFlows.pathThisComputerTitle');
        case 'ssh': return t('addFlows.pathSshChip');
        case 'anotherComputer': return t('addFlows.pathAnotherTitle');
        case 'create': return t('managedMachines.add.createPath');
    }
}

/** At phone width the Add page lists the ways and pushes the chosen one as its own page. */
export function useMachineAddPushesWays(): boolean {
    return useDeviceType() === 'phone';
}

type Flow = ReturnType<typeof useMachineAddFlow>;

const PATH_ICON: Readonly<Record<MachineAddPathId, IconName>> = {
    thisComputer: 'laptop',
    ssh: 'hard-drives',
    anotherComputer: 'desktop',
};

function describePath(path: Flow['paths'][number]): Omit<SetupPath<MachineAddPathId>, 'glyph' | 'id'> {
    switch (path.id) {
        case 'thisComputer':
            return {
                title: t('addFlows.pathThisComputerTitle'),
                subtitle: path.connectedMachineId
                    ? t('addFlows.pathThisComputerConnected')
                    : path.runs === 'task' ? t('addFlows.pathThisComputerTask') : t('addFlows.pathThisComputerCommand'),
            };
        case 'ssh':
            return { title: t('addFlows.pathSshTitle'), subtitle: t('addFlows.pathSshSubtitle'), chipLabel: t('addFlows.pathSshChip') };
        case 'anotherComputer':
            return { title: t('addFlows.pathAnotherTitle'), subtitle: t('addFlows.pathAnotherSubtitle') };
    }
}

/**
 * Add a machine: the one form, in two frames (lab `add-flows` M1–M6). `panel` is Home's opened "Add a
 * machine" block (paths in a column, or chips when narrow); `page` is Settings → Machines' draft (paths
 * as cards above the pane). Everything it shows comes from the one flow owner (`useMachineAddFlow`):
 * which ways this device can run, the command, the SSH draft, the running setup and the machine that
 * joins. Nothing navigates away; the machine arrives in the form.
 */
type MachineAddFormProps = Readonly<{
    layout: MachineAddFormLayout;
    testID: string;
    initialPath?: MachineAddPathId;
    /** The panel's ✕, or the draft's Discard. */
    onClose: () => void;
    /** A machine joined and the person chose to use it. */
    onStartSession: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
    /** "New machine pool", when the Home supports pools. */
    onNewPool?: (() => void) | null;
    /** `page` only: this Home's Account allows Create one (the page reads it once, for its header too). */
    canCreate?: boolean;
    /** An addressed Create entry can use another Home without retargeting a retained connection task. */
    creationServerId?: string;
    /** Once, when a machine joins (first-run onboarding advances on it). */
    onArrived?: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
    onSelectProvisioner?: (selection: ManagedProvisionerSelection) => void;
    /** `page` on a phone: push the chosen way as its own page (the route's `path`). */
    onOpenWay?: (way: MachineAddRoutePath) => void;
    /** `page` on a phone: the way this pushed page shows (the route's `path`); absent, the page lists the ways. */
    openedWay?: MachineAddRoutePath;
    /** The page header that names an opened way and shows its pane's lead (the draft screen's). */
    pageLead?: MachineAddPageLead;
}>;

export function MachineAddForm(props: MachineAddFormProps) {
    const flow = useMachineAddFlow({ initialPath: props.initialPath });
    return <MachineAddFormWithFlow {...props} flow={flow} />;
}

/** The page header and form share one flow, including its mounted approval continuation. */
export function MachineAddFormWithFlow(props: MachineAddFormProps & Readonly<{ flow: Flow }>) {
    const { theme } = useUnistyles();
    const { flow } = props;
    // "Create one" is the fourth way to add a machine, beside the paths (lab `m-add`), when this Home allows it.
    const creating = useMachineAddFlowDraftSelector((draft) => draft.creating);
    const setCreating = React.useCallback((next: boolean) => updateMachineAddFlowDraft((draft) => draft.creating === next ? draft : { ...draft, creating: next }), []);
    const arrivedMachineId = flow.arrived?.machineId ?? null;
    const { onArrived } = props;
    const reportedArrivalRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!arrivedMachineId || !onArrived || reportedArrivalRef.current === arrivedMachineId) return;
        reportedArrivalRef.current = arrivedMachineId;
        onArrived({ machineId: arrivedMachineId, serverId: flow.serverId });
    }, [arrivedMachineId, flow.serverId, onArrived]);
    const paths = React.useMemo(() => flow.paths.map((path): SetupPath<MachineAddPathId> => ({
        id: path.id,
        glyph: <Icon name={PATH_ICON[path.id]} size={17} color={theme.colors.text.secondary} />,
        ...describePath(path),
    })), [flow.paths, theme.colors.text.secondary]);
    const active = flow.path ?? resolveMachineAddInitialPath(flow.paths, props.initialPath);

    // Ways in follow the lab and spec order: the connection paths, then Create one (P-M7). A phone or a
    // browser still opens on Create one (58d §D2); only its place in the order is fixed.
    const offerCreate = props.layout === 'page' && props.canCreate === true;
    const showCreate = offerCreate && (props.openedWay === 'create' || creating || paths.length === 0 || active === null);
    // A phone lists the ways in and pushes the chosen one full height; nothing stacks under the list.
    const { onOpenWay } = props;
    const pushes = useMachineAddPushesWays() && props.layout === 'page' && Boolean(onOpenWay);
    const { choosePath } = flow;
    const setUpThisComputer = React.useCallback(() => {
        setCreating(false);
        choosePath('thisComputer');
    }, [choosePath, setCreating]);
    const openWay = React.useCallback((way: MachineAddRoutePath) => {
        if (way === 'create') setCreating(true);
        else { setCreating(false); choosePath(way); }
        onOpenWay?.(way);
    }, [choosePath, onOpenWay, setCreating]);

    if (!offerCreate && (paths.length === 0 || active === null)) {
        return (
            <View testID={`${props.testID}.fromComputer`} style={styles.fallback}>
                <Text style={styles.fallbackTitle}>{t('settingsMachines.addFromComputerTitle')}</Text>
                <Text style={styles.fallbackBody}>{t('settingsMachines.addFromComputerDescription')}</Text>
            </View>
        );
    }

    // The bar names ways in only (lab af-add): which computer runs a computer-created VM is the picker's
    // to say, on that section, and Account-created machines name none.
    const pane = showCreate || active === null
        ? <MachineProvisionerPicker serverId={props.creationServerId ?? flow.serverId} onSetUpThisComputer={setUpThisComputer} onSelectProvisioner={props.onSelectProvisioner} />
        : <MachineAddPane flow={flow} pathId={active} onPage={props.layout === 'page'} testID={`${props.testID}.pane`} onStartSession={props.onStartSession} />;
    const poolFoot = props.onNewPool ? (
        <Text style={styles.foot}>
            {t('addFlows.machinePoolPrompt')}{' '}
            <Text testID={`${props.testID}.newPool`} accessibilityRole="link" style={styles.footLink} onPress={props.onNewPool}>
                {t('machinePools.add')}
            </Text>
        </Text>
    ) : null;

    if (props.layout === 'panel' && active !== null) {
        return (
            <SetupPathPanel
                testID={props.testID}
                title={t('settingsOverview.addMachineTitle')}
                paths={paths}
                active={active}
                onChoose={flow.choosePath}
                pane={pane}
                foot={poolFoot}
                onClose={props.onClose}
            />
        );
    }

    if (pushes) {
        const opened = props.openedWay === 'create' ? (offerCreate ? 'create' : null)
            : props.openedWay && paths.some((path) => path.id === props.openedWay) ? props.openedWay : null;
        if (opened === 'create') return <View testID={props.testID}><MachineProvisionerPicker serverId={props.creationServerId ?? flow.serverId} onSetUpThisComputer={setUpThisComputer} onSelectProvisioner={props.onSelectProvisioner} /></View>;
        if (opened) {
            return (
                <View testID={props.testID}>
                    {/* The pushed page is titled by its way; the pane's lead becomes that header's description (lab add/sshp). */}
                    <MachineAddPageLeadProvider value={props.pageLead ?? null}>
                        <MachineAddPane flow={flow} pathId={opened} onPage testID={`${props.testID}.pane`} onStartSession={props.onStartSession} />
                    </MachineAddPageLeadProvider>
                </View>
            );
        }
        const createWay = offerCreate ? [{ id: 'create' as const, subtitle: t('managedMachines.add.createPathSubtitle'),
            glyph: <Icon name="cloud" size={17} color={theme.colors.text.secondary} /> }] : [];
        const ways = [...paths, ...createWay];
        return (
            <View testID={props.testID}>
                <ItemGroup>
                    {ways.map((way) => (
                        <Item
                            key={way.id}
                            testID={`${props.testID}.way.${way.id}`}
                            icon={way.glyph}
                            title={machineAddWayTitle(way.id)}
                            subtitle={way.subtitle}
                            onPress={() => openWay(way.id)}
                        />
                    ))}
                </ItemGroup>
                <MachineDataDisclosureSection testID={`${props.testID}.disclosure`} />
            </View>
        );
    }

    // Page sections own the page edge: the paths and a connect pane sit in edge-only groups, and Create
    // one's own sections render at page level so they line up with the title (anatomy: no nested insets).
    return (
        <View testID={props.testID}>
            <ItemGroup surface="none">
            {/* Two to four short ways in: one segmented bar, as wide as its words (lab m-add). Each pane
                opens with its own lead line, so the bar carries names only. */}
            <View style={styles.pathsRow}>
            <View style={styles.paths}>
            <SegmentedTabBar<MachineAddPathId | 'create'>
                role="radiogroup"
                segmentSizing="content"
                testIDPrefix={`${props.testID}.path`}
                accessibilityLabel={t('settings.addMachine')}
                tabs={[
                    ...paths.map((path) => ({ id: path.id, label: machineAddWayTitle(path.id) })),
                    ...(offerCreate ? [{ id: 'create' as const, label: machineAddWayTitle('create') }] : []),
                ]}
                activeTabId={showCreate || active === null ? 'create' : active}
                onSelectTab={(next) => {
                    if (next === 'create') setCreating(true);
                    else { setCreating(false); flow.choosePath(next); }
                }}
            />
            </View>
            </View>
            </ItemGroup>
            {pane}
            <MachineDataDisclosureSection testID={`${props.testID}.disclosure`} />
        </View>
    );
}

/** The chosen way to add a machine, in whichever state the flow is in. */
function MachineAddPane(props: Readonly<{
    flow: Flow;
    pathId: MachineAddPathId;
    /** On a page each part owns the page edge, so a section inside the pane lines up with the title (no nested insets). */
    onPage: boolean;
    testID: string;
    onStartSession: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
}>) {
    const { flow, pathId, testID, onPage } = props;
    const router = useRouter();
    const path = flow.paths.find((candidate) => candidate.id === pathId) ?? null;
    const { startWatching } = flow;
    const runsCommand = path?.runs === 'command';
    const [showTerminal, setShowTerminal] = React.useState(false);
    // Over SSH in the app, the command is the "Run it yourself" fallback beside Connect and install.
    const [runYourself, setRunYourself] = React.useState(false);
    // A command's machine can only announce itself: shown means watching. An SSH form shows no command until it can run one.
    const commandShown = Boolean(flow.commands) && (runsCommand || (pathId === 'ssh' && runYourself)) && (pathId !== 'ssh' || flow.ssh.ready);
    const commandReadyToWatch = commandShown && Boolean(flow.commands?.[flow.os]);
    React.useEffect(() => {
        if (commandReadyToWatch && flow.watch.status === 'idle') startWatching();
    }, [flow.watch.status, commandReadyToWatch, startWatching]);
    // A server's host key is asked in the trust sheet (lab af-ssh Kp), not inline; the answer goes back through the flow.
    const sshPrompt = pathId === 'ssh' && flow.run?.kind === 'ssh' ? flow.run.prompt as RemoteSshBootstrapPrompt | null : null;
    const hostKeyPrompt = sshPrompt && (sshPrompt.kind === 'ssh.trustHost' || sshPrompt.kind === 'ssh.replaceHostKey') ? sshPrompt : null;
    useSshHostKeyTrustSheet(hostKeyPrompt ? { host: hostKeyPrompt.host, keyType: hostKeyPrompt.keyType,
        fingerprint: hostKeyPrompt.fingerprint, existingFingerprint: hostKeyPrompt.existingFingerprint } : null,
    (trusted) => { if (trusted) flow.continueSshPrompt(); else flow.declineSshPrompt(); });

    if (flow.arrived) {
        const arrived = flow.arrived;
        return (
            <PaneSection onPage={onPage}><MachineArrivedCard
                testID={`${testID}.arrived`}
                machineId={arrived.machineId}
                serverId={flow.serverId}
                name={arrived.name}
                facts={[arrived.facts, t('addFlows.machineConnectedJustNow')].filter(Boolean).join(' · ')}
                next={arrived.next}
                onStartSession={() => props.onStartSession({ machineId: arrived.machineId, serverId: flow.serverId })}
                onAddAnother={flow.addAnother}
            /></PaneSection>
        );
    }
    if (!path) return null;
    const commandUnavailable = <AttentionBanner testID={`${testID}.homeUnavailable`} tone="warning"
        title={flow.commandUnavailableMessage ?? t('managedMachines.creation.homeNotGuestReachable')}
        details={flow.commandUnavailableDetails} />;
    // A Home archive refusal applies to the terminal command. Pairing has its own carrier.
    const keepsPairing = pathId === 'anotherComputer' && flow.commandUnavailableDetails?.[0] === 'guest_payload_missing';
    if (flow.remoteHomeUnavailable && !flow.run && !keepsPairing) {
        return <PaneSection onPage={onPage}>
            {commandUnavailable}
        </PaneSection>;
    }

    // The pairing panel already says it is waiting; a second line only belongs beside the terminal command.
    const watching = flow.watch.status === 'watching' ? (
        <>
            {flow.watch.notSeeing ? (
                <MachineNotSeeingNotice
                    testID={`${testID}.notSeeing`}
                    subject={pathId === 'thisComputer' ? t('addFlows.subjectThisComputer') : pathId === 'ssh' ? (flow.ssh.draft.host.trim() || t('addFlows.subjectAnotherComputer')) : t('addFlows.subjectAnotherComputer')}
                    homeName={flow.homeName}
                />
            ) : null}
            {pathId === 'anotherComputer' && !showTerminal ? null : <MachineWatchLine
                testID={`${testID}.watch`}
                subject={pathId === 'thisComputer' ? t('addFlows.subjectThisComputer') : pathId === 'ssh' ? (flow.ssh.draft.host.trim() || t('addFlows.subjectAnotherComputer')) : t('addFlows.subjectAnotherComputer')}
                homeName={flow.homeName}
                startedAtMs={flow.watch.startedAtMs}
            />}
        </>
    ) : null;

    const run = flow.run && flow.run.kind === (pathId === 'ssh' ? 'ssh' : 'thisComputer') ? flow.run : null;

    switch (pathId) {
        case 'thisComputer': {
            // Already a machine of this Home (lab agent-setup S1): show the computer and its agents.
            if (path.connectedMachineId) {
                return <PaneSection onPage={onPage}><ConnectedThisComputerPane flow={flow} machineId={path.connectedMachineId} testID={`${testID}.connected`} onStartSession={props.onStartSession} /></PaneSection>;
            }
            if (path.runs === 'command') {
                return (
                    <PaneSection onPage={onPage}>
                        <MachineAddPaneHeader title={t('addFlows.pathThisComputerTitle')} lead={t('addFlows.thisComputerCommandLead', { home: flow.homeName })} />
                        {flow.commands ? (
                            <OsCommandBlock
                                testID={`${testID}.command`}
                                commands={flow.commands}
                                unavailableContent={commandUnavailable}
                                os={flow.os}
                                onOsChange={flow.setOs}
                                detectedOs={flow.detectedOs}
                                detectedLabel={t('addFlows.detectedOs')}
                            />
                        ) : null}
                        {watching}
                        <Text style={styles.hint}>
                            {t('addFlows.desktopAppHint')}{' '}
                            <Text accessibilityRole="link" style={styles.hintLink} onPress={() => { void requestOpenExternalUrl(HAPPIER_DESKTOP_DOWNLOAD_URL); }}>
                                {t('addFlows.desktopAppLink')}
                            </Text>
                        </Text>
                    </PaneSection>
                );
            }
            const state = flow.thisComputer;
            return (
                <PaneSection onPage={onPage}>
                    <MachineAddPaneHeader
                        title={t('addFlows.pathThisComputerTitle')}
                        lead={run?.running
                            ? t('addFlows.thisComputerRunningLead', { machine: state.kind === 'ready' ? state.machineName : t('addFlows.subjectThisComputer') })
                            : t('addFlows.thisComputerTaskLead', { machine: state.kind === 'ready' ? state.machineName : t('addFlows.pathThisComputerTitle'), home: flow.homeName })}
                    />
                    {run?.failure ? <MachineAddFailureNotice testID={`${testID}.failure`} failure={run.failure} onRetry={flow.retry} /> : null}
                    {state.kind === 'onAnotherHome' && !run ? (
                        <AttentionBanner
                            testID={`${testID}.onAnotherHome`}
                            tone="warning"
                            title={t('addFlows.onAnotherHomeTitle', { machine: t('addFlows.pathThisComputerTitle') })}
                            description={t('addFlows.onAnotherHomeBody', { home: flow.homeName })}
                            action={{ label: t('addFlows.moveToHome', { home: flow.homeName }), onPress: () => flow.resolveOnAnotherHome('move'), testID: `${testID}.onAnotherHome.move` }}
                            secondaryAction={{ label: t('addFlows.keepOnOtherHome'), onPress: () => flow.resolveOnAnotherHome('keep'), testID: `${testID}.onAnotherHome.keep` }}
                        />
                    ) : null}
                    {/* Signing in, pairing or a broken service is the background service's own state: it says it and its one
                        operation here (owner 11-11), never an empty pane. */}
                    {!run && (state.kind === 'needsAuth' || state.kind === 'pairingRequired')
                        ? <ThisComputerServiceNotice testID={`${testID}.service`} /> : null}
                    {run ? <MachineAddStepList testID={`${testID}.steps`} steps={run.steps} /> : state.kind === 'ready' ? (
                        <Item
                            testID={`${testID}.machine`}
                            icon={<Icon name="laptop" size={20} />}
                            title={state.machineName}
                            subtitle={state.platformLabel}
                            showChevron={false}
                            mode="info"
                        />
                    ) : null}
                    {!run && (state.kind === 'ready' || state.kind === 'checking') ? (
                        <View style={styles.actions}>
                            <RoundButton
                                testID={`${testID}.start`}
                                size="small"
                                title={t('addFlows.setUpThisComputer')}
                                loading={state.kind === 'checking'}
                                disabled={state.kind !== 'ready'}
                                onPress={flow.startThisComputer}
                            />
                        </View>
                    ) : null}
                    {run?.running ? (
                        <View style={styles.actions}>
                            <RoundButton testID={`${testID}.cancel`} size="small" display="inverted" title={t('addFlows.cancelSetup')} onPress={flow.cancel} />
                        </View>
                    ) : null}
                    {watching}
                </PaneSection>
            );
        }
        case 'ssh': {
            const host = flow.ssh.draft.host.trim();
            const username = flow.ssh.draft.username.trim();
            const approvalNotice = flow.approval.approvalId ? <AttentionBanner testID={`${testID}.approval`} title={t('approvals.title')} description={t('approvals.status.open')}
                action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(flow.approval.approvalId!)}?serverId=${encodeURIComponent(flow.serverId)}` as never) }} /> : null;
            if (run) {
                const onPhone = readMachineAddDevice() === 'phone';
                return (
                    <PaneSection onPage={onPage}>
                        {/* The phone runs the SSH session itself, so leaving the app would stop it (58d AF4). */}
                        <MachineAddPaneHeader title={t('addFlows.sshRunningTitle', { host })}
                            lead={onPhone ? t('addFlows.sshRunningLeadPhone') : t('addFlows.sshRunningLead')} />
                        {run.failure ? <MachineAddFailureNotice testID={`${testID}.failure`} failure={run.failure} onRetry={flow.retry} /> : null}
                        {run.prompt && !hostKeyPrompt ? (
                            <View style={styles.prompt}>
                                <RemoteSshChecklistPromptCard
                                    testID={`${testID}.prompt`}
                                    prompt={run.prompt as RemoteSshBootstrapPrompt}
                                    password={flow.ssh.draft.password}
                                    isStarting={run.running}
                                    onChangePassword={(password) => flow.ssh.setDraft({ ...flow.ssh.draft, password })}
                                />
                                <View style={styles.actions}>
                                    <RoundButton testID={`${testID}.prompt.continue`} size="small" title={t('common.continue')} onPress={flow.continueSshPrompt} />
                                    <RoundButton testID={`${testID}.prompt.decline`} size="small" display="inverted" title={t('common.cancel')} onPress={flow.declineSshPrompt} />
                                </View>
                            </View>
                        ) : null}
                        {approvalNotice}
                        <MachineAddStepList testID={`${testID}.steps`} steps={run.steps}
                            identity={{ title: username ? `${username}@${host}` : host, subtitle: t('addFlows.machineJoinsHome', { home: flow.homeName }) }}
                            hold={onPhone && run.running ? t('addFlows.sshKeepOpen', { host }) : null} />
                        {run.running ? (
                            <View style={styles.actions}>
                                <RoundButton testID={`${testID}.cancel`} size="small" display="inverted" title={t('addFlows.cancelSetup')} onPress={flow.cancel} />
                            </View>
                        ) : null}
                        {watching}
                    </PaneSection>
                );
            }
            const command = commandShown && flow.commands ? (
                <OsCommandBlock
                    testID={`${testID}.command`}
                    commands={flow.commands}
                    unavailableContent={commandUnavailable}
                    os={flow.os}
                    onOsChange={flow.setOs}
                    detectedOs={flow.detectedOs}
                    detectedLabel={t('addFlows.detectedOs')}
                />
            ) : null;
            return (
                <>
                <PaneSection onPage={onPage}>
                    <MachineAddPaneHeader
                        title={t('addFlows.pathSshTitle')}
                        lead={runsCommand ? t('addFlows.sshLeadCommand', { home: flow.homeName }) : t('addFlows.sshLeadTask', { home: flow.homeName })}
                    />
                    {!host && flow.ssh.suggestions.length > 0 ? (
                        <View style={styles.suggestions}>
                            <Text style={styles.suggestionsTitle}>{t('addFlows.sshSuggestionsTitle')}</Text>
                            {flow.ssh.suggestions.slice(0, 5).map((suggestion) => (
                                <Item
                                    key={suggestion.id}
                                    testID={`${testID}.suggestion.${suggestion.id}`}
                                    icon={<Icon name="hard-drives" size={18} />}
                                    title={suggestion.title}
                                    subtitle={suggestion.subtitle}
                                    density="compact"
                                    showChevron={false}
                                    onPress={suggestion.apply}
                                />
                            ))}
                        </View>
                    ) : null}
                    <SshCredentialsFields
                        testIDPrefix={`${testID}.ssh`}
                        layoutVariant="form"
                        value={flow.ssh.draft}
                        onChange={flow.ssh.setDraft}
                        supportedAuthModes={flow.ssh.supportedAuthModes}
                        privateKeyMaterial={flow.ssh.privateKeyMaterial}
                        onChangePrivateKeyMaterial={flow.ssh.setPrivateKeyMaterial}
                    />
                    {flow.ssh.hostError ? <Text accessibilityRole="alert" style={styles.fieldError}>{flow.ssh.hostError}</Text> : null}
                    </PaneSection>
                    {/* What happens where: the app connects from this device; on the server Happier runs as the
                        sign-in user, with separate users off until the person turns them on (lab add/ssh). */}
                    <View testID={`${testID}.facts`}>
                        {runsCommand ? null : (
                            <ItemGroup>
                                <Item testID={`${testID}.facts.connectFrom`} mode="info" showChevron={false}
                                    title={t('addFlows.sshConnectFromTitle')}
                                    subtitle={t('addFlows.sshConnectFromSubtitle')}
                                    detail={flow.thisComputer.kind === 'ready' ? flow.thisComputer.machineName : t('addFlows.sshConnectFromThisDevice')} />
                            </ItemGroup>
                        )}
                        <ItemGroup title={t('addFlows.sshOnServerTitle')}>
                            <Item testID={`${testID}.facts.runsAs`} mode="info" showChevron={false}
                                title={t('addFlows.sshRunsAsTitle')}
                                subtitle={username ? t('addFlows.sshRunsAsSubtitleUser', { user: username }) : t('addFlows.sshRunsAsSubtitle')} />
                            <Item testID={`${testID}.facts.separateUsers`} mode="info" showChevron={false}
                                title={t('addFlows.sshSeparateUsersTitle')}
                                subtitle={t('addFlows.sshSeparateUsersSubtitle')}
                                detail={t('addFlows.sshSeparateUsersOff')} />
                        </ItemGroup>
                    </View>
                    <PaneSection onPage={onPage}>
                    {runsCommand ? (
                        <>
                            {command}
                            {commandShown ? watching : null}
                        </>
                    ) : (
                        <>
                        <View style={styles.actions}>
                            <RoundButton
                                testID={`${testID}.start`}
                                size="small"
                                title={t('addFlows.sshConnectAndInstall')}
                                disabled={!flow.ssh.ready || flow.approval.approvalPending}
                                onPress={flow.startSsh}
                            />
                            <RoundButton
                                testID={`${testID}.runYourself`}
                                size="small"
                                display="secondary"
                                title={t('addFlows.sshRunItYourself')}
                                expanded={runYourself}
                                onPress={() => setRunYourself((current) => !current)}
                            />
                        </View>
                        {!host ? <Text testID={`${testID}.startReason`} style={styles.note}>{t('addFlows.sshNeedsAddress')}</Text>
                            : <Text style={styles.note}>{t('addFlows.sshSavedNote')}</Text>}
                        {approvalNotice}
                        {runYourself && (command || flow.commandUnavailableDetails) ? (
                            <>
                                <Text style={styles.note}>{t('addFlows.sshRunItYourselfLead', { home: flow.homeName })}</Text>
                                {command ?? commandUnavailable}
                                {watching}
                            </>
                        ) : null}
                        </>
                    )}
                </PaneSection>
                </>
            );
        }
        case 'anotherComputer':
            // The pairing panel's step and scan sections own the page edge, between the lead and the terminal fallback.
            return (
                <>
                <PaneSection onPage={onPage}>
                    <MachineAddPaneHeader title={t('addFlows.pathAnotherTitle')} lead={t('addFlows.pathAnotherLead')} />
                </PaneSection>
                <HomePairingPanel
                    purpose="computer"
                    layout="section"
                    testIDPrefix={`${testID}.pairing`}
                    targetProfileId={flow.serverId}
                />
                <PaneSection onPage={onPage}>
                    <View style={styles.actions}>
                        <RoundButton
                            testID={`${testID}.terminal`}
                            size="small"
                            display="secondary"
                            title={t('addFlows.anotherTerminalAction')}
                            onPress={() => setShowTerminal((current) => !current)}
                            expanded={showTerminal}
                        />
                    </View>
                    {showTerminal && (
                        flow.commands ? <>
                            <Text style={styles.note}>{t('addFlows.anotherLead', { home: flow.homeName })}</Text>
                            <OsCommandBlock testID={`${testID}.command`} commands={flow.commands} unavailableContent={commandUnavailable}
                                os={flow.os} onOsChange={flow.setOs} />
                        </> : commandUnavailable
                    )}
                    {watching}
                </PaneSection>
                </>
            );
    }
}

const styles = StyleSheet.create((theme) => ({
    pathsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    paths: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
    pane: {
        gap: 14,
        minWidth: 0,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    prompt: {
        gap: theme.space.s10,
    },
    suggestions: {
        gap: theme.space.s2,
    },
    suggestionsTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    note: {
        flexShrink: 1,
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    hint: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    hintLink: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    fieldError: {
        ...Typography.variant('body'),
        color: theme.colors.state.danger.foreground,
    },
    foot: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    footLink: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
    fallback: {
        gap: theme.space.s2,
        padding: theme.space.s20,
    },
    fallbackTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    fallbackBody: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));

/** One part of a pane. On a page it owns the page edge, as a page section does; in a panel it is the pane's own column. */
function PaneSection(props: Readonly<{ onPage: boolean; children?: React.ReactNode }>) {
    const body = <View style={styles.pane}>{props.children}</View>;
    return props.onPage ? <ItemGroup surface="none">{body}</ItemGroup> : body;
}

function ConnectedThisComputerPane(props: Readonly<{
    flow: Flow;
    machineId: string;
    testID: string;
    onStartSession: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
}>) {
    const router = useRouter();
    const machine = useMachine(props.machineId);
    // This computer's machine belongs to the Home the form adds to: the active one.
    const serverId = useActiveServerSnapshot().serverId;
    const openMachine = React.useCallback(() => {
        router.push(machineCollectionHref({ machineId: props.machineId, serverId }) as never);
    }, [props.machineId, router, serverId]);
    return (
        <ThisComputerAgentsPane
            testID={props.testID}
            serverId={serverId}
            machineId={props.machineId}
            machineName={machine ? getMachineSentenceName(machine) : t('addFlows.subjectThisComputer')}
            homeName={props.flow.homeName}
            onOpenMachine={openMachine}
            onStartSession={() => props.onStartSession({ machineId: props.machineId, serverId })}
        />
    );
}
