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
    statusLabel: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    facts: {
        gap: 2,
        alignItems: 'flex-start',
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
    stale: 'localServices.rowStatus.stale',
    stopped: 'localServices.rowStatus.stopped',
    unavailable: 'localServices.rowStatus.unavailable',
};

/**
 * The row's address, as a URL.
 *
 * An IPv6 literal must be bracketed or the result is not a URL at all — `http://::1:5173` has no
 * meaningful port. The projected address label is preferred for display; this URL-shaped value
 * remains the copy action's source and the fallback when no display label is available.
 */
function formatRowAddress(row: ServiceRow): string | null {
    if (!row.host) return null;
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
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const statusLabel = t(STATUS_LABEL_KEYS[props.row.status]);
    const ready = props.row.scope === 'suggestion' && props.row.status === 'stopped';
    return (
        <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>{props.row.title}</Text>
            {/* Unnamed: the status is the word beside it, so it is announced once. */}
            {!ready ? <ServiceStatusDot
                status={props.row.status}
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
 * The row's supporting facts — where it answers, what owns it, what runs it — plus
 * the launcher's reason when the row cannot be acted on. The address is text here; copying it is
 * the expansion's job, so a collapsed row carries no controls of its own.
 */
function ServiceRowFacts(props: Readonly<{
    row: ServiceRow;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const reason = row.reasonCode
        ? resolveReasonCopy({ reasonCode: row.reasonCode, kind: 'localServiceLauncher' })
        : null;
    const address = row.addressLabel ?? formatRowAddress(row)?.replace(/^https?:\/\//, '').replace(/^127\.0\.0\.1(?=:)/, 'localhost') ?? row.portLabel;
    const script = row.primaryAction?.kind === 'run_script';
    const facts = (script
        ? [row.processLabel, t('localServices.actions.runScriptA11y')]
        : [address, row.serviceLabel ?? row.processLabel, row.scope === 'thisSession' ? t('localServices.session.thisSessionTitle') : t(row.sourceLabel)]
    ).filter((part): part is string => Boolean(part)).join(' · ');
    return (
        <View style={styles.facts}>
            <Text testID={`${props.testID}-meta`} style={styles.factsLine}>
                {facts}
            </Text>
            {reason ? (
                <Text
                    testID={`${props.testID}-reason`}
                    accessibilityHint={reason.diagnosticCode ?? undefined}
                    style={styles.reasonText}
                    numberOfLines={2}
                >
                    {reason.body}
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
                : await setClipboardStringSafe(addressValue);
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
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
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
    const canStart = (primary?.kind === 'start' || primary?.kind === 'run_script') && Boolean(props.onStartLauncherTarget);
    const startLabel = primary?.kind === 'run_script' ? t('localServices.actions.runScriptA11y') : t('localServices.actions.startA11y');
    const canTerminate = row.target.source === 'inventory_entry'
        && row.target.actions.includes('terminate_detected')
        && Boolean(props.onTerminateDetectedService);
    // `forget` hides a detected row; it needs no daemon capability bit because the registry
    // suppression is always available for an inventory entry.
    const canForget = row.target.source === 'inventory_entry'
        && Boolean(props.onForgetDetectedService);
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
        if (primary?.kind !== 'start' && primary?.kind !== 'run_script') return undefined;
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
    }, [canForget, canTerminate, handleForget, handleTerminate, row.terminateIdentityConfidence]);

    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const pending = runner.pendingId === menuPendingId;
    // A row that can only be started (a package script) or not acted on at all has nothing to
    // grow into: it stays a plain row, with ▶ as its one control.
    const hasPublicLink = Boolean(props.publicPreviewState && props.publicPreviewActions)
        && hasLocalServicePublicPreviewSurface(row.target);
    const expandable = canOpen || Boolean(addressValue) || overflowActions.length > 0 || hasPublicLink;
    const expanded = expandable && props.expanded === true;
    const onExpandedChange = props.onExpandedChange;

    const title = <ServiceRowTitle row={row} animationEnabled={props.animationEnabled} testID={props.testID} />;
    const subtitle = <ServiceRowFacts row={row} testID={props.testID} />;
    const identity = row.target.source === 'package_script'
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
                    rightElement={openControl ?? startControl}
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
                            {overflowActions.length > 0 ? (
                                <ItemRowActions
                                    title={row.title}
                                    actions={overflowActions}
                                    // Always compact: every action here is secondary or destructive.
                                    compactThreshold={Number.POSITIVE_INFINITY}
                                    compactActionIds={[]}
                                    overflowTriggerTestID={`${props.testID}-overflow`}
                                    gap={ROW_ACTION_GAP_PX}
                                />
                            ) : null}
                        </View>
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
