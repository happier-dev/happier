import * as React from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { beginMachinePageTabIntent } from './machinePageIntent';
import { machinePageTabRouteParams } from './machinePageTabQuery';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { MachineReplacementOutputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { MachineReplacementPickerModal, type MachineReplacementPickerCandidate } from '@/components/machines/MachineReplacementPickerModal';
import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';
import type { ManagedMachineHeaderIdentity } from '@/components/settings/machines/managed/ManagedMachineSections';
import { showMachineEnvironmentApplySheet } from '@/components/settings/machines/managed/MachineEnvironmentApplySheet';
import { showMachineShareSheet } from '@/components/sharing/machines/MachineSharingSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Modal } from '@/modal';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { useMachineListByServerId } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

import { readMachineTerminalHomeDir, showMachineTerminalSheet } from '@/components/machines/terminal/MachineTerminalSheet';
import { useMachineStartSession } from './useMachineStartSession';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { describeMachineSentence, readMachinePublishedResources, resolveMachineReasonAction, selectHeadlineReason } from '@/components/machines/summary/machineResourceSentences';
import { resolveMachineAttentionWordColor } from '@/components/machines/summary/machineSummaryStripModel';
import { MachineWorkingCountsProvider, useMachineWorkingCount } from '@/components/machines/work/machineWorkingCounts';
import { trackEnterFromRectTargets, useEnterFromRect, useEnterFromRectMember } from '@/components/ui/motion/rectFlight';
import { measureInWindow } from '@/components/ui/popover/measure';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { describeMachineUptime } from '@/components/machines/vitals/vitalsFormat';
import { formatMachineBytes, resolveMachineCoreCount } from '@/components/machines/vitals/machineVitalsPresentation';
import type { MachineVitalsHostFactsV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { machineHeaderOriginKey, takeMachineHeaderOrigin } from './machineHeaderOrigin';
import type { MachinePageTarget } from './useMachinePageTarget';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

const styles = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    // The live sentence under the name (lab `rm` R): the purpose line's step, in ink, because it states the present.
    sentence: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('pageDescription'),
    },
    sentenceLead: {
        ...Typography.default('semiBold'),
    },
}));

function replacementCandidateSubtitle(machine: Machine, label: string): string {
    // What tells machines apart to a person: the system and the host name when it adds to the name, never a path or an id.
    const host = machine.metadata?.host;
    return [formatOSPlatform(machine.metadata?.platform), host && host !== label ? host : undefined]
        .filter((part): part is string => Boolean(part)).join(' · ');
}

/**
 * The facts under a machine's name (R2, MPG-5): presence, OS and CPU, the encryption of the Account
 * it belongs to (stated both ways), then the CLI, host and replacement facts it already had. A machine
 * Happier created states its power and provider facts instead of a bare "Online". Plan 20's host facts
 * (cores and memory, uptime while online) follow the platform; plan 50 appends keep-awake here.
 */
export function composeMachinePageHeaderFacts(input: Readonly<{
    machine: Machine;
    online: boolean | null;
    managedMeta: readonly PageHeaderMetaFact[] | undefined;
    encryptionMode: 'e2ee' | 'plain' | null;
    replacedByMachineLabel: string | null;
    /** The machine's published host facts (plan 20): cores and memory, and when it booted. */
    hostFacts?: MachineVitalsHostFactsV1 | null;
    nowMs?: number;
}>): PageHeaderMetaFact[] {
    const { machine } = input;
    // Presence is named only when it adds something: "Running 3 h" already says a created machine is up, and an
    // offline machine's sentence above the facts already reads "Offline · last seen …".
    const powerSaysOnline = input.online && (input.managedMeta ?? []).some((fact) => fact.key === 'managed-power');
    const facts: PageHeaderMetaFact[] = [...(powerSaysOnline || !input.online ? [] : [{
        key: 'presence',
        text: t('machineDetailPage.online'),
        testID: 'machine-detail-presence',
    }]), ...(input.managedMeta ?? [])];
    const platform = formatOSPlatform(machine.metadata?.platform);
    const arch = machine.metadata?.arch?.trim();
    if (platform) facts.push({ key: 'platform', text: arch ? t('machineDetailPage.platformFact', { platform, arch }) : platform });
    if (input.hostFacts) {
        facts.push({ key: 'host-size', testID: 'machine-detail-host-size', text: t('machineVitals.header.coresMemory', {
            cores: resolveMachineCoreCount(input.hostFacts), memory: formatMachineBytes(input.hostFacts.memoryTotalBytes, 'memory'),
        }) });
        // Uptime is counted from the published boot time, so it never goes stale between reports.
        if (input.online) facts.push({ key: 'uptime', testID: 'machine-detail-uptime', text: describeMachineUptime(input.hostFacts.bootedAt, input.nowMs ?? Date.now()) });
    }
    const host = machine.metadata?.host;
    if (input.managedMeta === undefined && host && machine.metadata?.displayName && host !== machine.metadata.displayName) facts.push({ key: 'host', text: host });
    if (input.encryptionMode) {
        facts.push(input.encryptionMode === 'e2ee'
            ? { key: 'encryption', icon: 'lock', text: t('settingsAccount.endToEndEncrypted'), testID: 'machine-detail-encryption' }
            : { key: 'encryption', icon: 'lock-open', text: t('settingsAccount.notEndToEndEncrypted'), testID: 'machine-detail-encryption' });
    }
    const cliVersion = machine.daemonState?.cliVersion;
    if (cliVersion) facts.push({ key: 'cli', text: t('machineDetailPage.cliVersionFact', { version: cliVersion }) });
    if (input.replacedByMachineLabel) {
        facts.push({ key: 'replaced', text: t('machineDetailPage.replacedByFact', { machine: input.replacedByMachineLabel }) });
    }
    return facts;
}

/**
 * The machine page's one header, the same for every tab and in both doors (R2): the machine's mark
 * and name, what it is, its facts, then Start session and the machine's `⋯` (Rename, Apply
 * environment, Replace / Undo replacement).
 */
export const MachinePageHeader = React.memo(function MachinePageHeader(props: Readonly<{
    target: MachinePageTarget;
    managedIdentity: ManagedMachineHeaderIdentity | null;
    /** A new name is being saved. */
    renaming: boolean;
    onRename(): void;
}>) {
    const language = usePreferredLanguage();
    const { theme } = useUnistyles();
    const router = useRouter();
    const { target } = props;
    const machine = target.machine;
    const activeAccountScope = useActiveServerAccountScope();
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId);
    const machineAccountScope = binding?.isCurrent() ? binding.scope : null;
    const machineCanSpawn = React.useMemo(
        () => target.online === true && canAttemptMachineSpawn({ machine: machine ?? undefined, selectedMachineId: target.machineId, scope: machineAccountScope }),
        [machine, target.machineId, target.online, machineAccountScope],
    );
    const encryptionMode = useAccountEncryptionMode({
        enabled: !target.isServerSwitching && areServerProfileIdentifiersEquivalent(target.activeServerId, target.serverId),
    });
    const replacement = useMachineReplacementActions(target, machineAccountScope);
    // What the machine publishes (plan 20): its sentence under the name and, when it needs you, its one action.
    const daemonState: unknown = machine?.daemonState;
    const published = React.useMemo(() => readMachinePublishedResources(daemonState), [daemonState]);
    const headline = published && target.online && published.attention.level !== 'calm' ? selectHeadlineReason(published.attention) : null;
    const needsYouAction = headline ? resolveMachineReasonAction(headline) : null;
    // A row opened from the rail popover hands its mark + name rectangle over once (MPG-32): the header's mark and
    // name travel from it as one piece, and the sentence, facts and actions fade in over the travel's last part.
    const reducedMotion = useReducedMotionPreference();
    const [origin] = React.useState(() => (target.machineId ? takeMachineHeaderOrigin(machineHeaderOriginKey(target)) : null));
    const wrapPart = useMachineHeaderEnter(origin, reducedMotion);

    // The composer owns starting a session: once this machine is chosen its path chip lists the
    // machine's recent paths, so the page hands off with the machine and its Home seeded rather than
    // keeping a second launcher of its own.
    const handleStartSession = useMachineStartSession(target);
    // A shell on the machine opens through the terminal Action's own admission (agent parity); only the person
    // who manages the machine is offered one, only while it is online and its home folder is known (its details are
    // decrypted on this device); the sheet opens in that folder.
    const machineId = machine?.id;
    const machineName = props.managedIdentity && machine ? getMachineDisplayName({ ...machine, managedName: props.managedIdentity.name }) : target.machineName;
    const handleOpenTerminal = React.useCallback(() => {
        if (machineId) showMachineTerminalSheet({ serverId: target.serverId, machineId, machineName });
    }, [machineId, machineName, target.serverId]);
    const canOpenTerminal = target.online && machine?.isShared === false && readMachineTerminalHomeDir(machine) !== null;

    const meta = React.useMemo(() => machine ? composeMachinePageHeaderFacts({
        machine,
        online: target.online,
        managedMeta: props.managedIdentity?.meta,
        encryptionMode,
        replacedByMachineLabel: replacement.replacedByMachineLabel,
        hostFacts: published?.host ?? null,
    }) : [], [language, encryptionMode, machine, props.managedIdentity?.meta, published?.host, replacement.replacedByMachineLabel, target.online]);

    // Entity-header anatomy: presence in the meta, every machine action in one `⋯`.
    const { onRename, renaming } = props;
    const menuActions = React.useMemo((): PageHeaderMenuAction[] => {
        if (!machine) return [];
        const rename: PageHeaderMenuAction = {
            id: 'rename', testID: 'machine-detail-menu-rename', title: t('machine.renameTitle'), loading: renaming, onSelect: onRename,
        };
        // D53: apply a preset's tools and setup script to this machine; the Action itself asks first.
        const environmentApply: PageHeaderMenuAction[] = target.online && target.serverId ? [{
            id: 'environment-apply',
            testID: 'machine-detail-menu-environment-apply',
            title: t('machinePresets.environment.apply'),
            onSelect: () => showMachineEnvironmentApplySheet({ serverId: target.serverId, machineId: machine.id, machineName: target.machineName }),
        }] : [];
        // "Share…" opens the machine's one share sheet, full, with search and Done (lab m-share S); the
        // sheet's title names the machine, so the menu item doesn't repeat (and truncate) it.
        const share: PageHeaderMenuAction[] = activeAccountScope && target.serverId
            && areServerProfileIdentifiersEquivalent(activeAccountScope.serverId, target.serverId) ? [{
            id: 'share',
            testID: 'machine-detail-menu-share',
            title: t('shareSheet.documents.shareMenu'),
            onSelect: () => showMachineShareSheet({ machineId: machine.id, machineName: target.machineName,
                scope: activeAccountScope, online: target.online, subtitle: meta.map(fact => fact.text).join(' · ') || undefined }),
        }] : [];
        return [rename, ...share, ...environmentApply, ...replacement.menuActions];
    }, [language, activeAccountScope, machine, meta, onRename, renaming, replacement.menuActions, target.machineName, target.online, target.serverId]);

    const fallbackDescription = props.managedIdentity?.description ?? t('machineDetailPage.description');
    return (
        <PageHeader
            testID="machine-detail-header"
            wrapPart={wrapPart}
            alwaysShowTitle
            // The mark and the actions hang from the name's line; the sentence and facts wrap beneath it.
            actionsLayout="inline"
            title={machine ? target.machineName : t('machineDetailPage.placeholderTitle')}
            description={machine && (published || !target.online) ? (
                <MachineWorkingCountsProvider>
                    <MachineSentence serverId={target.serverId} machineId={machine.id} attention={published?.attention ?? null}
                        online={target.online} offlineLine={describeMachinePresenceLine(machine, undefined, undefined, machineAccountScope).label}
                        fallback={fallbackDescription} />
                </MachineWorkingCountsProvider>
            ) : fallbackDescription}
            leading={(
                <PageHeaderMarkSlot testID={props.managedIdentity ? 'machine-detail-managed-mark' : undefined}>
                    {props.managedIdentity?.mark ?? <Icon name="desktop" size={22} color={theme.colors.text.secondary} />}
                </PageHeaderMarkSlot>
            )}
            meta={meta}
            actions={machine ? (
                <View style={styles.actions}>
                    {/* A machine that needs you leads with its one action; Start session steps back (MPG-5). */}
                    {needsYouAction ? (
                        <RoundButton
                            testID="machine-detail-needs-you-action"
                            size="small"
                            title={needsYouAction.label}
                            onPress={() => {
                                if (target.machineId) beginMachinePageTabIntent({ serverId: target.serverId, machineId: target.machineId }, needsYouAction.tab);
                                router.setParams(machinePageTabRouteParams(needsYouAction.tab));
                            }}
                        />
                    ) : null}
                    <RoundButton
                        testID="machine-detail-start-session"
                        size="small"
                        // An offline machine keeps the action's place but not its weight: a disabled filled button would be the page's loudest thing.
                        display={needsYouAction || !target.online ? 'secondary' : undefined}
                        title={t('machineDetailPage.startAction')}
                        disabled={!machineCanSpawn}
                        onPress={handleStartSession}
                    />
                    {canOpenTerminal ? (
                        <RoundButton
                            testID="machine-detail-open-terminal"
                            size="small"
                            display="secondary"
                            title={t('machineDetailPage.openTerminalAction')}
                            leading={<Icon name="terminal" size={16} color={theme.colors.text.primary} />}
                            onPress={handleOpenTerminal}
                        />
                    ) : null}
                    <PageHeaderMenu testID="machine-detail-menu" actions={menuActions} />
                </View>
            ) : undefined}
        />
    );
});

/**
 * The header's entrance from a popover row (MPG-32, §4.12): its mark and its title are the two members of one
 * group, measured from the layout effect (web: `getBoundingClientRect`, before paint) and followed while they
 * travel, held unseen until the move is armed; everything else in the header is supporting content. Without an
 * origin nothing is wrapped.
 */
function useMachineHeaderEnter(origin: ReturnType<typeof takeMachineHeaderOrigin>, reducedMotion: boolean) {
    const enter = useEnterFromRect(origin, { reducedMotion });
    const markStyle = useEnterFromRectMember(enter.group, 0);
    const titleStyle = useEnterFromRectMember(enter.group, 1);
    // Each member is measured at an untransformed anchor around it, so a read during the move is its layout rect.
    const markRef = React.useRef<View>(null);
    const titleRef = React.useRef<View>(null);
    const { onTargets, retarget, contentStyle } = enter;
    React.useLayoutEffect(() => {
        if (!origin) return;
        return trackEnterFromRectTargets(() => Promise.all([measureInWindow(markRef.current), measureInWindow(titleRef.current)]), { onTargets, retarget });
    }, [onTargets, origin, retarget]);
    return React.useMemo(() => origin ? (part: 'mark' | 'title' | 'supporting', node: React.ReactNode) => (
        part === 'supporting'
            ? <Animated.View style={contentStyle}>{node}</Animated.View>
            : (
                <View ref={part === 'mark' ? markRef : titleRef} collapsable={false} style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
                    <Animated.View testID={`machine-detail-header-enter-${part}`} style={part === 'mark' ? markStyle : titleStyle}>
                        {node}
                    </Animated.View>
                </View>
            )
    ) : undefined, [contentStyle, markStyle, origin, titleStyle]);
}

/**
 * The sentence under a machine's name (R2): its lead word toned only when the machine needs a look
 * ("Short on memory. Swapping for 6 min. 2 sessions working."), "Calm. 3 sessions working." otherwise.
 */
const MachineSentence = React.memo(function MachineSentence(props: Readonly<{
    serverId: string;
    machineId: string;
    attention: NonNullable<ReturnType<typeof readMachinePublishedResources>>['attention'] | null;
    online: boolean | null;
    offlineLine: string;
    fallback: string;
}>) {
    const { theme } = useUnistyles();
    const working = useMachineWorkingCount({ serverId: props.serverId, machineId: props.machineId });
    const sentence = describeMachineSentence({ attention: props.attention, working, nowMs: Date.now(), online: props.online === true, offlineLine: props.offlineLine });
    if (!sentence) return <Text style={[styles.sentence, { color: theme.colors.text.secondary }]}>{props.fallback}</Text>;
    const leadColor = sentence.tone === 'calm' ? theme.colors.text.primary
        : resolveMachineAttentionWordColor(theme.colors);
    return (
        <Text testID="machine-detail-sentence" style={[styles.sentence, { color: theme.colors.text.primary }]}>
            <Text style={[styles.sentenceLead, { color: leadColor }]}>{sentence.lead}</Text>
            {' '}
            {sentence.rest}
        </Text>
    );
});

/** Replace this machine with another, or undo that: the header `⋯` owns both, with their confirmations. */
function useMachineReplacementActions(target: MachinePageTarget, accountScope: MachineReachabilityScope | null): Readonly<{
    menuActions: readonly PageHeaderMenuAction[];
    replacedByMachineLabel: string | null;
}> {
    const language = usePreferredLanguage();
    const machineListByServerId = useMachineListByServerId();
    const machine = target.machine;
    const machineId = target.machineId;
    const execution = useMountedActionExecution(target.serverId, { openOnRequest: true });
    const [replacingMachineId, setReplacingMachineId] = React.useState<string | null>(null);
    const [isClearingReplacement, setIsClearingReplacement] = React.useState(false);
    const allMachines = React.useMemo(
        () => machineListByServerId[target.serverId] ?? [],
        [machineListByServerId, target.serverId],
    );
    const reachabilityRevision = useMachineReachabilityRevision();
    const nowMs = useMachinePresenceNowMs(allMachines);

    const candidates = React.useMemo<MachineReplacementPickerCandidate[]>(() => {
        if (!machineId) return [];
        const eligible = allMachines.filter((candidate) => candidate.id !== machineId && !candidate.revokedAt && !candidate.replacedByMachineId);
        // Candidates are shown together, so same-named machines are told apart by the naming owner.
        const names = resolveMachineDisplayNames(eligible);
        return eligible.map((candidate) => {
            const label = names.get(candidate.id) ?? getMachineDisplayName(candidate);
            const reachability = resolveMachineReachability(accountScope, candidate, nowMs);
            return {
                id: candidate.id,
                label,
                subtitle: replacementCandidateSubtitle(candidate, label),
                online: reachability === 'unknown' ? null : reachability === 'reachable',
            };
        });
    }, [accountScope, allMachines, machineId, nowMs, reachabilityRevision]);

    const replace = React.useCallback((replacementMachineId: string) => {
        if (!machineId || replacingMachineId) return;
        fireAndForget((async () => {
            setReplacingMachineId(replacementMachineId);
            try {
                const outcome = await execution.execute('machines.replacement.set', {
                    serverId: target.serverId,
                    machineId,
                    replacementMachineId,
                    confirmActiveOldMachine: machine?.active === true,
                });
                if (!outcome.ok && (outcome.errorCode === 'cancelled' || isActionApprovalDeclinedErrorCode(outcome.errorCode))) return;
                const result = outcome.ok ? MachineReplacementOutputSchema.parse(outcome.result) : null;
                if (!result?.ok) {
                    await Modal.alertAsync(t('common.error'), resolveActionExecutionFailureMessage(outcome, t('machine.replacementRepair.error')) ?? t('machine.replacementRepair.error'));
                    return;
                }
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
            } finally {
                setReplacingMachineId(null);
            }
        })(), { tag: 'MachinePage.replaceMachine' });
    }, [execution, machine?.active, machineId, replacingMachineId, target.serverId]);

    const openPicker = React.useCallback(() => {
        if (!machineId || replacingMachineId || candidates.length === 0) return;
        Modal.show({
            component: MachineReplacementPickerModal,
            props: { candidates, onSelectCandidate: replace },
            chrome: {
                kind: 'card',
                title: t('machine.replacementRepair.pickerTitle'),
                testID: 'machine-replacement-picker-modal',
                scrollHost: 'bounded',
                bodyScroll: 'auto',
                dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.86, size: 'md' },
            },
            closeOnBackdrop: true,
        });
    }, [candidates, machineId, replace, replacingMachineId]);

    const clear = React.useCallback(() => {
        if (!machineId || isClearingReplacement) return;
        fireAndForget((async () => {
            setIsClearingReplacement(true);
            try {
                const outcome = await execution.execute('machines.replacement.clear', {
                    serverId: target.serverId, machineId,
                });
                if (!outcome.ok && (outcome.errorCode === 'cancelled' || isActionApprovalDeclinedErrorCode(outcome.errorCode))) return;
                const result = outcome.ok ? MachineReplacementOutputSchema.parse(outcome.result) : null;
                if (!result?.ok) {
                    await Modal.alertAsync(t('common.error'), resolveActionExecutionFailureMessage(outcome, t('machine.replacementRepair.error')) ?? t('machine.replacementRepair.error'));
                    return;
                }
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
            } finally {
                setIsClearingReplacement(false);
            }
        })(), { tag: 'MachinePage.clearMachineReplacement' });
    }, [execution, isClearingReplacement, machineId, target.serverId]);

    const replacedById = machine?.replacedByMachineId;
    const replacedByMachineLabel = React.useMemo(() => {
        if (!replacedById) return null;
        const replacement = allMachines.find((candidate) => candidate.id === replacedById);
        return replacement ? getMachineDisplayName(replacement) : replacedById;
    }, [allMachines, replacedById]);

    const menuActions = React.useMemo((): PageHeaderMenuAction[] => {
        if (replacedById) {
            return [{ id: 'undo-replacement', testID: 'machine-replacement-repair-undo', title: t('machine.replacementRepair.undo'),
                loading: isClearingReplacement, onSelect: clear }];
        }
        if (candidates.length > 0) {
            return [{ id: 'replace', testID: 'machine-replacement-repair-open', title: t('machine.replacementRepair.replaceWithMachine'),
                loading: replacingMachineId !== null, onSelect: openPicker }];
        }
        return [];
    }, [language, candidates.length, clear, isClearingReplacement, openPicker, replacedById, replacingMachineId]);

    return { menuActions, replacedByMachineLabel };
}
