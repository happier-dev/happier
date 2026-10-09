import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceCard, SURFACE_CARD_PADDING_PX } from '@/components/ui/cards/SurfaceCard';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ServicesOpenInBrowserResult } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import type { ServiceRow, ServiceRowStatus } from '@/sync/domains/local/services/serviceRow';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import type { TranslationKey } from '@/text/i18n';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { useLocalServiceActionRunner } from './localServiceActionOutcome';
import {
    hasLocalServicePublicPreviewSurface,
    LocalServicePublicPreviewControls,
} from './LocalServicePublicPreviewControls';
import type { LocalServicePublicPreviewActions } from './publicPreviewActions';
import { ServiceStatusDot } from './ServiceStatusDot';
import type { LocalServiceCapabilityDisabledReasons } from './useLocalServicePublicPreviewFeature';

export type ServiceRowOpenHandler = (target: LocalServiceLaunchTarget) => ServicesOpenInBrowserResult | void | Promise<unknown>;
export type ServiceRowStartHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowTerminateHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowForgetHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
/** Stop or Restart a managed lifetime through its exact occurrence; the result, not the press, settles the row. */
export type ServiceRowManagedControlHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowCopyUrlHandler = (
    target: LocalServiceLaunchTarget,
    value: string,
) => Promise<boolean>;

/** The gap between the expansion's controls, shared with their press frames. */
const ROW_ACTION_GAP_PX = 8;

const stylesheet = StyleSheet.create((theme) => ({
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    title: {
        flexShrink: 1,
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
    /** A declaration that cannot start here: it keeps its row and says why, at a lower voice. */
    titleInert: {
        color: theme.colors.text.tertiary,
        fontWeight: '400',
    },
    statusLabel: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    facts: {
        gap: 2,
        alignItems: 'flex-start',
    },
    /** Lead facts, the source badge, then the trailing facts on one line (lab s-services). */
    factsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
    },
    /** The lead (an address, a command) stays readable; the trailing facts are what truncates. */
    factsLead: {
        maxWidth: '70%',
    },
    factsTail: {
        flexShrink: 1,
    },
    badgeLabel: {
        ...Typography.mono(),
    },
    factsLine: {
        ...Typography.tabular(),
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    identity: {
        ...Typography.default('bold'),
        fontSize: 16,
        color: theme.colors.text.secondary,
    },
    reasonText: {
        color: theme.colors.text.secondary,
    },
    /**
     * The expansion: the row's own controls and, when it has one, its live public link, in the app's
     * bordered card (the Home tiles' `SurfaceCard`) spanning the row's full width — not a grey band
     * indented under the title.
     */
    expansion: {
        paddingHorizontal: 12,
        paddingBottom: 12,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: ROW_ACTION_GAP_PX,
        paddingHorizontal: SURFACE_CARD_PADDING_PX.sm.horizontal,
        paddingVertical: SURFACE_CARD_PADDING_PX.sm.vertical,
    },
    actionsSpacer: {
        flex: 1,
    },
}));

const STATUS_LABEL_KEYS: Readonly<Record<ServiceRowStatus, TranslationKey>> = {
    running: 'localServices.rowStatus.running',
    starting: 'localServices.rowStatus.starting',
    stopping: 'localServices.rowStatus.stopping',
    stale: 'localServices.rowStatus.stale',
    stopped: 'localServices.rowStatus.stopped',
    failed: 'localServices.rowStatus.failed',
    unavailable: 'localServices.rowStatus.unavailable',
};

/** A declaration nobody has started yet: it is Ready to start, so it carries no status word. */
function isNotStarted(row: ServiceRow): boolean {
    return row.status === 'stopped'
        && row.primaryAction?.kind === 'start'
        && row.target.serviceState === undefined;
}

/** Nothing to do with it here: no Start, no Open, not live. Its title steps back. */
function isInert(row: ServiceRow): boolean {
    return row.primaryAction === null
        && (row.status === 'stopped' || row.status === 'unavailable' || row.status === 'failed');
}

/**
 * The row's address, as a URL.
 *
 * An IPv6 literal must be bracketed or the result is not a URL at all — `http://::1:5173` has no
 * meaningful port. The projected address label is preferred for display; this URL-shaped value
 * remains the copy action's source and the fallback when no display label is available.
 */
function formatRowAddress(row: ServiceRow): string | null {
    // A managed lifetime's observed endpoint is its address when no listener row is joined.
    if (!row.host) return row.target.endpointUrl ?? null;
    // A service bound to every interface answers on localhost: show and copy that, never the bind
    // address (`0.0.0.0`, `::`), which is not somewhere a person can go.
    const wildcard = row.host === '0.0.0.0' || row.host === '::' || row.host === '[::]' || row.host === '*';
    const bound = wildcard ? 'localhost' : row.host;
    const host = bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound;
    const scheme = row.scheme && row.scheme !== 'unknown' ? `${row.scheme}://` : '';
    return `${scheme}${host}${row.portLabel ?? ''}`;
}

/** The name, then the status in words beside its dot ("web ● Running"), as the lab draws it. */
function ServiceRowTitle(props: Readonly<{
    row: ServiceRow;
    /** The machine stopped answering: the row shows what was last known, not a live status. */
    offline?: boolean;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const statusLabel = props.offline ? t('localServices.rowStatus.lastKnown') : t(STATUS_LABEL_KEYS[props.row.status]);
    const ready = (props.row.scope === 'suggestion' && props.row.status === 'stopped') || isNotStarted(props.row);
    return (
        <View style={styles.titleRow}>
            <Text style={[styles.title, isInert(props.row) ? styles.titleInert : null]} numberOfLines={1}>{props.row.title}</Text>
            {/* Unnamed: the status is the word beside it, so it is announced once. */}
            {!ready ? <ServiceStatusDot
                status={props.offline ? 'stale' : props.row.status}
                animationEnabled={props.animationEnabled}
                testID={`${props.testID}-dot`}
            /> : null}
            {!ready ? <Text testID={`${props.testID}-status-${props.row.status}`} style={styles.statusLabel} numberOfLines={1}>
                {statusLabel}
            </Text> : null}
        </View>
    );
}

/**
 * The row's supporting facts: where it answers (or that it has no address), the file it is declared
 * in, what runs it and on which machine — plus the launcher's reason when the row cannot be acted on.
 * The address is text here; copying it is the expansion's job, so a collapsed row carries no
 * controls of its own. Lab `s-services`: `localhost:3005 · [project.json] on devbox`.
 */
function resolveRowFacts(row: ServiceRow, machineName: string | null): Readonly<{
    lead: readonly string[];
    tail: readonly string[];
    /** The tail is the reason the row cannot act (lab `db`: "Docker isn't available on devbox"). */
    tailReason: ReturnType<typeof resolveReasonCopy> | null;
    reason: ReturnType<typeof resolveReasonCopy> | null;
}> {
    const reason = row.reasonCode
        ? resolveReasonCopy({ reasonCode: row.reasonCode, kind: 'localServiceLauncher' })
        : null;
    const on = machineName ? t('localServices.row.onMachine', { machine: machineName }) : null;
    // Offline: the host says so once, with Check again; the row keeps its last-known facts under
    // a "Last known" status instead of repeating the outage on every row.
    if (row.status === 'starting') {
        return { lead: [machineName ? t('localServices.row.startingOn', { machine: machineName }) : t('localServices.rowStatus.starting')], tail: [], tailReason: null, reason };
    }
    if (row.addressNote === 'waiting') {
        return { lead: [t('localServices.row.waitingAddress')], tail: [], tailReason: null, reason };
    }
    if (isNotStarted(row) || isInert(row)) {
        const lead = [row.processLabel].filter((part): part is string => Boolean(part));
        if (row.status === 'failed') return { lead, tail: [t('localServices.row.failed')], tailReason: null, reason };
        if (reason) return { lead, tail: [reason.body], tailReason: reason, reason: null };
        return { lead, tail: isNotStarted(row) ? [t('localServices.row.notStarted')] : [], tailReason: null, reason: null };
    }
    const address = row.addressLabel
        ?? formatRowAddress(row)?.replace(/^https?:\/\//, '').replace(/^127\.0\.0\.1(?=:)/, 'localhost')
        ?? row.portLabel
        ?? (row.addressNote === 'none' ? t('localServices.row.noAddress') : null);
    // Where it runs names the machine on a machine-scoped host; elsewhere the source says what it is.
    const where = row.scope === 'thisSession'
        ? t('localServices.session.thisSessionTitle')
        : on ?? (row.sourceBadge ? null : t(row.sourceLabel));
    return {
        lead: [address].filter((part): part is string => Boolean(part)),
        tail: [row.serviceLabel ?? row.processLabel, where].filter((part): part is string => Boolean(part)),
        tailReason: null,
        reason,
    };
}

function ServiceRowFacts(props: Readonly<{
    row: ServiceRow;
    machineName: string | null;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const facts = resolveRowFacts(row, props.machineName);
    const badge = row.sourceBadge ?? null;
    const lead = facts.lead.join(' · ');
    const tail = facts.tail.join(' · ');
    // One line of facts: lead · [source badge] tail. Without a badge the separator joins lead and tail.
    const leadText = lead && (badge || tail) ? `${lead} ·` : lead;
    return (
        <View style={styles.facts}>
            <View testID={`${props.testID}-meta`} style={styles.factsRow}>
                {leadText ? <Text style={[styles.factsLine, tail || badge ? styles.factsLead : null]} numberOfLines={1}>{leadText}</Text> : null}
                {badge ? (
                    <StatusPill
                        testID={`${props.testID}-source`}
                        variant="neutral"
                        label={badge}
                        hideDot
                        labelStyle={styles.badgeLabel}
                    />
                ) : null}
                {tail ? (
                    <Text
                        testID={facts.tailReason ? `${props.testID}-reason` : undefined}
                        accessibilityHint={facts.tailReason?.diagnosticCode ?? undefined}
                        style={[styles.factsLine, styles.factsTail]}
                        numberOfLines={2}
                    >
                        {tail}
                    </Text>
                ) : null}
            </View>
            {facts.reason ? (
                <Text
                    testID={`${props.testID}-reason`}
                    accessibilityHint={facts.reason.diagnosticCode ?? undefined}
                    style={styles.reasonText}
                    numberOfLines={2}
                >
                    {facts.reason.body}
                </Text>
            ) : null}
        </View>
    );
}

/**
 * Copy address, as the expansion's secondary action. One owner for "copy a local service URL": the
 * handler dispatches the audited `localServices.actions.copyUrl` where the row has a target the
 * action can address (G14), and a refused copy says so instead of failing silently.
 */
function CopyAddressButton(props: Readonly<{
    addressValue: string;
    target: LocalServiceLaunchTarget;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    testID: string;
}>): React.ReactElement {
    const copyFeedback = useTemporaryCopyFeedback();
    const { addressValue, onCopyServiceUrl, target } = props;
    const copyAddress = React.useCallback(() => {
        void (async () => {
            const copied = onCopyServiceUrl
                ? await onCopyServiceUrl(target, addressValue)
                : target.source === 'managed_service' ? false : await setClipboardStringSafe(addressValue);
            if (copied) {
                copyFeedback.markCopied('address');
                return;
            }
            Modal.alert(
                t('localServices.actions.failureTitle.copyAddress'),
                resolveReasonCopy({ reasonCode: null, kind: 'localServiceAction' }).body,
            );
        })();
    }, [addressValue, copyFeedback, onCopyServiceUrl, target]);
    return (
        <>
            <RoundButton
                testID={`${props.testID}-copy-address`}
                size="small"
                display="secondary"
                title={t('localServices.pane.copyAddress')}
                accessibilityLabel={t('localServices.actions.copyAddressA11y')}
                onPress={copyAddress}
            />
            <CopiedPill
                visible={copyFeedback.isCopied('address')}
                testID={`${props.testID}-copy-address-feedback`}
            />
        </>
    );
}

export function ServiceRowView(props: Readonly<{
    row: ServiceRow;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    onStartLauncherTarget?: ServiceRowStartHandler;
    onTerminateDetectedService?: ServiceRowTerminateHandler;
    onForgetDetectedService?: ServiceRowForgetHandler;
    onStopManagedService?: ServiceRowManagedControlHandler;
    onRestartManagedService?: ServiceRowManagedControlHandler;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    /** The machine the host is scoped to: rows say where they run ("on devbox"). */
    machineName?: string | null;
    /** The machine is unreachable: every fact on the row is last known. */
    offline?: boolean;
    /**
     * Where the service runs next (plan 32 "Runs on" / "If it can't run there"), drawn by its
     * placement owner inside the expansion under the row's controls. The row only hosts it.
     */
    placement?: React.ReactNode;
    /** The row's live public link, shown only while it is expanded. */
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewActions?: LocalServicePublicPreviewActions;
    publicPreviewCapabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
    /** One expanded row at a time is the pane's decision; the row only asks. */
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    showDivider?: boolean;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const runner = useLocalServiceActionRunner();
    const primary = row.primaryAction;
    const canOpen = primary?.kind === 'open' && Boolean(props.onOpenServiceInBrowser);
    const canStart = primary?.kind === 'start' && Boolean(props.onStartLauncherTarget);
    const startLabel = t('localServices.actions.startA11y');
    const canTerminate = row.target.source === 'inventory_entry'
        && row.target.actions.includes('terminate_detected')
        && Boolean(props.onTerminateDetectedService);
    // `forget` hides a detected row or a managed occurrence's history; it needs no daemon capability
    // bit because the suppression is always available, and it never stops anything.
    const canForget = (row.target.source === 'inventory_entry' || row.target.source === 'managed_service')
        && Boolean(props.onForgetDetectedService);
    // Stop and Restart exist only where the supervisor actually controls the lifetime (`manage`), and
    // only while it is live: a settled or never-started declaration has nothing to stop.
    const managedLive = row.target.source === 'managed_service'
        && row.target.actions.includes('manage')
        && (row.status === 'running' || row.status === 'starting' || row.status === 'stopping');
    const canStop = managedLive && Boolean(props.onStopManagedService);
    const canRestart = managedLive && row.status === 'running' && Boolean(props.onRestartManagedService);
    const addressValue = formatRowAddress(row);

    /**
     * Two pending ids for one row, because feedback belongs where the user acted.
     *
     * An inline action has a control the user is looking at, and the button already owns that
     * control's pending state. An overflow action has no visible control by the time it runs: the
     * popover has closed, so the ROW is the only place left to say "working". Sharing one id would
     * put both spinners on screen for the same dispatch.
     */
    const inlinePendingId = `${row.id}:inline`;
    const menuPendingId = `${row.id}:menu`;

    const handleOpen = React.useCallback(async () => {
        if (primary?.kind !== 'open') return undefined;
        return await runner.run({
            id: inlinePendingId,
            failureTitle: t('localServices.actions.failureTitle.open', { service: row.title }),
            action: async () => props.onOpenServiceInBrowser?.(primary.openTarget),
        });
    }, [inlinePendingId, primary, props, row.title, runner]);

    const handleStart = React.useCallback(() => {
        if (primary?.kind !== 'start') return undefined;
        return runner.run({
            id: inlinePendingId,
            failureTitle: t('localServices.actions.failureTitle.start', { service: row.title }),
            action: async () => props.onStartLauncherTarget?.(primary.target),
        });
    }, [inlinePendingId, primary, props, row.title, runner]);

    const handleTerminate = React.useCallback(() => {
        void (async () => {
            if (!props.onTerminateDetectedService) return;
            const confirmed = await Modal.confirm(
                t('localServices.actions.terminateConfirmTitle'),
                t('localServices.actions.terminateConfirmMessage', { service: row.title }),
                { confirmText: t('localServices.actions.terminateConfirmCta'), destructive: true },
            );
            if (!confirmed) return;
            await runner.run({
                id: menuPendingId,
                failureTitle: t('localServices.actions.failureTitle.terminate', { service: row.title }),
                action: async () => props.onTerminateDetectedService?.(row.target),
            });
        })();
    }, [menuPendingId, props, row.target, row.title, runner]);

    const handleStop = React.useCallback(() => {
        void (async () => {
            if (!props.onStopManagedService) return;
            const confirmed = await Modal.confirm(
                t('localServices.actions.stopConfirmTitle'),
                t('localServices.actions.stopConfirmMessage', { service: row.title }),
                { confirmText: t('localServices.actions.stopConfirmCta'), destructive: true },
            );
            if (!confirmed) return;
            await runner.run({
                id: menuPendingId,
                failureTitle: t('localServices.actions.failureTitle.stop', { service: row.title }),
                action: async () => props.onStopManagedService?.(row.target),
            });
        })();
    }, [menuPendingId, props, row.target, row.title, runner]);

    const handleRestart = React.useCallback(() => {
        void runner.run({
            id: menuPendingId,
            failureTitle: t('localServices.actions.failureTitle.restart', { service: row.title }),
            action: async () => props.onRestartManagedService?.(row.target),
        });
    }, [menuPendingId, props, row.target, row.title, runner]);

    const handleForget = React.useCallback(() => {
        void (async () => {
            if (!props.onForgetDetectedService) return;
            await runner.run({
                id: menuPendingId,
                failureTitle: t('localServices.actions.failureTitle.forget', { service: row.title }),
                action: async () => props.onForgetDetectedService?.(row.target),
            });
        })();
    }, [menuPendingId, props, row.target, row.title, runner]);

    /**
     * Destructive and secondary actions live in the expansion's overflow (U-11): naming the
     * consequence in a menu is safer and calmer than two red glyphs side by side, and
     * `ItemRowActions` already carries the destructive tone, the press frame and the popover.
     */
    const overflowActions = React.useMemo((): ItemAction[] => {
        const actions: ItemAction[] = [];
        if (canRestart) {
            actions.push({
                id: 'restart',
                title: t('localServices.actions.restartTitle'),
                icon: 'arrow-clockwise',
                onPress: handleRestart,
            });
        }
        if (canStop) {
            actions.push({
                id: 'stop',
                title: t('localServices.actions.stopConfirmCta'),
                icon: 'stop',
                destructive: true,
                onPress: handleStop,
            });
        }
        if (canTerminate) {
            actions.push({
                id: 'terminate',
                title: t('localServices.actions.terminateConfirmCta'),
                // The identity confidence belongs to the decision, not to a permanent grey line.
                ...(row.terminateIdentityConfidence === 'pid_only'
                    ? { subtitle: t('localServices.actions.terminatePidOnlyConfidence') }
                    : {}),
                icon: 'x-circle',
                destructive: true,
                onPress: handleTerminate,
            });
        }
        if (canForget) {
            actions.push({
                id: 'forget',
                title: t('localServices.actions.forgetA11y'),
                icon: 'eye-slash',
                onPress: handleForget,
            });
        }
        return actions;
    }, [canForget, canRestart, canStop, canTerminate, handleForget, handleRestart, handleStop, handleTerminate, row.terminateIdentityConfidence]);

    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const pending = runner.pendingId === menuPendingId;
    // A row that can only be started (a package script) or not acted on at all has nothing to
    // grow into: it stays a plain row, with ▶ as its one control.
    const hasPublicLink = Boolean(props.publicPreviewState && props.publicPreviewActions)
        && hasLocalServicePublicPreviewSurface(row.target);
    // A row grows only into what it has to show (its address, its link). A live service with no
    // address — a queue worker — keeps its overflow on the row itself (lab s-services `jobs`).
    const expandable = canOpen || Boolean(addressValue) || hasPublicLink;
    const expanded = expandable && props.expanded === true;
    const onExpandedChange = props.onExpandedChange;

    const offline = props.offline === true;
    const machineName = props.machineName ?? null;
    const title = <ServiceRowTitle row={row} offline={offline} animationEnabled={props.animationEnabled} testID={props.testID} />;
    const subtitle = <ServiceRowFacts row={row} machineName={machineName} testID={props.testID} />;
    // A Project declaration is a service of this checkout (the Services page's own mark, lab
    // s-services); an undeclared script is a terminal command; a detected listener keeps its letter.
    const identity = row.target.declaration
        ? <Icon testID={`${props.testID}-identity`} name="hard-drives" size={18} />
        : row.target.source === 'package_script'
        ? <Icon name="terminal" size={18} />
        : <Text testID={`${props.testID}-identity`} style={styles.identity}>{(row.serviceLabel ?? row.title).slice(0, 1).toLocaleUpperCase()}</Text>;
    // One tap: a running row's signature action sits on the row itself, like ▶ on a row that can be
    // started (services lab O, H-UX F-8). Pressing the row still grows it into what you do less often.
    const openControl = canOpen ? (
        <IconButton
            testID={`${props.testID}-open`}
            iconName="arrow-square-out"
            variant="plain"
            accessibilityLabel={t('localServices.actions.openA11y', { service: row.title })}
            tooltip={t('common.open')}
            minimumInteractiveTargetSize={minimumTargetSize}
            animationEnabled={props.animationEnabled}
            onPress={handleOpen}
        />
    ) : null;
    const startControl = canStart ? (
        <IconButton
            testID={`${props.testID}-start`}
            iconName="play"
            variant="plain"
            accessibilityLabel={startLabel}
            tooltip={startLabel}
            minimumInteractiveTargetSize={minimumTargetSize}
            animationEnabled={props.animationEnabled}
            onPress={handleStart}
        />
    ) : null;

    const overflowControl = overflowActions.length > 0 ? (
        <ItemRowActions
            title={row.title}
            actions={overflowActions}
            // Always compact: every action here is secondary or destructive.
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
            overflowTriggerTestID={`${props.testID}-overflow`}
            gap={ROW_ACTION_GAP_PX}
        />
    ) : null;

    if (!expandable || !onExpandedChange) {
        return (
            <View testID={props.testID}>
                <Item
                    testID={`${props.testID}-item`}
                    title={title}
                    icon={identity}
                    subtitle={subtitle}
                    subtitleLines={2}
                    mode="info"
                    showChevron={false}
                    showDivider={props.showDivider}
                    loading={pending}
                    rightElement={openControl ?? startControl ?? overflowControl}
                />
            </View>
        );
    }

    return (
        <View testID={props.testID}>
            <ExpandableItem
                expanded={expanded}
                onExpandedChange={onExpandedChange}
                showDivider={props.showDivider}
                header={({ headerProps }) => (
                    <Item
                        {...headerProps}
                        testID={`${props.testID}-item`}
                        title={title}
                        icon={identity}
                        subtitle={subtitle}
                        subtitleLines={2}
                        loading={pending}
                        rightElement={openControl ?? startControl}
                        // Open and ▶ are their own buttons: never nest them inside the row's press target.
                        rightElementOutsidePressable={openControl !== null || startControl !== null}
                    />
                )}
            >
                {/* The disclosure mounts this only while open (and through its collapse). */}
                <View testID={`${props.testID}-expansion`} style={styles.expansion}>
                    <SurfaceCard padding="none">
                        <View style={styles.actions}>
                            {addressValue ? (
                                <CopyAddressButton
                                    addressValue={addressValue}
                                    target={row.target}
                                    onCopyServiceUrl={props.onCopyServiceUrl}
                                    testID={props.testID}
                                />
                            ) : null}
                            <View style={styles.actionsSpacer} />
                            {overflowControl}
                        </View>
                        {props.placement}
                        <LocalServicePublicPreviewControls
                            launchTargets={[row.target]}
                            state={props.publicPreviewState}
                            actions={props.publicPreviewActions}
                            capabilityDisabledReasons={props.publicPreviewCapabilityDisabledReasons}
                            testID={`${props.testID}-public-preview`}
                        />
                    </SurfaceCard>
                </View>
            </ExpandableItem>
        </View>
    );
}
