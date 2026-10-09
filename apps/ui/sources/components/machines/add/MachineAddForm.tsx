import * as React from 'react';
import { Linking, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RemoteSshChecklistPromptCard } from '@/components/onboarding/checklists/remoteSsh/RemoteSshChecklistPromptCard';
import { HomePairingPanel } from '@/components/auth/pairing/HomePairingPanel';
import { SshCredentialsFields } from '@/components/ssh/SshCredentialsFields';
import type { RemoteSshBootstrapPrompt } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { OsCommandBlock } from '@/components/ui/code/blocks/OsCommandBlock';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { SetupPathPanel, type SetupPath } from '@/components/ui/setupBlocks/SetupPathPanel';
import { Text } from '@/components/ui/text/Text';
import { HAPPIER_DESKTOP_DOWNLOAD_URL } from '@/constants/downloadUrls';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { resolveMachineAddInitialPath, type MachineAddPathId } from './machineAddPaths';
import {
    MachineAddFailureNotice,
    MachineAddPaneHeader,
    MachineAddStepList,
    MachineArrivedCard,
    MachineNotSeeingNotice,
    MachineWatchLine,
} from './MachineAddPanes';
import { useMachineAddFlow } from './useMachineAddFlow';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ThisComputerAgentsPane } from '@/components/machines/agents/ThisComputerAgentsPane';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachine } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { MachineProvisionerPicker } from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { useManagedMachineAccountSettings } from '@/components/settings/machines/managed/useManagedMachineAccountSettings';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

export type MachineAddFormLayout = 'page' | 'panel';

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
export function MachineAddForm(props: Readonly<{
    layout: MachineAddFormLayout;
    testID: string;
    initialPath?: MachineAddPathId;
    /** The panel's ✕, or the draft's Discard. */
    onClose: () => void;
    /** A machine joined and the person chose to use it. */
    onStartSession: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
    /** "New machine pool", when the Home supports pools. */
    onNewPool?: (() => void) | null;
    /** Once, when a machine joins (first-run onboarding advances on it). */
    onArrived?: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
}>) {
    const { theme } = useUnistyles();
    const phone = useViewportClass() === 'compact';
    const flow = useMachineAddFlow({ initialPath: props.initialPath });
    const [mode, setMode] = React.useState<'connect' | 'create'>('connect');
    const accountScope = useServerCredentialAccountScopeBinding(props.layout === 'page' ? flow.serverId : undefined);
    const accountSettings = useManagedMachineAccountSettings(accountScope.binding ?? undefined);
    const canCreate = accountSettings.settings?.managedMachineCreationEnabled === true;
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

    const modeTabs = props.layout === 'page' && canCreate ? <SegmentedTabBar tabs={[
        { id: 'connect' as const, label: t('managedMachines.add.connect') },
        { id: 'create' as const, label: t('managedMachines.add.create') },
    ]} activeTabId={mode} onSelectTab={setMode} testIDPrefix={`${props.testID}.mode`} /> : null;
    if (props.layout === 'page' && canCreate && mode === 'create') return <View testID={props.testID} style={styles.page}>
        {modeTabs}<MachineProvisionerPicker serverId={flow.serverId} />
    </View>;

    if (paths.length === 0 || active === null) {
        return (
            <View testID={`${props.testID}.fromComputer`} style={styles.fallback}>
                {modeTabs}
                <Text style={styles.fallbackTitle}>{t('settingsMachines.addFromComputerTitle')}</Text>
                <Text style={styles.fallbackBody}>{t('settingsMachines.addFromComputerDescription')}</Text>
            </View>
        );
    }

    const pane = <MachineAddPane flow={flow} pathId={active} testID={`${props.testID}.pane`} onStartSession={props.onStartSession} />;
    const poolFoot = props.onNewPool ? (
        <Text style={styles.foot}>
            {t('addFlows.machinePoolPrompt')}{' '}
            <Text testID={`${props.testID}.newPool`} accessibilityRole="link" style={styles.footLink} onPress={props.onNewPool}>
                {t('machinePools.add')}
            </Text>
        </Text>
    ) : null;

    if (props.layout === 'panel') {
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

    return (
        <View testID={props.testID} style={styles.page}>
            {modeTabs}
            <SelectionTiles<MachineAddPathId>
                testIdPrefix={`${props.testID}.path`}
                accessibilityLabel={t('settings.addMachine')}
                density="compact"
                minimumColumns={phone ? 1 : Math.min(3, paths.length)}
                maximumColumns={phone ? 1 : undefined}
                options={paths.map((path) => ({ id: path.id, title: path.title, subtitle: path.subtitle, icon: PATH_ICON[path.id] }))}
                value={active}
                onChange={(next) => { if (next) flow.choosePath(next); }}
            />
            {pane}
        </View>
    );
}

/** The chosen way to add a machine, in whichever state the flow is in. */
function MachineAddPane(props: Readonly<{
    flow: Flow;
    pathId: MachineAddPathId;
    testID: string;
    onStartSession: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
}>) {
    const { flow, pathId, testID } = props;
    const path = flow.paths.find((candidate) => candidate.id === pathId) ?? null;
    const { startWatching } = flow;
    const runsCommand = path?.runs === 'command';
    const [showTerminal, setShowTerminal] = React.useState(false);
    // A command's machine can only announce itself: shown means watching.
    React.useEffect(() => {
        if (runsCommand && flow.watch.status === 'idle') startWatching();
    }, [flow.watch.status, runsCommand, startWatching]);

    if (flow.arrived) {
        const arrived = flow.arrived;
        return (
            <MachineArrivedCard
                testID={`${testID}.arrived`}
                machineId={arrived.machineId}
                serverId={flow.serverId}
                name={arrived.name}
                facts={[arrived.facts, t('addFlows.machineConnectedJustNow')].filter(Boolean).join(' · ')}
                onStartSession={() => props.onStartSession({ machineId: arrived.machineId, serverId: flow.serverId })}
                onAddAnother={flow.addAnother}
            />
        );
    }
    if (!path) return null;

    const watching = flow.watch.status === 'watching' ? (
        <>
            {flow.watch.notSeeing ? (
                <MachineNotSeeingNotice
                    testID={`${testID}.notSeeing`}
                    subject={pathId === 'thisComputer' ? t('addFlows.subjectThisComputer') : pathId === 'ssh' ? (flow.ssh.draft.host.trim() || t('addFlows.subjectAnotherComputer')) : t('addFlows.subjectAnotherComputer')}
                    homeName={flow.homeName}
                />
            ) : null}
            <MachineWatchLine
                testID={`${testID}.watch`}
                subject={pathId === 'thisComputer' ? t('addFlows.subjectThisComputer') : pathId === 'ssh' ? (flow.ssh.draft.host.trim() || t('addFlows.subjectAnotherComputer')) : t('addFlows.subjectAnotherComputer')}
                homeName={flow.homeName}
                startedAtMs={flow.watch.startedAtMs}
            />
        </>
    ) : null;

    const run = flow.run && flow.run.kind === (pathId === 'ssh' ? 'ssh' : 'thisComputer') ? flow.run : null;

    switch (pathId) {
        case 'thisComputer': {
            // Already a machine of this Home (lab agent-setup S1): show the computer and its agents.
            if (path.connectedMachineId) {
                return <ConnectedThisComputerPane flow={flow} machineId={path.connectedMachineId} testID={`${testID}.connected`} onStartSession={props.onStartSession} />;
            }
            if (path.runs === 'command') {
                return (
                    <View style={styles.pane}>
                        <MachineAddPaneHeader title={t('addFlows.pathThisComputerTitle')} lead={t('addFlows.thisComputerCommandLead', { home: flow.homeName })} />
                        {flow.commands ? (
                            <OsCommandBlock
                                testID={`${testID}.command`}
                                commands={flow.commands}
                                os={flow.os}
                                onOsChange={flow.setOs}
                                detectedOs={flow.detectedOs}
                                detectedLabel={t('addFlows.detectedOs')}
                            />
                        ) : null}
                        {watching}
                        <Text style={styles.hint}>
                            {t('addFlows.desktopAppHint')}{' '}
                            <Text accessibilityRole="link" style={styles.hintLink} onPress={() => { void Linking.openURL(HAPPIER_DESKTOP_DOWNLOAD_URL); }}>
                                {t('addFlows.desktopAppLink')}
                            </Text>
                        </Text>
                    </View>
                );
            }
            const state = flow.thisComputer;
            return (
                <View style={styles.pane}>
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
                </View>
            );
        }
        case 'ssh': {
            const host = flow.ssh.draft.host.trim();
            if (run) {
                return (
                    <View style={styles.pane}>
                        <MachineAddPaneHeader title={t('addFlows.sshRunningTitle', { host })} lead={t('addFlows.sshRunningLead')} />
                        {run.failure ? <MachineAddFailureNotice testID={`${testID}.failure`} failure={run.failure} onRetry={flow.retry} /> : null}
                        {run.prompt ? (
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
                        <MachineAddStepList testID={`${testID}.steps`} steps={run.steps} />
                        {run.running ? (
                            <View style={styles.actions}>
                                <RoundButton testID={`${testID}.cancel`} size="small" display="inverted" title={t('addFlows.cancelSetup')} onPress={flow.cancel} />
                            </View>
                        ) : null}
                        {watching}
                    </View>
                );
            }
            return (
                <View style={styles.pane}>
                    <MachineAddPaneHeader
                        title={t('addFlows.pathSshTitle')}
                        lead={path.runs === 'command' ? t('addFlows.sshLeadCommand', { home: flow.homeName }) : t('addFlows.sshLeadTask', { home: flow.homeName })}
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
                    {path.runs === 'command' ? (
                        <>
                            {flow.commands && flow.ssh.ready ? (
                                <OsCommandBlock
                                    testID={`${testID}.command`}
                                    commands={flow.commands}
                                    os={flow.os}
                                    onOsChange={flow.setOs}
                                    detectedOs={flow.detectedOs}
                                    detectedLabel={t('addFlows.detectedOs')}
                                />
                            ) : null}
                            {watching}
                        </>
                    ) : (
                        <View style={styles.actions}>
                            <RoundButton
                                testID={`${testID}.start`}
                                size="small"
                                title={host ? t('addFlows.setUpHost', { host }) : t('addFlows.pathSshTitle')}
                                disabled={!flow.ssh.ready}
                                onPress={flow.startSsh}
                            />
                            <Text style={styles.note}>{t('addFlows.sshSavedNote')}</Text>
                        </View>
                    )}
                </View>
            );
        }
        case 'anotherComputer':
            return (
                <View style={styles.pane}>
                    <HomePairingPanel
                        purpose="computer"
                        layout="inline"
                        testIDPrefix={`${testID}.pairing`}
                        targetProfileId={flow.serverId}
                    />
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
                    {showTerminal && flow.commands ? (
                        <>
                            <Text style={styles.note}>{t('addFlows.anotherLead', { home: flow.homeName })}</Text>
                            <OsCommandBlock testID={`${testID}.command`} commands={flow.commands} os={flow.os} onOsChange={flow.setOs} />
                        </>
                    ) : null}
                    {watching}
                </View>
            );
    }
}

const styles = StyleSheet.create((theme) => ({
    page: {
        gap: 20,
    },
    pane: {
        gap: 14,
        minWidth: 0,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
    },
    prompt: {
        gap: 10,
    },
    suggestions: {
        gap: 2,
    },
    suggestionsTitle: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    note: {
        ...Typography.default(),
        flexShrink: 1,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    hint: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    hintLink: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    fieldError: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.state.danger.foreground,
    },
    foot: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    footLink: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
    fallback: {
        gap: 2,
        padding: 20,
    },
    fallbackTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text.primary,
    },
    fallbackBody: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));

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
            machineName={getMachineDisplayName(machine) ?? t('addFlows.subjectThisComputer')}
            homeName={props.flow.homeName}
            onOpenMachine={openMachine}
            onStartSession={() => props.onStartSession({ machineId: props.machineId, serverId })}
        />
    );
}
