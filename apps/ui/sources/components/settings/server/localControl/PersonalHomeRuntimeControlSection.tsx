import * as React from 'react';
import { View } from 'react-native';
import type { SystemTaskSpec } from '@happier-dev/protocol';
import { isHappierRuntimePathWithinRoot } from '@happier-dev/cli-common/happierRuntime/runtimePathMatching';

import { Modal } from '@/modal';
import { SystemTaskProgressCard } from '@/components/systemTasks';
import { resolveSystemTaskStepLabel } from '@/components/systemTasks/resolveSystemTaskStepLabel';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getPreferredLanguage, t, tLoose } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { useLocalRelayRuntimeControl } from './useLocalRelayRuntimeControl';
import { canCancelPersonalHomeOperationProgress } from './personalHomeOperationCancellation';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveHomeMemorySearchReadiness } from '@/sync/domains/memory/useMemorySearchProvider';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { isLoopbackServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import type { SystemTaskPromptEnvelope } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { createPersonalHomeErasePreviewContinuation } from './personalHomeEraseTaskContinuation';
import { bindPersonalHomeRelocationTaskContinuation } from './personalHomeRelocationTaskContinuation';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';

export type PersonalHomeRelocationDestination = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
}>;

export type PreparedPersonalHomeRelocationTask = Readonly<{
    withTaskSpec<T>(run: (spec: SystemTaskSpec, startSpec?: (spec: SystemTaskSpec) => Promise<string>) => Promise<T>): Promise<T>;
    respondToPrompt: (prompt: SystemTaskPromptEnvelope) => Promise<unknown>;
}>;

export type PersonalHomeRelocationRecovery = Readonly<{
    operationId: string;
    destinationMachineId: string;
    sourceDescriptorRevision: number;
    recoveryAction: 'finish_move' | 'return_to_source';
}>;

export type PersonalHomeRuntimeControlOperations = Readonly<{
    repairSearch?: () => Promise<boolean>;
    removeProfile?: () => Promise<void>;
    uninstallRuntime?: () => Promise<void>;
    openDataLocation?: (path: string) => Promise<void>;
    openLogs?: (path: string) => Promise<void>;
    revealBackupOutput?: (path: string) => Promise<void>;
    selectBackupArchive?: () => Promise<string | null>;
    selectBackupExportDestination?: () => Promise<string | null>;
    relocation?: Readonly<{
        destinations: readonly PersonalHomeRelocationDestination[];
        prepare: (destinationId: string) => Promise<PreparedPersonalHomeRelocationTask>;
        prepareRecovery?: (recovery: PersonalHomeRelocationRecovery) => Promise<PreparedPersonalHomeRelocationTask>;
    }>;
}>;

function readPersonalHomeRelocationRecovery(value: unknown): PersonalHomeRelocationRecovery | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    const personalHome = data.personalHome;
    if (data.action !== 'personalHome.relocate' || !personalHome || typeof personalHome !== 'object' || Array.isArray(personalHome)) {
        return null;
    }
    const facts = personalHome as Record<string, unknown>;
    const operationId = typeof facts.operationId === 'string' ? facts.operationId.trim() : '';
    const destinationMachineId = typeof facts.destinationMachineId === 'string' ? facts.destinationMachineId.trim() : '';
    const sourceDescriptorRevision = facts.sourceDescriptorRevision;
    const recoveryAction = facts.recoveryAction;
    if (!operationId || !destinationMachineId || typeof sourceDescriptorRevision !== 'number'
        || !Number.isSafeInteger(sourceDescriptorRevision) || sourceDescriptorRevision < 1
        || (recoveryAction !== 'finish_move' && recoveryAction !== 'return_to_source')) {
        return null;
    }
    return { operationId, destinationMachineId, sourceDescriptorRevision, recoveryAction };
}

function resolveSearchStatusLabel(readiness: 'ready' | 'indexing' | 'unavailable' | 'unknown'): string {
    if (readiness === 'ready') return t('personalHome.settings.searchReady');
    if (readiness === 'indexing') return t('personalHome.settings.searchIndexing');
    if (readiness === 'unavailable') return t('personalHome.settings.searchUnavailable');
    return t('personalHome.settings.notAvailable');
}

function formatBytes(bytes: number | null): string {
    if (bytes == null) return t('personalHome.settings.unknownSize');
    return formatByteSize(bytes);
}

function formatTimestamp(value: string | null): string {
    if (!value) return t('personalHome.settings.unknownTimestamp');
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? t('personalHome.settings.unknownTimestamp')
        : formatWithCachedDateTimeFormatter(parsed, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
}


type PersonalHomeDetailRow = Readonly<{
    testID?: string;
    title: string;
    value: string;
}>;

function formatIdentityComparison(value: string | null): string {
    if (value === 'match') return t('personalHome.settings.identityComparisonMatch');
    if (value === 'mismatch') return t('personalHome.settings.identityComparisonMismatch');
    if (value === 'unknown') return t('personalHome.settings.identityComparisonUnknown');
    return t('personalHome.settings.notAvailable');
}

const PersonalHomeDetailRows = React.memo(function PersonalHomeDetailRows(props: Readonly<{
    testID: string;
    title: string;
    rows: readonly PersonalHomeDetailRow[];
}>) {
    const [expanded, setExpanded] = React.useState(false);
    return <>
        <Item
            testID={props.testID}
            title={props.title}
            onPress={() => setExpanded((value) => !value)}
            accessibilityExpanded={expanded}
        />
        {expanded ? <View testID={`${props.testID}Panel`}>
            <ItemGroup>
                {props.rows.map((row, index) => <Item
                    key={`${row.title}:${index}`}
                    testID={row.testID}
                    title={row.title}
                    subtitle={row.value}
                    subtitleLines={0}
                    showChevron={false}
                    mode="info"
                />)}
            </ItemGroup>
        </View> : null}
    </>;
});

type EraseBackupRecovery = Readonly<{
    path: string;
    /** Why the erase stopped after the backup: it is of another Home, or that could not be confirmed. */
    reason: 'mismatch' | 'unknown';
}>;

type PersonalHomeLastOperation = NonNullable<ReturnType<typeof useLocalRelayRuntimeControl>['lastOperation']>;
type PersonalHomeEraseResult = Extract<PersonalHomeLastOperation, { operation: 'erase' }>['erase'];
type PersonalHomeRestoreResult = Extract<PersonalHomeLastOperation, { operation: 'restore' }>['restore'];

function resolveEraseBlockedReason(reason: EraseBackupRecovery['reason']): string {
    return reason === 'mismatch'
        ? t('personalHome.settings.eraseBlockedBackupMismatch')
        : t('personalHome.settings.eraseBlockedIdentityUnknown');
}

function resolveEraseResultTitle(erase: PersonalHomeEraseResult): string {
    if (erase.outcome === 'partial') return t('personalHome.settings.erasePartialTitle');
    if (erase.outcome === 'completed_with_cleanup_attention') return t('personalHome.settings.eraseInspectionAttention');
    return t('personalHome.settings.eraseResultTitle');
}

/** Safe outcome sentences: counts and runtime state only, never paths or daemon prose. */
function resolveEraseResultSentences(erase: PersonalHomeEraseResult): string[] {
    return [
        t('personalHome.settings.eraseOutcomeSummary', {
            removed: erase.removedPaths.length,
            remaining: erase.remainingOwnedPaths.length + erase.remainingUnknownPaths.length,
        }),
        erase.stoppedRunningHome
            ? t('personalHome.settings.eraseStoppedHome')
            : t('personalHome.settings.eraseHomeAlreadyStopped'),
    ];
}

function resolveEraseResultDetailRows(erase: PersonalHomeEraseResult): PersonalHomeDetailRow[] {
    const remainingPaths = [...erase.remainingOwnedPaths, ...erase.remainingUnknownPaths];
    return [
        ...(remainingPaths.length > 0
            ? [{ title: t('personalHome.settings.eraseRemainingPaths'), value: remainingPaths.join('\n') }]
            : []),
        ...(erase.error ? [{ title: tLoose('common.error'), value: erase.error }] : []),
        ...(erase.inspectionError
            ? [{ title: t('personalHome.settings.eraseVerificationDetail'), value: erase.inspectionError }]
            : []),
    ];
}

function resolveRestoreOutcome(restore: PersonalHomeRestoreResult): string {
    if (restore.outcome === 'recovery_required') return t('personalHome.settings.restoreOutcomeRecoveryRequired');
    if (restore.outcome === 'rolled_back') return t('personalHome.settings.restoreOutcomeRolledBack');
    return t('personalHome.settings.restoreOutcomeRestored');
}

/**
 * One announcement for the newest data-operation outcome on this surface: an
 * erase that stopped after its backup, an erase result, or a restore result.
 * Each new outcome gets a new transition, so an identical repeat is spoken again.
 */
function useOperationOutcomeAnnouncement(
    eraseBackupRecovery: EraseBackupRecovery | null,
    lastOperation: PersonalHomeLastOperation | null,
): Readonly<{ text: string; transitionKey: string }> {
    const operationOutcome = lastOperation?.operation === 'erase' || lastOperation?.operation === 'restore'
        ? lastOperation : null;
    const [revision, setRevision] = React.useState(() => ({
        eraseBackupRecovery,
        lastOperation,
        outcome: eraseBackupRecovery ?? operationOutcome,
        count: 0,
    }));
    let current = revision;
    if (revision.eraseBackupRecovery !== eraseBackupRecovery || revision.lastOperation !== lastOperation) {
        // Whichever source changed most recently owns the announcement. Keep the
        // blocked-erase backup visible, but never let it mask a later restore.
        current = {
            eraseBackupRecovery,
            lastOperation,
            outcome: revision.lastOperation !== lastOperation ? operationOutcome : eraseBackupRecovery,
            count: revision.count + 1,
        };
    }
    if (current !== revision) setRevision(current);

    const outcome = current.outcome;

    if (!outcome) return { text: '', transitionKey: `idle:${current.count}` };
    if (!('operation' in outcome)) {
        return {
            text: [t('personalHome.settings.eraseNotPerformed'), resolveEraseBlockedReason(outcome.reason)].join('. '),
            transitionKey: `erase_blocked:${current.count}`,
        };
    }
    if (outcome.operation === 'restore') {
        return { text: resolveRestoreOutcome(outcome.restore), transitionKey: `restore:${current.count}` };
    }
    return {
        text: [resolveEraseResultTitle(outcome.erase), ...resolveEraseResultSentences(outcome.erase)].join('. '),
        transitionKey: `erase:${current.count}`,
    };
}

function resolveRuntimeStatusSubtitle(control: ReturnType<typeof useLocalRelayRuntimeControl>): string {
    if (control.isUnavailable) return t('settings.systemTaskBridgeUnavailable');
    if (!control.status) return t('settings.localRelayRuntime.statusChecking');
    if (!control.status.installed) return t('settings.localRelayRuntime.statusNotInstalled');
    if (control.status.service.active !== true) return t('settings.localRelayRuntime.statusStopped');
    return control.status.healthy
        ? t('settings.localRelayRuntime.statusRunningHealthy')
        : t('settings.localRelayRuntime.statusRunningNeedsAttention');
}

async function runExternalOperation(run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (error) {
        await Modal.alert(tLoose('common.error'), error instanceof Error ? error.message : String(error));
    }
}

async function createPersonalHomeBackupAfterConfirmation<T>(create: () => Promise<T>): Promise<T | null> {
    const accepted = await Modal.confirm(
        t('personalHome.settings.backupAction'),
        t('personalHome.settings.backupDisclosureBody'),
        { confirmText: t('personalHome.settings.backupAction') },
    );
    return accepted ? await create() : null;
}

type PersonalHomeRuntimeControlSectionProps = Readonly<{
    runner?: SystemTaskRunner;
    controller?: ReturnType<typeof useLocalRelayRuntimeControl>;
    operations?: PersonalHomeRuntimeControlOperations;
    homeLabel?: string;
    onStatusChange?: (status: ReturnType<typeof useLocalRelayRuntimeControl>['status']) => void;
}>;

function OwnedPersonalHomeRuntimeControlSection(props: PersonalHomeRuntimeControlSectionProps) {
    const controller = useLocalRelayRuntimeControl({ ...(props.runner ? { runner: props.runner } : {}) });
    return <PersonalHomeRuntimeControlSectionContent {...props} controller={controller} />;
}

const PersonalHomeRuntimeControlSectionContent = React.memo(function PersonalHomeRuntimeControlSectionContent(
    props: PersonalHomeRuntimeControlSectionProps & Readonly<{ controller: ReturnType<typeof useLocalRelayRuntimeControl> }>,
) {
    const control = props.controller;
    const [eraseBackupRecovery, setEraseBackupRecovery] = React.useState<EraseBackupRecovery | null>(null);
    const personalHomeCanonicalServerUrl = control.status?.purpose?.kind === 'personal-home'
        ? control.status.purpose.canonicalServerUrl
        : null;
    const homeSearchServerId = resolveServerProfileScopeIdForIdentifier(control.inspection?.homeServerIdentityId ?? null);
    const homeFeaturesSnapshot = useServerFeaturesSnapshotForServerId(homeSearchServerId || null);
    const homeSearchReadiness = homeFeaturesSnapshot.status === 'ready'
        ? resolveHomeMemorySearchReadiness(homeFeaturesSnapshot.features.capabilities.homeSearch)
        : 'unknown';

    React.useEffect(() => {
        if (!control.isUnavailable && personalHomeCanonicalServerUrl) void control.refreshInspection();
        // refreshInspection is stable for the lifetime of the selected runner.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [control.isUnavailable, personalHomeCanonicalServerUrl]);

    React.useEffect(() => {
        props.onStatusChange?.(control.status);
    }, [control.status, props.onStatusChange]);

    const backup = React.useCallback(async () => {
        return await createPersonalHomeBackupAfterConfirmation(() => control.backupPersonalHome()) !== null;
    }, [control]);

    const exportBackup = React.useCallback(async () => {
        await createPersonalHomeBackupAfterConfirmation(async () => {
            const outputPath = (await props.operations?.selectBackupExportDestination?.())?.trim();
            if (!outputPath) return null;
            return await control.backupPersonalHome({ outputPath });
        });
    }, [control, props.operations]);

    const restore = React.useCallback(async () => {
        const archivePath = (await props.operations?.selectBackupArchive?.())?.trim();
        if (!archivePath) return;
        const verified = await control.verifyPersonalHomeBackup({ archivePath });
        if (!verified) return;
        const inspectionOutcome = await control.refreshInspection();
        if (inspectionOutcome.status === 'failed') {
            await Modal.alert(tLoose('common.error'), inspectionOutcome.message);
            return;
        }
        const destinationInspection = inspectionOutcome.inspection;
        if (destinationInspection.destinationEmpty == null) {
            await Modal.alert(
                t('personalHome.settings.restoreRecoveryWarningTitle'),
                t('personalHome.settings.restoreRecoveryWarningBody'),
            );
            return;
        }
        const overwriteNeeded = !destinationInspection.destinationEmpty;
        if (overwriteNeeded) {
            const summary = [
                `${t('personalHome.settings.restoreBackupTitle')}: ${archivePath}`,
                `${t('personalHome.settings.identityTitle')}: ${verified.homeServerIdentityId ?? t('personalHome.settings.identityUnavailable')}`,
                `${t('personalHome.settings.restoreBackupDate')}: ${formatTimestamp(verified.createdAt)}`,
                `${t('personalHome.settings.restoreCompatibility')}: ${verified.format === 'happier-personal-home-backup' && verified.version === 1 ? t('personalHome.settings.restoreCompatible') : t('personalHome.settings.restoreCompatibilityVerified')}`,
                verified.archiveBytes == null ? null : `${t('personalHome.settings.restoreBackupSize')}: ${formatBytes(verified.archiveBytes)}`,
                t('personalHome.settings.restoreReplacementNotice'),
            ].filter((value): value is string => value !== null).join('\n');
            if (!await Modal.confirm(
                t('personalHome.settings.restoreConfirmTitle'),
                summary,
                { confirmText: t('personalHome.settings.restoreConfirmAction'), destructive: true },
            )) return;
        }
        await control.restorePersonalHomeBackup({ archivePath, overwriteConfirmed: overwriteNeeded, verification: verified });
    }, [control, props.operations]);

    const verify = React.useCallback(async () => {
        const archivePath = (await props.operations?.selectBackupArchive?.())?.trim();
        if (archivePath) await control.verifyPersonalHomeBackup({ archivePath });
    }, [control, props.operations]);

    const erase = React.useCallback(async () => {
        let verifiedBackupHomeServerIdentityId: string | null = null;
        let verifiedBackupPath: string | null = null;
        let eraseChoice: 'backup_first' | 'without_backup' | 'cancel' = 'cancel';
        await Modal.alertAsync(
            t('personalHome.settings.eraseBackupOfferTitle'),
            t('personalHome.settings.eraseBackupOfferBody'),
            [
                { text: t('common.cancel'), style: 'cancel', onPress: () => { eraseChoice = 'cancel'; } },
                { text: t('personalHome.settings.eraseContinueWithoutBackup'), onPress: () => { eraseChoice = 'without_backup'; } },
                { text: t('personalHome.settings.backupAction'), onPress: () => { eraseChoice = 'backup_first'; } },
            ],
        );
        if (eraseChoice === 'cancel') return;
        // Every real attempt supersedes an earlier stopped-after-backup notice, so
        // it can never mask (on screen or to a screen reader) this attempt's result.
        setEraseBackupRecovery(null);
        if (eraseChoice === 'backup_first') {
            const requestedOutputPath = (await props.operations?.selectBackupExportDestination?.())?.trim() || null;
            if (!requestedOutputPath) return;
            // This safety composition owns the next fresh inspection. Suppress
            // backup's passive refresh so it cannot race archive verification
            // for the canonical fail-fast Home operation lease.
            const created = await control.backupPersonalHome({
                outputPath: requestedOutputPath,
                refreshAfterSuccess: false,
            });
            if (!created || !requestedOutputPath) return;
            const createdAtRequestedDestination = isHappierRuntimePathWithinRoot(created.path, requestedOutputPath)
                && isHappierRuntimePathWithinRoot(requestedOutputPath, created.path);
            if (!createdAtRequestedDestination) {
                await Modal.alert(
                    tLoose('common.error'),
                    t('personalHome.settings.backupDestinationMismatch'),
                );
                return;
            }
            const verified = await control.verifyPersonalHomeBackup({ archivePath: created.path });
            if (!verified) return;
            if (verified.identityMatchesCurrentHome !== 'match' || !verified.homeServerIdentityId) {
                setEraseBackupRecovery({
                    path: created.path,
                    reason: verified.identityMatchesCurrentHome === 'mismatch' ? 'mismatch' : 'unknown',
                });
                return;
            }
            verifiedBackupHomeServerIdentityId = verified.homeServerIdentityId;
            verifiedBackupPath = created.path;
            const reboundStatus = await control.readStatus();
            if (reboundStatus?.purpose?.kind !== 'personal-home') {
                setEraseBackupRecovery({ path: created.path, reason: 'unknown' });
                return;
            }
        }
        const inspectionOutcome = await control.refreshInspection();
        if (inspectionOutcome.status === 'failed') {
            await Modal.alert(tLoose('common.error'), inspectionOutcome.message);
            return;
        }
        if (verifiedBackupHomeServerIdentityId !== null
            && inspectionOutcome.inspection.homeServerIdentityId !== verifiedBackupHomeServerIdentityId) {
            if (verifiedBackupPath !== null) setEraseBackupRecovery({ path: verifiedBackupPath, reason: 'mismatch' });
            return;
        }
        if (verifiedBackupPath !== null
            && inspectionOutcome.inspection.ownedErasePaths.some((ownedPath) => (
                isHappierRuntimePathWithinRoot(verifiedBackupPath, ownedPath)
            ))) {
            await Modal.alert(
                tLoose('common.error'),
                t('personalHome.settings.backupDestinationUnsafe'),
            );
            return;
        }
        const promptContinuation = createPersonalHomeErasePreviewContinuation({ verifiedBackupHomeServerIdentityId, verifiedBackupPath });
        await control.erasePersonalHomeData(promptContinuation);
    }, [control, props.operations]);

    const repairSearch = React.useCallback(async () => {
        if (await props.operations?.repairSearch?.() !== true) return;
        await Modal.alert(
            t('personalHome.settings.repairSearchCompleteTitle'),
            t('personalHome.settings.repairSearchCompleteBody'),
        );
    }, [props.operations]);

    const [relocationMenuOpen, setRelocationMenuOpen] = React.useState(false);
    const startRelocationTask = React.useCallback(async (prepared: PreparedPersonalHomeRelocationTask) => {
        await prepared.withTaskSpec((spec, startSpec) => control.startExternalOperation(spec, {
            promptContinuation: bindPersonalHomeRelocationTaskContinuation(prepared.respondToPrompt), startSpec,
        }));
    }, [control]);
    const relocate = React.useCallback(async (destination: PersonalHomeRelocationDestination) => {
        const relocation = props.operations?.relocation;
        if (!relocation) return;
        const accepted = await Modal.confirm(
            t('personalHome.settings.relocateConfirmTitle'),
            `${t('personalHome.settings.relocateConfirmBody')}`
                + `\n\n${t('personalHome.settings.relocateDestination')}: ${destination.title}`,
            { confirmText: t('personalHome.settings.relocateConfirmAction'), destructive: true },
        );
        if (!accepted) return;
        const prepared = await relocation.prepare(destination.id);
        await startRelocationTask(prepared);
    }, [props.operations?.relocation, startRelocationTask]);

    const recoverRestore = React.useCallback(async () => {
        const targets = control.inspection?.restoreRecovery.affectedTargets ?? [];
        if (control.inspection?.restoreRecovery.status !== 'rollback_available' || targets.length === 0) return;
        const confirmed = await Modal.confirm(
            t('personalHome.settings.recoverRestoreTitle'),
            t('personalHome.settings.recoverRestoreBody'),
            { confirmText: t('personalHome.settings.recoverRestoreAction'), destructive: true },
        );
        if (confirmed) await control.recoverPersonalHomeRestore();
    }, [control]);

    const [operationDetailsOpen, setOperationDetailsOpen] = React.useState(false);

    const disabled = control.isBusy || control.isUnavailable || control.status?.purpose?.kind !== 'personal-home';
    const operationsUnavailableReason = !disabled || control.isBusy
        ? null
        : control.isUnavailable
            ? t('settings.systemTaskBridgeUnavailable')
            : t('settings.localRelayRuntime.statusChecking');
    const terminalRelocationRecovery = control.operationSnapshot?.result?.ok
        ? readPersonalHomeRelocationRecovery(control.operationSnapshot.result.data)
        : null;
    const inspectionRelocationRecovery = control.inspection?.relocationRecovery ?? null;
    const finishRelocationRecovery = terminalRelocationRecovery?.recoveryAction === 'finish_move'
        ? terminalRelocationRecovery
        : inspectionRelocationRecovery
            ? {
                operationId: inspectionRelocationRecovery.operationId,
                destinationMachineId: inspectionRelocationRecovery.destinationMachineId,
                sourceDescriptorRevision: inspectionRelocationRecovery.sourceDescriptorRevision,
                recoveryAction: inspectionRelocationRecovery.primaryAction,
            }
            : null;
    // Returning is offered only while the durable facts still carry it: once
    // publication moved authority to the destination, finishing is the only
    // authority-safe action.
    const returnRelocationRecovery = terminalRelocationRecovery?.recoveryAction === 'return_to_source'
        ? terminalRelocationRecovery
        : inspectionRelocationRecovery?.secondaryAction
            ? {
                operationId: inspectionRelocationRecovery.operationId,
                destinationMachineId: inspectionRelocationRecovery.destinationMachineId,
                sourceDescriptorRevision: inspectionRelocationRecovery.sourceDescriptorRevision,
                recoveryAction: inspectionRelocationRecovery.secondaryAction,
            }
            : null;
    const recoverRelocation = React.useCallback(async (recovery: PersonalHomeRelocationRecovery) => {
        const relocation = props.operations?.relocation;
        if (!relocation?.prepareRecovery) return;
        await startRelocationTask(await relocation.prepareRecovery(recovery));
    }, [props.operations?.relocation, startRelocationTask]);
    const backupResult = control.lastOperation?.operation === 'backup' ? control.lastOperation.backup : null;
    const restoreResult = control.lastOperation?.operation === 'restore' ? control.lastOperation.restore : null;
    const restoreRecoveryBackup = restoreResult?.recoveryArchive ?? null;
    const eraseResult = control.lastOperation?.operation === 'erase' ? control.lastOperation.erase : null;
    const eraseResultDetailRows = eraseResult ? resolveEraseResultDetailRows(eraseResult) : [];
    const operationAnnouncement = useOperationOutcomeAnnouncement(eraseBackupRecovery, control.lastOperation);
    const operations = props.operations;
    const relocationItems = React.useMemo<readonly DropdownMenuItem[]>(() => (
        operations?.relocation?.destinations.map((destination) => ({
            id: destination.id,
            title: destination.title,
            ...(destination.subtitle ? { subtitle: destination.subtitle } : {}),
        })) ?? []
    ), [operations?.relocation?.destinations]);
    const backupInventoryComplete = control.inspection?.backupsCountComplete !== false;
    // A parser-limited inventory exposes a confirmed lower bound, but cannot prove that its newest
    // inspected manifest is the latest across every retained archive.
    const latestBackup = backupInventoryComplete ? control.inspection?.latestBackup ?? null : null;
    const canCancel = control.operationSnapshot?.result == null
        && canCancelPersonalHomeOperationProgress(
            control.activeOperationSpec?.kind ?? null,
            control.operationSnapshot?.currentStepId ?? null,
            control.activeOperationSpec?.params,
        );
    const operationPhase = control.operationSnapshot
        ? resolveSystemTaskStepLabel(control.operationSnapshot.currentStepId) ?? control.operationSnapshot.latestMessage
        : null;

    React.useEffect(() => {
        setOperationDetailsOpen(false);
    }, [control.operationSnapshot?.taskId]);

    const canStart = !control.isUnavailable && control.status?.installed === true && control.status.service.active !== true && !control.isBusy;
    const canStop = !control.isUnavailable && control.status?.service.active === true && !control.isBusy;
    const homeLabel = props.homeLabel?.trim() || t('personalHome.settings.defaultHomeLabel');
    // Search readiness and public reachability are facts this Home already publishes.
    // Read them through their existing owners instead of probing or re-deriving here.
    const searchStatusLabel = resolveSearchStatusLabel(homeSearchReadiness);
    const localOnlyIngress = personalHomeCanonicalServerUrl !== null
        && isLoopbackServerUrl(control.status?.relayUrl ?? personalHomeCanonicalServerUrl);

    return <>
        <ItemGroup title={t('personalHome.settings.summaryTitle')} description={t('personalHome.settings.footer')}>
            <Item testID="settings.localRelayRuntime.status" title={t('personalHome.settings.statusTitle')} subtitle={resolveRuntimeStatusSubtitle(control)} showChevron={false} mode="info" />
            <Item testID="settings.personalHomeRuntime.home" title={t('personalHome.settings.homeTitle')} subtitle={homeLabel} showChevron={false} mode="info" />
            {control.inspection ? <PersonalHomeDetailRows
                testID="settings.personalHomeRuntime.homeDetails"
                title={`${t('personalHome.settings.homeTitle')} · ${t('common.details')}`}
                rows={[
                    { title: t('personalHome.settings.homeTitle'), value: homeLabel },
                    { testID: 'settings.personalHomeRuntime.homeIdentity', title: t('personalHome.settings.identityTitle'), value: control.inspection.homeServerIdentityId ?? t('personalHome.settings.identityUnavailable') },
                    { title: t('personalHome.settings.canonicalAddress'), value: control.status?.relayUrl ?? t('personalHome.settings.notAvailable') },
                ]}
            /> : null}
            <Item testID="settings.personalHomeRuntime.storage" title={t('personalHome.settings.storageTitle')} subtitle={formatBytes(control.inspection?.databaseBytes ?? null)} showChevron={false} mode="info" />
            <Item testID="settings.personalHomeRuntime.search" title={t('personalHome.settings.searchTitle')} subtitle={searchStatusLabel} showChevron={false} mode="info" />
            {localOnlyIngress ? <Item
                testID="settings.personalHomeRuntime.localOnlyIngress"
                title={t('personalHome.settings.localOnlyIngressTitle')}
                subtitle={t('personalHome.settings.localOnlyIngressBody')}
                subtitleLines={0}
                showChevron={false}
                mode="info"
            /> : null}
            <Item testID="settings.personalHomeRuntime.masterSecret" title={t('personalHome.settings.masterSecretTitle')} subtitle={control.inspection?.masterSecretPresent ? t('personalHome.settings.masterSecretPresent') : t('personalHome.settings.masterSecretUnavailable')} showChevron={false} mode="info" />
            <Item testID="settings.personalHomeRuntime.inspect" title={t('personalHome.settings.inspectAction')} onPress={() => void control.refreshInspection()} disabled={disabled} />
        </ItemGroup>
        <ItemGroup title={t('personalHome.settings.actionsTitle')} description={t('personalHome.settings.backupDisclosureBody')}>
            {operationsUnavailableReason ? <Item
                testID="settings.personalHomeRuntime.operationsUnavailable"
                title={t('personalHome.settings.notAvailable')}
                subtitle={operationsUnavailableReason}
                subtitleLines={0}
                showChevron={false}
                mode="info"
            /> : null}
            <Item testID="settings.personalHomeRuntime.backup" title={t('personalHome.settings.backupAction')} subtitle={t('personalHome.settings.backupSubtitle')} onPress={() => void backup()} disabled={disabled} />
            {operations?.selectBackupExportDestination ? <Item testID="settings.personalHomeRuntime.exportBackup" title={t('personalHome.settings.exportBackupAction')} subtitle={t('personalHome.settings.exportBackupSubtitle')} onPress={() => void runExternalOperation(exportBackup)} disabled={disabled} /> : null}
            {operations?.selectBackupArchive ? <Item testID="settings.personalHomeRuntime.verifyBackup" title={t('personalHome.settings.verifyAction')} subtitle={t('personalHome.settings.verifySubtitle')} onPress={() => void runExternalOperation(verify)} disabled={disabled} /> : null}
            {operations?.selectBackupArchive ? <Item testID="settings.personalHomeRuntime.restore" title={t('personalHome.settings.restoreAction')} subtitle={t('personalHome.settings.restoreSubtitle')} onPress={() => void runExternalOperation(restore)} disabled={disabled} /> : null}
            {relocationItems.length > 0 ? <DropdownMenu
                testID="settings.personalHomeRuntime.relocate"
                open={relocationMenuOpen}
                onOpenChange={setRelocationMenuOpen}
                items={relocationItems}
                onSelect={(destinationId) => {
                    setRelocationMenuOpen(false);
                    const destination = operations?.relocation?.destinations.find((candidate) => candidate.id === destinationId);
                    if (destination) void runExternalOperation(() => relocate(destination));
                }}
                itemTrigger={{
                    title: t('personalHome.settings.relocateAction'),
                    subtitle: t('personalHome.settings.relocateSubtitle'),
                    itemProps: { disabled },
                }}
                placement="bottom"
                matchTriggerWidth={true}
            /> : null}
            {finishRelocationRecovery && operations?.relocation?.prepareRecovery ? <Item
                testID="settings.personalHomeRuntime.recoverRelocation"
                title={t('personalHome.settings.relocationFinishAction')}
                subtitle={t('personalHome.settings.relocationFinishSubtitle')}
                onPress={() => void runExternalOperation(() => recoverRelocation(finishRelocationRecovery))}
                disabled={disabled}
            /> : null}
            {returnRelocationRecovery && operations?.relocation?.prepareRecovery ? <Item
                testID="settings.personalHomeRuntime.recoverRelocationReturn"
                title={t('personalHome.settings.relocationReturnAction')}
                subtitle={t('personalHome.settings.relocationReturnSubtitle')}
                onPress={() => void runExternalOperation(() => recoverRelocation(returnRelocationRecovery))}
                disabled={disabled}
            /> : null}
            {backupResult ? <Item testID="settings.personalHomeRuntime.backupResult" title={t('personalHome.settings.backupVerified')} subtitle={[formatTimestamp(backupResult.createdAt), formatBytes(backupResult.bytes), backupResult.cleanupRequired ? t('personalHome.settings.backupCleanupRequired') : backupResult.homeNeedsAttention ? t('personalHome.settings.backupNeedsAttention') : t('personalHome.settings.backupHomeReady')].join(' · ')} showChevron={false} mode="info" /> : null}
            {backupResult ? <PersonalHomeDetailRows
                testID="settings.personalHomeRuntime.backupResultDetails"
                title={`${t('personalHome.settings.backupVerified')} · ${t('common.details')}`}
                rows={[
                    { testID: 'settings.personalHomeRuntime.backupResultPath', title: t('personalHome.settings.restoreBackupTitle'), value: backupResult.path },
                    { title: t('personalHome.settings.restoreBackupDate'), value: formatTimestamp(backupResult.createdAt) },
                    { title: t('personalHome.settings.restoreBackupSize'), value: formatBytes(backupResult.bytes) },
                    { testID: 'settings.personalHomeRuntime.backupResultIdentity', title: t('personalHome.settings.identityTitle'), value: backupResult.homeServerIdentityId },
                    { title: 'SHA-256', value: backupResult.sha256 },
                    ...(backupResult.cleanupRequired ? [
                        { title: t('personalHome.settings.backupCleanupPath'), value: backupResult.cleanupRequired.path },
                        { title: t('personalHome.settings.backupCleanupError'), value: backupResult.cleanupRequired.error },
                    ] : []),
                ]}
            /> : null}
            {backupResult && operations?.revealBackupOutput ? <Item testID="settings.personalHomeRuntime.backupReveal" title={t('personalHome.settings.backupRevealAction')} onPress={() => void runExternalOperation(() => operations.revealBackupOutput!(backupResult.path))} /> : null}
            {control.lastVerification ? <Item testID="settings.personalHomeRuntime.verifyResult" title={t('personalHome.settings.backupVerified')} subtitle={[formatTimestamp(control.lastVerification.createdAt), control.lastVerification.archiveBytes === null ? null : formatBytes(control.lastVerification.archiveBytes)].filter((value): value is string => value !== null).join(' · ')} showChevron={false} mode="info" /> : null}
            {control.lastVerification ? <PersonalHomeDetailRows
                testID="settings.personalHomeRuntime.verifyResultDetails"
                title={`${t('personalHome.settings.verifyAction')} · ${t('common.details')}`}
                rows={[
                    { testID: 'settings.personalHomeRuntime.verifyResultPath', title: t('personalHome.settings.restoreBackupTitle'), value: control.lastVerification.archivePath },
                    { title: t('personalHome.settings.restoreBackupDate'), value: formatTimestamp(control.lastVerification.createdAt) },
                    { title: t('personalHome.settings.restoreBackupSize'), value: formatBytes(control.lastVerification.archiveBytes) },
                    { testID: 'settings.personalHomeRuntime.verifyResultIdentity', title: t('personalHome.settings.identityTitle'), value: control.lastVerification.homeServerIdentityId ?? t('personalHome.settings.identityUnavailable') },
                    { title: t('personalHome.settings.restoreCompatibility'), value: `${control.lastVerification.format} v${control.lastVerification.version}` },
                    { testID: 'settings.personalHomeRuntime.verifyResultIdentityComparison', title: t('personalHome.settings.identityComparison'), value: formatIdentityComparison(control.lastVerification.identityMatchesCurrentHome) },
                ]}
            /> : null}
            {restoreResult ? <Item testID="settings.personalHomeRuntime.restoreResult" title={t('personalHome.settings.restoreResultTitle')} subtitle={resolveRestoreOutcome(restoreResult)} showChevron={false} mode="info" /> : null}
            {restoreResult?.error ? <PersonalHomeDetailRows
                testID="settings.personalHomeRuntime.restoreResultDetails"
                title={`${t('personalHome.settings.restoreResultTitle')} · ${t('common.details')}`}
                rows={[{ title: tLoose('common.error'), value: restoreResult.error }]}
            /> : null}
            {restoreRecoveryBackup ? <Item
                testID="settings.personalHomeRuntime.restoreRecoveryBackup"
                title={t('personalHome.settings.restorePreviousDataTitle')}
                subtitle={`${formatTimestamp(restoreRecoveryBackup.createdAt)} · ${formatBytes(restoreRecoveryBackup.bytes)}`}
                showChevron={false}
                mode="info"
            /> : null}
            {restoreRecoveryBackup ? <PersonalHomeDetailRows
                testID="settings.personalHomeRuntime.restoreRecoveryBackupDetails"
                title={`${t('personalHome.settings.restorePreviousDataTitle')} · ${t('common.details')}`}
                rows={[
                    { testID: 'settings.personalHomeRuntime.restoreRecoveryBackupPath', title: t('personalHome.settings.restoreBackupTitle'), value: restoreRecoveryBackup.path },
                    { title: t('personalHome.settings.restoreBackupDate'), value: formatTimestamp(restoreRecoveryBackup.createdAt) },
                    { title: t('personalHome.settings.restoreBackupSize'), value: formatBytes(restoreRecoveryBackup.bytes) },
                    { title: t('personalHome.settings.identityTitle'), value: restoreRecoveryBackup.homeServerIdentityId },
                    { testID: 'settings.personalHomeRuntime.restoreRecoveryBackupHash', title: 'SHA-256', value: restoreRecoveryBackup.sha256 },
                ]}
            /> : null}
            {restoreRecoveryBackup && operations?.revealBackupOutput ? <Item
                testID="settings.personalHomeRuntime.restoreRecoveryBackupReveal"
                title={t('personalHome.settings.backupRevealAction')}
                onPress={() => void runExternalOperation(() => operations.revealBackupOutput!(restoreRecoveryBackup.path))}
            /> : null}
        </ItemGroup>
        {control.operationSnapshot ? <View>
            {control.operationSnapshot.status === 'failed' ? <Text testID="system-task-a11y-failure" accessibilityLiveRegion="assertive">{t('personalHome.settings.operationFailed')}</Text> : control.operationSnapshot.result ? null : <Text testID="system-task-a11y-progress" accessibilityLiveRegion="polite">{control.operationSnapshot.latestMessage}</Text>}
            <Item
                testID="settings.personalHomeRuntime.operationSummary"
                title={t('personalHome.settings.progressTitle')}
                subtitle={operationPhase ?? t('common.loading')}
                showChevron={false}
                mode="info"
            />
            {canCancel ? <Item
                testID="system-task-progress-cancel"
                title={t('common.cancel')}
                onPress={() => void control.cancelTask(control.operationSnapshot!.taskId)}
            /> : null}
            <Item
                testID="settings.personalHomeRuntime.operationDetails"
                title={t('common.details')}
                onPress={() => setOperationDetailsOpen((current) => !current)}
            />
            {operationDetailsOpen ? <SystemTaskProgressCard
                title={t('personalHome.settings.progressTitle')}
                snapshot={control.operationSnapshot}
            /> : null}
            {control.operationSnapshot.result ? <Item testID="settings.personalHomeRuntime.dismissResult" title={t('personalHome.settings.dismissResult')} onPress={control.dismissOperationResult} /> : null}
        </View> : null}
        <ItemGroup title={t('personalHome.settings.protectionTitle')}>
            <Item testID="settings.personalHomeRuntime.lastBackup" title={t('personalHome.settings.lastBackupTitle')} subtitle={latestBackup ? `${formatTimestamp(latestBackup.createdAt)} · ${formatBytes(latestBackup.archiveBytes)}` : t('personalHome.settings.lastBackupUnknown')} showChevron={false} mode="info" />
            <Item testID="settings.personalHomeRuntime.backupsCount" title={t('personalHome.settings.backupsTitle')} subtitle={`${String(control.inspection?.backupsCount ?? 0)}${backupInventoryComplete ? '' : '+'}`} showChevron={false} mode="info" />
            {control.inspection?.restoreRecovery.status === 'rollback_available' ? <Item testID="settings.personalHomeRuntime.recoverRestore" title={t('personalHome.settings.recoverRestoreAction')} subtitle={t('personalHome.settings.recoverRestoreSubtitle')} onPress={() => void recoverRestore()} disabled={disabled} destructive /> : null}
            {control.inspection?.restoreRecovery.status === 'ambiguous' ? <Item testID="settings.personalHomeRuntime.restoreRecoveryWarning" title={t('personalHome.settings.restoreRecoveryWarningTitle')} subtitle={t('personalHome.settings.restoreRecoveryWarningBody')} showChevron={false} mode="info" /> : null}
            {control.inspection?.restoreRecovery.status === 'finalization_available' ? <Item testID="settings.personalHomeRuntime.restoreRecoveryWarning" title={t('personalHome.settings.restoreCleanupWarningTitle')} subtitle={t('personalHome.settings.restoreCleanupWarningBody')} showChevron={false} mode="info" /> : null}
        </ItemGroup>
        <ItemGroup title={t('personalHome.settings.advancedTitle')} description={t('personalHome.settings.advancedFooter')}>
            {control.status?.version ? <Item title={t('settings.localRelayRuntime.versionTitle')} subtitle={control.status.version} showChevron={false} mode="info" /> : null}
            <Item testID="settings.localRelayRuntime.installOrUpdate" title={t('personalHome.settings.installOrUpdateAction')} onPress={() => void control.installOrUpdate()} disabled={control.isBusy || control.isUnavailable} />
            <Item testID="settings.localRelayRuntime.start" title={t('personalHome.settings.startAction')} onPress={() => void control.startRelay()} disabled={!canStart} />
            <Item testID="settings.localRelayRuntime.stop" title={t('personalHome.settings.stopAction')} onPress={() => void control.stopRelay()} disabled={!canStop} />
            <Item testID="settings.personalHomeRuntime.restart" title={t('personalHome.settings.restartAction')} onPress={() => void control.restartRelay()} disabled={disabled} />
            {operations?.repairSearch ? <Item
                testID="settings.personalHomeRuntime.repairSearch"
                title={t('personalHome.settings.repairSearchAction')}
                subtitle={t('personalHome.settings.repairSearchSubtitle')}
                onPress={() => void runExternalOperation(repairSearch)}
                disabled={disabled || control.status?.service.active !== true || control.status.healthy !== true}
            /> : null}
            {operations?.openDataLocation ? <Item testID="settings.personalHomeRuntime.openDataLocation" title={t('personalHome.settings.openDataLocationAction')} onPress={() => void runExternalOperation(() => operations.openDataLocation!(control.inspection?.layoutPaths.dataDir ?? ''))} disabled={!control.inspection?.layoutPaths.dataDir} /> : null}
            {operations?.openLogs ? <Item testID="settings.personalHomeRuntime.openLogs" title={t('personalHome.settings.openLogsAction')} onPress={() => void runExternalOperation(() => operations.openLogs!(control.inspection?.layoutPaths.logsDir ?? ''))} disabled={!control.inspection?.layoutPaths.logsDir} /> : null}
            {operations?.removeProfile ? <Item testID="settings.personalHomeRuntime.removeProfile" title={t('personalHome.settings.removeProfileAction')} subtitle={t('personalHome.settings.removeProfileSubtitle')} onPress={() => void operations.removeProfile?.()} destructive /> : null}
            {operations?.uninstallRuntime ? <Item testID="settings.personalHomeRuntime.uninstallRuntime" title={t('personalHome.settings.uninstallRuntimeAction')} subtitle={t('personalHome.settings.uninstallRuntimeSubtitle')} onPress={() => void runExternalOperation(operations.uninstallRuntime!)} /> : null}
        </ItemGroup>
        <PoliteAccessibilityStatus
            announcement={operationAnnouncement.text}
            statusTestID="settings.personalHomeRuntime.eraseAccessibilityStatus"
            transitionKey={operationAnnouncement.transitionKey}
        />
        <ItemGroup title={t('personalHome.settings.deleteHomeDataTitle')} description={t('personalHome.settings.removeSectionFooter')}>
            {eraseBackupRecovery ? <>
                <Item
                    testID="settings.personalHomeRuntime.eraseBackupRecovery"
                    title={t('personalHome.settings.eraseNotPerformed')}
                    subtitle={resolveEraseBlockedReason(eraseBackupRecovery.reason)}
                    subtitleLines={0}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    testID="settings.personalHomeRuntime.eraseBackupRecoveryPath"
                    title={t('personalHome.settings.restoreBackupTitle')}
                    subtitle={eraseBackupRecovery.path}
                    subtitleLines={0}
                    showChevron={false}
                    mode="info"
                />
                {operations?.revealBackupOutput ? <Item
                    testID="settings.personalHomeRuntime.eraseBackupRecoveryReveal"
                    title={t('personalHome.settings.backupRevealAction')}
                    onPress={() => void runExternalOperation(() => operations.revealBackupOutput!(eraseBackupRecovery.path))}
                /> : null}
                <Item
                    testID="settings.personalHomeRuntime.eraseBackupRecoveryRefresh"
                    title={t('personalHome.settings.inspectAction')}
                    onPress={() => void control.refreshInspection()}
                    disabled={control.isBusy || control.isUnavailable}
                />
            </> : null}
            <Item testID="settings.personalHomeRuntime.eraseData" title={t('personalHome.settings.eraseDataAction')} subtitle={t('personalHome.settings.eraseDataSubtitle')} onPress={() => void runExternalOperation(erase)} disabled={disabled} destructive />
            {eraseResult ? <Item
                testID="settings.personalHomeRuntime.eraseResult"
                title={resolveEraseResultTitle(eraseResult)}
                subtitle={resolveEraseResultSentences(eraseResult).join('\n')}
                showChevron={false}
                mode="info"
            /> : null}
            {eraseResult && eraseResultDetailRows.length > 0 ? <PersonalHomeDetailRows
                testID="settings.personalHomeRuntime.eraseResultDetails"
                title={`${resolveEraseResultTitle(eraseResult)} · ${t('common.details')}`}
                rows={eraseResultDetailRows}
            /> : null}
        </ItemGroup>
    </>;
});

export const PersonalHomeRuntimeControlSection = React.memo(function PersonalHomeRuntimeControlSection(
    props: PersonalHomeRuntimeControlSectionProps,
) {
    if (props.controller) {
        return <PersonalHomeRuntimeControlSectionContent {...props} controller={props.controller} />;
    }
    return <OwnedPersonalHomeRuntimeControlSection {...props} />;
});
