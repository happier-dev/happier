import * as React from 'react';
import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MachineAttachedPresetsChip } from './MachineAttachedPresetsChip';
import { beginMachinePageTabIntent } from './machinePageIntent';
import { machinePageTabRouteParams } from './machinePageTabQuery';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { MachineReplacementOutputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { MachineReplacementPickerModal, type MachineReplacementPickerCandidate } from '@/components/machines/MachineReplacementPickerModal';
import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';
import type { ManagedMachineHeaderIdentity } from '@/components/settings/machines/managed/ManagedMachineSections';
import { showMachineShareSheet } from '@/components/sharing/machines/MachineSharingSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveMachineSessionStart } from '@/components/sessions/new/modules/canCreateNewSession';
import { describeMachineDestinationEligibility } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import { describeMachineStartUnavailable, machineEditRolesHref, machineHeaderPrimary } from './machineStartAvailability';
import { useMachinesDoor } from './machinesDoor';
import { executeWorkspaceUiAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import type { MachinePageTabId } from './machinePageTabQuery';
import { useMachineListForServer, useMachineListForServerSelection } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

import { showMachineTerminalSheet } from '@/components/machines/terminal/MachineTerminalSheet';
import { useMachineShellAvailability } from '@/hooks/machine/useMachineShellAvailability';
import { resolveTerminalFailureMessage } from '@/components/sessions/terminal/terminalErrorCopy';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { readSafeFailureDetails, showActionFailureDetails } from '@/utils/errors/alertActionFailure';
import { useMachineStartSession } from './useMachineStartSession';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { describeMachineRuntimePresence } from '@/utils/sessions/machinePresenceLine';
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
import { machineDeploymentRoleSummary } from '@/components/machines/services/machineServicesPresentation';
import { useMachineDeploymentRoles } from '@/components/machines/services/useMachineServiceEnvironments';
import { deploymentEnvironmentRoute } from '@/components/projects/deployments/deploymentNavigation';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useMachinePagePresenceTarget, type MachinePageTarget } from './useMachinePageTarget';
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
type MachineRoleEnvironment = Readonly<{ environmentId: string; title: string; projectSourceId: string; roles: readonly string[] }>;

export function composeMachinePageHeaderFacts(input: Readonly<{
    machine: Machine;
    online: boolean | null;
    managedMeta: readonly PageHeaderMetaFact[] | undefined;
    /** A created machine's power word (Asleep, Starting…) from its presence owner: it leads the facts in place of Online. */
    managedPowerWord?: string | null;
    encryptionMode: 'e2ee' | 'plain' | null;
    replacedByMachineLabel: string | null;
    /** The machine's published host facts (plan 20): cores and memory, and when it booted. */
    hostFacts?: MachineVitalsHostFactsV1 | null;
    /** The Environments that reference this Machine, with their exact roles (lab J13 role chips). */
    roleEnvironments?: readonly MachineRoleEnvironment[];
    /** Opens an Environment a role chip names, when the chip names exactly one. */
    onOpenEnvironment?: (environment: MachineRoleEnvironment) => void;
    nowMs?: number;
}>): PageHeaderMetaFact[] {
    const { machine } = input;
    // The shared runtime sentence already names an unavailable or native-transition state.
    const presence = input.managedPowerWord || (input.online ? t('machineDetailPage.online') : null);
    const facts: PageHeaderMetaFact[] = [...(!presence ? [] : [{
        key: 'presence',
        text: presence,
        testID: 'machine-detail-presence',
    }]), ...(input.managedMeta ?? [])];
    // What the Machine does for Environments follows its presence (lab J13 "Online · Controller · Hetzner"): each role
    // once, saying what it means and for which Environments. A Machine with no role names none.
    const { onOpenEnvironment } = input;
    const roles: PageHeaderMetaFact[] = machineDeploymentRoleSummary(input.roleEnvironments ?? []).map(({ role, environments }) => {
        const only = environments.length === 1 ? environments[0]! : null;
        return {
            key: `role-${role}`,
            testID: `machine-detail-role-${role}`,
            text: t(`machineServices.roles.role.${role}`),
            // Which Environments it does this for, read out with the role (the chip's title in lab J13).
            accessibilityLabel: [t(`machineServices.roles.role.${role}`), ...environments.map(environment => environment.title)].join(' · '),
            ...(only && onOpenEnvironment ? { onPress: () => onOpenEnvironment(only) } : {}),
        };
    });
    const presenceEnd = facts.findIndex(fact => fact.key === 'presence') + 1;
    facts.splice(presenceEnd, 0, ...roles);
    // A machine shared with you says whose it is next (lab `m-share` T "Online · Ben's"); an owner without a public
    // name is left out, never drawn as a bare "'s".
    const owner = machine.isShared ? machine.access?.custodian.displayName?.trim() : undefined;
    if (owner) facts.push({ key: 'owner', testID: 'machine-detail-owner', text: t('machines.destinations.ownerOnly', { owner }) });
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
    // Managed identity has provider/native facts; the raw host remains in the machine's technical details.
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
    /** The open tab: Start session leads only the Overview (one primary per view). */
    tab?: MachinePageTabId;
}>) {
    const language = usePreferredLanguage();
    const { theme } = useUnistyles();
    const router = useRouter();
    const target = useMachinePagePresenceTarget(props.target);
    const machine = target.machine;
    const thisComputerMachineId = useThisComputerMachineId();
    const activeAccountScope = useActiveServerAccountScope();
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId);
    const machineAccountScope = binding?.isCurrent() ? binding.scope : null;
    // The composer's own decider (an asleep created Machine that wakes on send can start one), re-read on presence changes.
    const sessionStart = React.useMemo(() => machine ? resolveMachineSessionStart({ machine, selectedMachineId: target.machineId ?? null,
        scope: machineAccountScope }) : null, [machine, target.machineId, target.online, machineAccountScope]);
    const machineCanSpawn = sessionStart?.canStart === true;
    // Why Start session is disabled, said at the button (MR6), from the same owners that disabled it: the wake cause, else readiness.
    const wakeRefusal = machine && sessionStart && !sessionStart.eligibility.eligible
        && sessionStart.eligibility.reason === 'new_session_wake_unavailable'
        ? describeMachineDestinationEligibility(sessionStart.eligibility, machine) : undefined;
    const startReadiness = machineCanSpawn || !machine || wakeRefusal ? null
        : resolveMachineSpawnReadiness({ machine, selectedMachineId: target.machineId, scope: machineAccountScope });
    const startUnavailableReason = wakeRefusal ?? (startReadiness ? describeMachineStartUnavailable(startReadiness, target.machineSentenceName) : undefined);
    // Sessions are off on this Machine: the recovery is one tap away, through the canonical tab Action (machine roles).
    const door = useMachinesDoor();
    const editRolesHref = startReadiness?.status === 'roleInactive' && target.machineId
        ? machineEditRolesHref(door, { machineId: target.machineId, serverId: target.serverId }) : null;
    const handleEditRoles = React.useCallback(() => {
        if (!editRolesHref) return;
        void executeWorkspaceUiAction({ actionId: 'workspace.tabs.open', input: { href: editRolesHref, replace: true } },
            href => router.push(href));
    }, [editRolesHref, router]);
    const encryptionMode = useAccountEncryptionMode({
        enabled: !target.isServerSwitching && areServerProfileIdentifiersEquivalent(target.activeServerId, target.serverId),
    });
    const replacement = useMachineReplacementActions(target, machineAccountScope);
    // What the machine publishes (plan 20): its sentence under the name and, when it needs you, its one action.
    const daemonState: unknown = machine?.daemonState;
    const published = React.useMemo(() => readMachinePublishedResources(daemonState), [daemonState]);
    const attachedPresets = machine?.daemonState?.setup?.attachedPresets;
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
    // The terminal owner supplies the requester's admitted Shell root while this page is presented.
    const machineId = machine?.id;
    const presented = useLayoutPresentationActive();
    const machineShell = useMachineShellAvailability({ serverId: target.serverId, machineId,
        enabled: presented && target.online === true });
    const machineName = props.managedIdentity && machine
        ? getMachineDisplayName({ ...machine, managedName: props.managedIdentity.name }) : target.machineName;
    const handleOpenTerminal = React.useCallback(() => {
        if (machineId && machineShell.availability?.ok) showMachineTerminalSheet({ serverId: target.serverId, machineId, machineName, machineShell: machineShell.availability });
    }, [machineId, machineName, machineShell, target.serverId]);
    const canOpenTerminal = target.online && machineShell.state.kind === 'available';
    const shellFailure = machineShell.state.kind === 'unavailable' ? machineShell.failure : null;
    const shellUnavailableReason = shellFailure ? resolveTerminalFailureMessage(shellFailure) : null;

    // Roles come from the exact deployment references (plan 30 row 28), read only while the page is presented.
    const deploymentRoles = useMachineDeploymentRoles({ serverId: target.serverId, machineId: target.machineId ?? '',
        active: presented && Boolean(target.machineId) });
    const roleEnvironments = deploymentRoles.environments;
    const openRoleEnvironment = React.useCallback((environment: MachineRoleEnvironment) => {
        router.push(deploymentEnvironmentRoute({ serverId: target.serverId, projectSourceId: environment.projectSourceId,
            environmentId: environment.environmentId }));
    }, [router, target.serverId]);
    const runtimePresence = machine ? describeMachineRuntimePresence(machine, undefined, props.managedIdentity?.presence, machineAccountScope) : null;
    // A created machine says its power word once, first in its facts (lab m-detail "Asleep · disk kept"), not as a
    // sentence under its name.
    const managedPowerWord = props.managedIdentity?.presence && runtimePresence?.showStatus ? runtimePresence.label || null : null;
    const meta = React.useMemo(() => machine ? composeMachinePageHeaderFacts({
        machine,
        online: target.online && !runtimePresence?.showStatus,
        managedPowerWord,
        managedMeta: props.managedIdentity?.meta,
        encryptionMode,
        replacedByMachineLabel: replacement.replacedByMachineLabel,
        hostFacts: published?.host ?? null,
        roleEnvironments,
        onOpenEnvironment: openRoleEnvironment,
    }) : [], [language, encryptionMode, machine, managedPowerWord, props.managedIdentity?.meta, published?.host, replacement.replacedByMachineLabel, target.online, runtimePresence?.showStatus, roleEnvironments, openRoleEnvironment]);

    // Entity-header anatomy: presence in the meta, every machine action in one `⋯`.
    const { onRename, renaming } = props;
    const terminalInMenu = needsYouAction !== null && canOpenTerminal;
    const headerPrimary = machineHeaderPrimary({ tab: props.tab ?? 'overview', online: target.online === true, needsYou: needsYouAction !== null });
    const menuActions = React.useMemo((): PageHeaderMenuAction[] => {
        if (!machine) return [];
        const rename: PageHeaderMenuAction = {
            id: 'rename', testID: 'machine-detail-menu-rename', title: t('machine.renameTitle'), loading: renaming, onSelect: onRename,
        };
        // MACH-COMPOSE MR2: "Set up…" opens the Machine's Setup tab, where a preset, recipes and Tools are reviewed in place.
        const environmentApply: PageHeaderMenuAction[] = [{
            id: 'environment-apply',
            testID: 'machine-detail-menu-environment-apply',
            title: t('machineDetailPage.tabs.setupMenu'),
            onSelect: () => router.setParams(machinePageTabRouteParams({ id: 'setup' })),
        }];
        // "Share…" opens the machine's one share sheet, full, with search and Done (lab m-share S); the
        // sheet's title names the machine, so the menu item doesn't repeat (and truncate) it.
        const share: PageHeaderMenuAction[] = activeAccountScope && target.serverId
            && areServerProfileIdentifiersEquivalent(activeAccountScope.serverId, target.serverId) ? [{
            id: 'share',
            testID: 'machine-detail-menu-share',
            title: t('shareSheet.documents.shareMenu'),
            // The sheet's sentences name the machine as copy does ("this machine" while locked), like its Sharing page.
            onSelect: (intent) => showMachineShareSheet({ machineId: machine.id, machineName: target.machineSentenceName,
                scope: activeAccountScope, shared: machine.isShared === true,
                subtitle: meta.map(fact => fact.text).join(' · ') || undefined, anchor: intent?.anchor }),
        }] : [];
        // A leading needs-you action takes the third button's place, so the row keeps its size and the title never wraps.
        const terminal: PageHeaderMenuAction[] = terminalInMenu ? [{ id: 'open-terminal', testID: 'machine-detail-menu-open-terminal',
            title: t('machineDetailPage.openTerminalAction'), onSelect: handleOpenTerminal }] : [];
        if (!canManageMachine(machine)) return [...terminal, ...share];
        return [...terminal, rename, ...share, ...environmentApply, ...replacement.menuActions];
    }, [terminalInMenu, handleOpenTerminal, language, activeAccountScope, machine, meta, onRename, renaming, replacement.menuActions, router, target.serverId]);

    const fallbackDescription = props.managedIdentity?.description ?? t('machineDetailPage.description');
    return (
        <PageHeader
            testID="machine-detail-header"
            wrapPart={wrapPart}
            alwaysShowTitle
            // The mark and the actions hang from the name's line; the sentence and facts run beneath both (lab `rm` R).
            actionsLayout="hang"
            // Start session and the rest stay beside the Machine's identity, not folded into a phone's bar menu.
            actionsPlacement="page"
            title={machine ? machineName : t('machineDetailPage.placeholderTitle')}
            description={machine && !managedPowerWord && (published || runtimePresence?.showStatus) ? (
                <MachineWorkingCountsProvider>
                    <MachineSentence serverId={target.serverId} machineId={machine.id} attention={published?.attention ?? null}
                        online={target.online && !runtimePresence?.showStatus} offlineLine={runtimePresence?.label ?? ''}
                        fallback={fallbackDescription} />
                </MachineWorkingCountsProvider>
            ) : fallbackDescription}
            leading={(
                <PageHeaderMarkSlot testID={props.managedIdentity ? 'machine-detail-managed-mark' : undefined}>
                    {props.managedIdentity?.mark ?? <Icon name={resolveMachineKindGlyph({ isThisComputer: machine?.id === thisComputerMachineId, platform: machine?.metadata?.platform })} size={22} color={theme.colors.text.secondary} />}
                </PageHeaderMarkSlot>
            )}
            meta={meta}
            details={shellUnavailableReason && shellFailure ? (
                <SurfaceFreshnessLine testID="machine-detail-shell-unavailable" presentation="inline" glyph="terminal"
                    reason={shellUnavailableReason} action={{ label: t('approvals.technicalDetails'),
                        onPress: () => showActionFailureDetails({ code: shellFailure.errorCode,
                            context: readSafeFailureDetails(shellFailure.details) }) }} />
            ) : undefined}
            actions={machine ? (
                <View style={styles.actions}>
                    {attachedPresets?.length ? <MachineAttachedPresetsChip serverId={target.serverId} attached={attachedPresets}
                        onPress={() => router.setParams(machinePageTabRouteParams({ id: 'setup' }))} /> : null}
                    {/* A machine that needs you leads with its one action; Start session steps back (MPG-5). */}
                    {needsYouAction ? (
                        <RoundButton
                            testID="machine-detail-needs-you-action"
                            display={headerPrimary === 'needsYou' ? undefined : 'secondary'}
                            title={needsYouAction.label}
                            onPress={() => {
                                if (target.machineId) beginMachinePageTabIntent({ serverId: target.serverId, machineId: target.machineId }, needsYouAction.tab);
                                router.setParams(machinePageTabRouteParams(needsYouAction.tab));
                            }}
                        />
                    ) : null}
                    <RoundButton
                        testID="machine-detail-start-session"
                        // An offline machine keeps the action's place but not its weight: a disabled filled button would be the page's loudest thing.
                        display={headerPrimary === 'startSession' ? undefined : 'secondary'}
                        title={t('machineDetailPage.startAction')}
                        disabled={!machineCanSpawn}
                        disabledReason={startUnavailableReason}
                        onPress={handleStartSession}
                    />
                    {editRolesHref ? (
                        <RoundButton
                            testID="machine-detail-edit-roles"
                            display="secondary"
                            title={t('machineDetailPage.roles.editAction')}
                            onPress={handleEditRoles}
                        />
                    ) : null}
                    {canOpenTerminal && !terminalInMenu ? (
                        <RoundButton
                            testID="machine-detail-open-terminal"
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

function isReplacementCandidate(candidate: Machine, machineId: string): boolean {
    return candidate.id !== machineId && !candidate.revokedAt && !candidate.replacedByMachineId;
}

/**
 * The machines that can replace this one, with their names and presence, built only while the picker is
 * open: the closed header `⋯` needs just whether one exists, so other machines' publications and presence
 * clocks never redraw the page header.
 */
function MachineReplacementPicker(props: CustomModalInjectedProps & Readonly<{
    serverId: string;
    machineId: string;
    accountScope: MachineReachabilityScope | null;
    onSelectCandidate: (machineId: string) => void;
}>) {
    const { serverId, machineId, accountScope } = props;
    const machines = useMachineListForServer(serverId) ?? EMPTY_MACHINES;
    const eligible = React.useMemo(() => machines.filter((candidate) => isReplacementCandidate(candidate, machineId)), [machineId, machines]);
    const reachabilityRevision = useMachineReachabilityRevision();
    const nowMs = useMachinePresenceNowMs(eligible);
    const candidates = React.useMemo<MachineReplacementPickerCandidate[]>(() => {
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
    }, [accountScope, eligible, nowMs, reachabilityRevision]);
    return <MachineReplacementPickerModal onClose={props.onClose} candidates={candidates} onSelectCandidate={props.onSelectCandidate} />;
}

const EMPTY_MACHINES: readonly Machine[] = [];

/** Replace this machine with another, or undo that: the header `⋯` owns both, with their confirmations. */
function useMachineReplacementActions(target: MachinePageTarget, accountScope: MachineReachabilityScope | null): Readonly<{
    menuActions: readonly PageHeaderMenuAction[];
    replacedByMachineLabel: string | null;
}> {
    const language = usePreferredLanguage();
    const machine = target.machine;
    const machineId = target.machineId;
    const execution = useMountedActionExecution(target.serverId);
    const [replacingMachineId, setReplacingMachineId] = React.useState<string | null>(null);
    const [isClearingReplacement, setIsClearingReplacement] = React.useState(false);
    const replacedById = machine?.replacedByMachineId;
    // A boolean and a name from the Home's list: unchanged by other machines' daemon publications.
    const hasCandidates = useMachineListForServerSelection(target.serverId, React.useCallback(
        (machines: readonly Machine[]) => Boolean(machineId) && machines.some((candidate) => isReplacementCandidate(candidate, machineId)),
        [machineId]));
    const replacedByMachineLabel = useMachineListForServerSelection(target.serverId, React.useCallback((machines: readonly Machine[]) => {
        if (!replacedById) return null;
        const replacement = machines.find((candidate) => candidate.id === replacedById);
        return replacement ? getMachineDisplayName(replacement) : replacedById;
    // `language`: the fallback name is localized.
    }, [replacedById, language]));

    const replace = React.useCallback((replacementMachineId: string) => {
        if (!machineId || replacingMachineId) return;
        fireAndForget((async () => {
            setReplacingMachineId(replacementMachineId);
            try {
                const outcome = await execution.execute('machines.replacement.set', {
                    serverId: target.serverId,
                    machineId,
                    replacementMachineId,
                    confirmActiveOldMachine: machine ? readMachineActivity(machine).active : false,
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
    }, [execution, machine, machineId, replacingMachineId, target.serverId]);

    const openPicker = React.useCallback(() => {
        if (!machineId || replacingMachineId || !hasCandidates) return;
        Modal.show({
            component: MachineReplacementPicker,
            props: { serverId: target.serverId, machineId, accountScope, onSelectCandidate: replace },
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
    }, [accountScope, hasCandidates, machineId, replace, replacingMachineId, target.serverId]);

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

    const menuActions = React.useMemo((): PageHeaderMenuAction[] => {
        if (replacedById) {
            return [{ id: 'undo-replacement', testID: 'machine-replacement-repair-undo', title: t('machine.replacementRepair.undo'),
                loading: isClearingReplacement, onSelect: clear }];
        }
        if (hasCandidates) {
            return [{ id: 'replace', testID: 'machine-replacement-repair-open', title: t('machine.replacementRepair.replaceWithMachine'),
                loading: replacingMachineId !== null, onSelect: openPicker }];
        }
        return [];
    }, [language, hasCandidates, clear, isClearingReplacement, openPicker, replacedById, replacingMachineId]);

    return { menuActions, replacedByMachineLabel };
}
