import * as React from 'react';

import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { MachineProjectTerminalsSection } from '@/components/machines/MachineProjectTerminalsSection';
import { MachineRunsSection } from '@/components/machines/runs/MachineRunsSection';
import { MachineRecentSessionsSection } from '@/components/machines/sessions/MachineRecentSessionsSection';
import { MachineVitalsOverview } from '@/components/machines/vitals/MachineVitalsOverview';
import { MachineProjectWorkSection } from '@/components/projects/workers/MachineProjectWorkSection';
import { ManagedEnrolledMachineSectionsView } from '@/components/settings/machines/managed/ManagedMachineSections';
import { describeMachineRuntimePresence, projectMachineManagedPresence } from '@/utils/sessions/machinePresenceLine';
import { resolveManagedInstallationRecovery } from '@/components/settings/machines/managed/managedCreationPresentation';
import { splitHappierBannerPoint } from '@happier-dev/plugin-ui/presentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { CheckoutReachabilityScope } from '@/components/workspaces/reachability/checkoutReachability';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { MachineWhatRunsHereSection } from './MachineWhatRunsHereSection';
import { t } from '@/text';

import { MachineCapabilitiesSection } from './MachineCapabilitiesSection';
import { MachineThisMachineSection } from './MachineThisMachineSection';
import { MachineIsolationSummaryItem } from '@/components/machines/security/isolation/MachineIsolationSummaryRow';
import { MachineInventoryBlock } from './MachineInventoryBlock';
import { MachineResourcesAskBlock } from '@/components/machines/resources/ask/MachineResourcesAskBlock';
import { useMachinePageState } from './machinePageContext';
import type { MachinePageTabBodyProps } from './machinePageTabQuery';

/** The CLI commands the offline checks name; commands are never translated, so they are matched literally. */
const OFFLINE_HELP_COMMANDS = ['happier daemon status', 'happier self update'] as const;

/** The offline checks, one point per line of the translated help, with each command in the mono role. */
function offlineHelpPoints() {
    return t('machine.offlineHelp').split('\n')
        .map((line) => line.replace(/^\s*•\s*/, '').trim())
        .filter(Boolean)
        .map((line) => splitHappierBannerPoint(line, OFFLINE_HELP_COMMANDS));
}

/**
 * The machine page's Overview (MPG-8 as amended 2026-11-05): what blocks use first, then (for a machine Happier
 * created) Managed, then the machine's work in place (Project work: workers, then runs, recent sessions and project
 * terminals, each only once the machine has some), then plan 20's vitals body (CPU, memory, disk, network, what
 * else the machine reports and its Alerts) and Ask an agent, then "This machine", whose rows push its own settings
 * and diagnostics (lab `R`).
 */
export function MachineOverview(props: MachinePageTabBodyProps) {
    const { target, managedEnrolled, refreshKey, reload } = useMachinePageState();
    const machine = target.machine;
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId);
    const machineAccountScope = binding?.isCurrent() ? binding.scope : null;
    const canSpawn = React.useMemo(
        () => target.online && canAttemptMachineSpawn({ machine: machine ?? undefined, selectedMachineId: props.machineId, scope: machineAccountScope }),
        [machine, props.machineId, machineAccountScope, target.online],
    );
    // The unavailable banner's Retry: the page's reload, with its own progress on the button. It is
    // not a pull-to-refresh, so it neither records one nor spins the list's refresh control.
    const [retrying, setRetrying] = React.useState(false);
    const retry = React.useCallback(async () => {
        setRetrying(true);
        try {
            await reload();
        } finally {
            setRetrying(false);
        }
    }, [reload]);
    const offlineRetry = React.useMemo(() => ({ onPress: () => void retry(), loading: retrying }), [retry, retrying]);
    const { setParams } = props;
    const openProcesses = React.useCallback(() => setParams({ id: 'processes' }), [setParams]);
    const openIsolation = React.useCallback(() => setParams({ id: 'security', page: 'isolation' }), [setParams]);
    const triggerSubject = React.useMemo(() => ({ kind: 'machine' as const, machineId: props.machineId }), [props.machineId]);
    const reachabilityScope = React.useMemo(() => ({ serverId: props.serverId, machineId: props.machineId }), [props.serverId, props.machineId]);

    if (!machine) return null;
    const runtimePresence = describeMachineRuntimePresence(machine, undefined,
        projectMachineManagedPresence(machine, managedEnrolled.machine), machineAccountScope);
    // A created machine whose Happier went quiet says so once, on its recovery row with Restart (TH D6): the vitals
    // body then shows what it last reported without a second offline banner and Try again.
    const managedMachine = managedEnrolled.machine;
    const managedRecoveryExplains = managedMachine !== undefined && props.online === false
        && resolveManagedInstallationRecovery(managedMachine, null, { guestOnline: false }) === 'restartDaemon';
    // Plan 20's vitals body: live while this tab is shown, its history and Alerts row. Offline, it opens with the one
    // banner that says what being offline means, so it leads the page: the cause before the work it blocks (TH D-I).
    const offlineExplained = runtimePresence.nextAction !== 'retry' || managedRecoveryExplains;
    const vitals = (
        <MachineVitalsOverview serverId={props.serverId} machine={machine} machineName={props.machineName} online={props.online}
            onOpenProcesses={openProcesses}
            nativePresenceWord={runtimePresence.nativeWord}
            offlineRetry={runtimePresence.nextAction === 'retry' && !managedRecoveryExplains ? offlineRetry : undefined}
            offlineExplained={offlineExplained} />
    );
    // The vitals lead only while they carry the offline banner, the cause. A created machine that is asleep (or whose
    // Happier went quiet) is explained by its own state row ("Asleep · your next message or run starts it", lab m-life
    // W 1), so that leads and what it last reported follows the work, as last-known detail.
    const vitalsLead = props.online === false && !offlineExplained;
    return (
        // The vitals banner says once that the machine is offline; the sections below inherit it, never repeat it.
        <CheckoutReachabilityScope scope={reachabilityScope}>
            {/* An offline machine is a fact, not a fault: the vitals body below says it once, in its quiet banner above
                what the machine last reported (lab `rv` OS 3). Only a machine that is online but still cannot start
                sessions gets the checks. */}
            {props.online && !runtimePresence.showStatus && !canSpawn ? (
                <AttentionBanner
                    testID="machine-detail-unavailable"
                    tone="warning"
                    title={t('machineDetailPage.unavailableTitle')}
                    points={offlineHelpPoints()}
                    action={{ label: t('common.retry'), onPress: () => void retry(), loading: retrying, disabled: retrying }}
                />
            ) : null}
            {vitalsLead ? vitals : null}

            {/* A machine Happier created explains itself first (lab m-detail): Keep it, Managed from and
                what it was made with, beside its receipt, before the sections every machine has. */}
            <ManagedEnrolledMachineSectionsView enrolled={managedEnrolled} />

            {/* Project work first (owner 2026-11-05, MPG-8 amendment; lab m-detail "On it now"): what this machine takes on and
                runs now, then its runs, recent sessions and project terminals, each section present only once there is something in it. */}
            <MachineProjectWorkSection serverId={props.serverId} machineId={props.machineId} machineName={target.machineSentenceName} />
            <MachineRunsSection machine={machine} serverId={props.serverId} online={target.online}
                isServerSwitching={target.isServerSwitching} refreshKey={refreshKey} />
            <MachineRecentSessionsSection machineId={props.machineId} serverId={props.serverId} />
            <MachineProjectTerminalsSection machineId={props.machineId} serverId={props.serverId} />

            {/* What runs here (pfc-redesign mOv): the Environments this Machine runs, with the one environment row. */}
            <MachineWhatRunsHereSection serverId={props.serverId} machineId={props.machineId} lifetime={binding ?? null} />

            {vitalsLead ? null : vitals}

            {/* The page answers first; the agent is there when it is not enough (lab `ra` A1). */}
            <MachineResourcesAskBlock serverId={props.serverId} machineId={props.machineId} machineName={props.machineName} />

            {/* What runs here by itself (OPS-AUTOMATIONS-1102 D2): the Account's triggers on this machine, Add beside the title. */}
            <SubjectTriggersSection subject={triggerSubject} subjectName={props.machineName} serverId={props.serverId}
                offlineStatedAbove={props.online === false} />

            {/* What's on this Machine (S50 `i:machine`): everything Happier manages here, the same rows as Store → Installed. */}
            <MachineInventoryBlock serverId={props.serverId} machineId={props.machineId} scope={machineAccountScope}
                offline={props.online === false} />

            {/* Skills and MCP servers (Capabilities P8 U8.6): what sessions on this machine get, before This machine. */}
            <MachineCapabilitiesSection machineId={props.machineId} machineName={props.machineName} offline={props.online === false} />

            {/* The machine's own settings and diagnostics, one pushed page each; where work runs (said once by the
                isolation owner) sits among them and opens Security → Isolation. */}
            <MachineThisMachineSection serverId={props.serverId} machine={machine}
                isolationRow={<MachineIsolationSummaryItem serverId={props.serverId} machine={machine}
                    machineName={target.machineSentenceName} onOpen={openIsolation} testID="machine-overview-isolation-row" />} />
        </CheckoutReachabilityScope>
    );
}
