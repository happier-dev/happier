import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ServiceRow, ServiceRowStatus } from '@/sync/domains/local/services/serviceRow';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import type { TranslationKey } from '@/text/i18n';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { useLocalServiceActionRunner } from './localServiceActionOutcome';
import { ServiceStatusDot } from './ServiceStatusDot';

export type ServiceRowOpenHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowStartHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowTerminateHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowForgetHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowCopyUrlHandler = (
    target: LocalServiceLaunchTarget,
    value: string,
) => Promise<boolean>;

/** The gap the row leaves between its two right-hand controls, shared with their press frames. */
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
    port: {
        ...Typography.mono(),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    facts: {
        gap: 3,
        alignItems: 'flex-start',
    },
    /**
     * The address is a control, so it gets a control's box: a small negative inset keeps the text
     * optically aligned with the eyebrow beneath it while the pressed surface still reads as a
     * discrete target. Radius 6 against the row's 8 keeps the two concentric.
     */
    addressPressable: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginHorizontal: -6,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 6,
        maxWidth: '100%',
    },
    addressPressableActive: {
        backgroundColor: theme.colors.surface.pressed,
    },
    /**
     * The keyboard focus ring, from the theme's dedicated focus role.
     *
     * `border.focus` — never `border.strong`, which is an emphasis outline measuring 1.26–1.45:1
     * against the surfaces here and would be a focus ring nobody can see. Same treatment the
     * canonical controls in this row use, so a Tab sweep looks like one thing.
     */
    addressPressableFocused: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.focus,
                outlineOffset: -2,
            },
            default: {},
        }) as object),
    },
    address: {
        ...Typography.mono(),
        ...Typography.tabular(),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    eyebrow: {
        color: theme.colors.text.secondary,
    },
    reasonText: {
        color: theme.colors.text.secondary,
    },
    right: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: ROW_ACTION_GAP_PX,
    },
}));

const STATUS_LABEL_KEYS: Readonly<Record<ServiceRowStatus, TranslationKey>> = {
    running: 'localServices.rowStatus.running',
    starting: 'localServices.rowStatus.starting',
    stale: 'localServices.rowStatus.stale',
    stopped: 'localServices.rowStatus.stopped',
    unavailable: 'localServices.rowStatus.unavailable',
};

const STATUS_VARIANTS: Readonly<Record<ServiceRowStatus, StatusPillVariant>> = {
    running: 'success',
    starting: 'info',
    stale: 'warning',
    stopped: 'neutral',
    unavailable: 'neutral',
};

/**
 * The row's address, as a URL.
 *
 * An IPv6 literal must be bracketed or the result is not a URL at all — `http://::1:5173` has no
 * meaningful port. The daemon's own `presentation.addressLabel` is the better source, but
 * `ServiceRow` does not carry that field yet (recorded for the row-model owner); until it does,
 * this at least stops emitting a malformed address for every IPv6-bound service.
 */
function formatRowAddress(row: ServiceRow): string | null {
    if (!row.host) return null;
    const host = row.host.includes(':') && !row.host.startsWith('[') ? `[${row.host}]` : row.host;
    const scheme = row.scheme && row.scheme !== 'unknown' ? `${row.scheme}://` : '';
    return `${scheme}${host}${row.portLabel ?? ''}`;
}

function ServiceRowTitle(props: Readonly<{
    row: ServiceRow;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View style={styles.titleRow}>
            <ServiceStatusDot
                status={props.row.status}
                animationEnabled={props.animationEnabled}
                testID={`${props.testID}-dot`}
                accessibilityLabel={t(STATUS_LABEL_KEYS[props.row.status])}
            />
            <Text style={styles.title} numberOfLines={1}>{props.row.title}</Text>
            {props.row.portLabel ? (
                <Text testID={`${props.testID}-port`} style={styles.port} numberOfLines={1}>{props.row.portLabel}</Text>
            ) : null}
        </View>
    );
}

/**
 * The address line.
 *
 * It used to be a sentence *about* the address — `Address: http://localhost:5173` in body text —
 * with a separate copy `IconButton` beside it. Two elements for one idea, and the thing the user
 * actually wants to grab was the part that was not tappable. Now the address IS the control: one
 * press target, monospaced so a port is scannable, with the glyph inside it as the affordance
 * rather than as a second button. That removes a control from the row instead of adding one.
 */
function ServiceRowAddress(props: Readonly<{
    addressValue: string;
    target: LocalServiceLaunchTarget;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const addressGlyphColor = theme.colors.text.secondary;
    const copyFeedback = useTemporaryCopyFeedback();
    const { addressValue, onCopyServiceUrl, target } = props;
    const copyAddress = React.useCallback(() => {
        void (async () => {
            // G14: one owner for "copy a local service URL". The handler dispatches the audited
            // `localServices.actions.copyUrl` where the row has a target the action can address, so
            // this never bypasses the policy that exists for exactly this.
            const copied = onCopyServiceUrl
                ? await onCopyServiceUrl(target, addressValue)
                : await setClipboardStringSafe(addressValue);
            if (copied) {
                copyFeedback.markCopied('address');
                return;
            }
            // A refused or failed copy is silent otherwise: the pill simply never appears and the
            // user cannot tell the difference between "slow" and "denied".
            Modal.alert(
                t('localServices.actions.failureTitle.copyAddress'),
                resolveReasonCopy({ reasonCode: null, kind: 'localServiceAction' }).body,
            );
        })();
    }, [addressValue, copyFeedback, onCopyServiceUrl, target]);
    return (
        <View style={styles.titleRow}>
            <Pressable
                testID={`${props.testID}-copy-address`}
                accessibilityRole="button"
                accessibilityLabel={t('localServices.actions.copyAddressA11y')}
                onPress={copyAddress}
                style={(interactionState) => {
                    // `hovered` and `focused` are react-native-web only, and RNW hands them to the
                    // Pressable's own style callback; the cast keeps both affordances on desktop
                    // without pretending native has them.
                    const webState = interactionState as typeof interactionState & {
                        hovered?: boolean;
                        focused?: boolean;
                    };
                    return [
                        styles.addressPressable,
                        interactionState.pressed || webState.hovered === true
                            ? styles.addressPressableActive
                            : null,
                        webState.focused === true ? styles.addressPressableFocused : null,
                    ];
                }}
            >
                <Text style={styles.address} numberOfLines={1} ellipsizeMode="middle">
                    {addressValue}
                </Text>
                <Icon name="copy" size={13} color={addressGlyphColor} />
            </Pressable>
            <CopiedPill
                visible={copyFeedback.isCopied('address')}
                testID={`${props.testID}-copy-address-feedback`}
            />
        </View>
    );
}

/**
 * The row's supporting facts, at two lines instead of six.
 *
 * The previous row emitted one full-width grey line per fact — address, workspace, process, source,
 * terminate confidence, launcher reason — inside `subtitleLines={0}`, so a row's height was decided
 * by how much the daemon happened to know about it and a list of eight services could not be
 * scanned. Provenance is one eyebrow now; the two conditional lines stay conditional because they
 * are the ones a user acts on, and the terminate confidence has additionally moved to the terminate
 * action itself, which is where it decides something.
 */
function ServiceRowFacts(props: Readonly<{
    row: ServiceRow;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const reason = row.reasonCode
        ? resolveReasonCopy({ reasonCode: row.reasonCode, kind: 'localServiceLauncher' })
        : null;
    const addressValue = formatRowAddress(row);
    const eyebrow = [
        t(row.sourceLabel),
        row.workspaceLabel,
        row.processLabel,
    ].filter((part): part is string => Boolean(part)).join(' · ');
    return (
        <View style={styles.facts}>
            {addressValue ? (
                <ServiceRowAddress
                    addressValue={addressValue}
                    target={row.target}
                    onCopyServiceUrl={props.onCopyServiceUrl}
                    testID={props.testID}
                />
            ) : null}
            <Text testID={`${props.testID}-meta`} style={styles.eyebrow} numberOfLines={1}>
                {eyebrow}
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

export function ServiceRowView(props: Readonly<{
    row: ServiceRow;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    onStartLauncherTarget?: ServiceRowStartHandler;
    onTerminateDetectedService?: ServiceRowTerminateHandler;
    onForgetDetectedService?: ServiceRowForgetHandler;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const runner = useLocalServiceActionRunner();
    const primary = row.primaryAction;
    const canOpen = primary?.kind === 'open' && Boolean(props.onOpenServiceInBrowser);
    const canStart = primary?.kind === 'start' && Boolean(props.onStartLauncherTarget);
    const canTerminate = row.target.source === 'inventory_entry'
        && row.target.actions.includes('terminate_detected')
        && Boolean(props.onTerminateDetectedService);
    // `forget` hides a detected row; it needs no daemon capability bit because the registry
    // suppression is always available for an inventory entry.
    const canForget = row.target.source === 'inventory_entry'
        && Boolean(props.onForgetDetectedService);

    /**
     * Two pending ids for one row, because feedback belongs where the user acted.
     *
     * An inline action has a control the user is looking at, and `IconButton` already owns that
     * control's pending state — returning the run's promise hands it the whole lifecycle, spinner
     * and re-entrancy guard included. An overflow action has no visible control by the time it
     * runs: the popover has closed, so the ROW is the only place left to say "working". Sharing one
     * id would put both spinners on screen for the same dispatch.
     */
    const inlinePendingId = `${row.id}:inline`;
    const menuPendingId = `${row.id}:menu`;

    const handleOpen = React.useCallback(() => {
        if (primary?.kind !== 'open') return undefined;
        return runner.run({
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
     * Destructive and secondary actions live in the row's overflow (U-11).
     *
     * The row used to end in a flush strip of up to six 28px `IconButton`s at `gap: 6`, two of them
     * near-identical red circles — an `x-circle` that kills a process and a `stop-circle` that
     * stopped a managed one — with the reversible `eye-slash` sitting between them. Naming the
     * consequence in a menu is both safer and calmer than asking someone to tell two red glyphs
     * apart at a glance, and `ItemRowActions` is the canonical owner for exactly this: it already
     * carries the destructive tone, the box-model press frame (react-native-web ignores `hitSlop`,
     * and the desktop app IS the web bundle), focus rings, and the anchored `Popover`.
     */
    const overflowActions = React.useMemo((): ItemAction[] => {
        const actions: ItemAction[] = [];
        if (canTerminate) {
            actions.push({
                id: 'terminate',
                title: t('localServices.actions.terminateConfirmCta'),
                // The identity confidence belongs to the decision, not to a permanent grey line in
                // the row: this is the moment it changes what a careful person does.
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

    return (
        <View testID={props.testID}>
            <Item
                testID={`${props.testID}-item`}
                title={(
                    <ServiceRowTitle row={row} animationEnabled={props.animationEnabled} testID={props.testID} />
                )}
                subtitle={(
                    <ServiceRowFacts
                        row={row}
                        onCopyServiceUrl={props.onCopyServiceUrl}
                        testID={props.testID}
                    />
                )}
                // `Item` applies this to primitive subtitle children only, so the node above clamps
                // its own lines; the bound is declared here too because it is the row's contract.
                subtitleLines={2}
                mode="info"
                showChevron={false}
                loading={pending}
                rightElement={(
                    <View style={styles.right}>
                        <StatusPill
                            testID={`${props.testID}-status-${row.status}`}
                            variant={STATUS_VARIANTS[row.status]}
                            label={t(STATUS_LABEL_KEYS[row.status])}
                            isPulsing={row.status === 'running'}
                        />
                        {canOpen ? (
                            <IconButton
                                testID={`${props.testID}-open`}
                                iconName="arrow-square-out"
                                accessibilityLabel={t('localServices.launcher.openInBrowserA11y')}
                                tooltip={t('localServices.launcher.openInBrowserA11y')}
                                minimumInteractiveTargetSize={minimumTargetSize}
                                interactiveTargetGapPx={ROW_ACTION_GAP_PX}
                                animationEnabled={props.animationEnabled}
                                onPress={handleOpen}
                            />
                        ) : null}
                        {canStart ? (
                            <IconButton
                                testID={`${props.testID}-start`}
                                iconName="play-circle"
                                accessibilityLabel={t('localServices.actions.startA11y')}
                                tooltip={t('localServices.actions.startA11y')}
                                minimumInteractiveTargetSize={minimumTargetSize}
                                interactiveTargetGapPx={ROW_ACTION_GAP_PX}
                                animationEnabled={props.animationEnabled}
                                onPress={handleStart}
                            />
                        ) : null}
                        {overflowActions.length > 0 ? (
                            <ItemRowActions
                                title={row.title}
                                actions={overflowActions}
                                // Always-compact with no inline ids: every action in this list is
                                // secondary or destructive, so none of them is ever promoted into
                                // the row regardless of how wide the pane gets.
                                compactThreshold={Number.POSITIVE_INFINITY}
                                compactActionIds={[]}
                                overflowTriggerTestID={`${props.testID}-overflow`}
                                gap={ROW_ACTION_GAP_PX}
                            />
                        ) : null}
                    </View>
                )}
            />
        </View>
    );
}
