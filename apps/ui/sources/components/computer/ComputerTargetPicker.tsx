import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { computerTargetKeyV1, type ComputerAccessV1 } from '@happier-dev/protocol/computer/v1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { groupComputerTargets, resolveComputerRecovery, type ComputerTargetEntry } from '@/sync/domains/computer/targets';
export { resolveSuggestedTargetKey, type ComputerTargetEntry, type ComputerTargetPickerState } from '@/sync/domains/computer/targets';
import type { ComputerTargetPickerState } from '@/sync/domains/computer/targets';

import { ComputerPermissionCard, type ComputerOpenSettingsState } from './ComputerPermissionCard';

/** The exact physical target, in the computer owner's own key shape (display, kind, process, window). */
export const computerTargetKey = computerTargetKeyV1;

/** Why a share did not land, said once above the buttons (the list stays as it was). */
const NOTICE_KEY: Readonly<Record<string, Parameters<typeof t>[0]>> = {
    computer_target_in_use: 'computerUse.picker.inUse',
    computer_target_not_available: 'computerUse.picker.closed',
};

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: 4,
    },
    state: {
        paddingVertical: 24,
    },
    notice: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 4,
    },
    noticeText: {
        ...Typography.rowMeta(),
        flex: 1,
        color: theme.colors.state.warning.foreground,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
    grow: {
        flex: 1,
    },
    footerCompact: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    fullWidth: {
        alignSelf: 'stretch',
    },
    policy: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 4,
    },
    policyText: {
        ...Typography.rowMeta(),
        flex: 1,
        color: theme.colors.text.secondary,
    },
    footnote: {
        paddingBottom: 12,
    },
    // Inside the group's own header box (its insets): the title, then the action at the trailing edge.
    groupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    groupTitle: {
        ...Typography.rowMeta(),
        flex: 1,
        color: theme.colors.text.secondary,
        textTransform: 'none',
        letterSpacing: 0,
    },
    policyLink: {
        color: theme.colors.accent.blue,
    },
    consentHeader: {
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 8,
    },
    consentTitle: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
        textAlign: 'center',
    },
    consentBody: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));

/** What the person chose to share, when the leaf decides it at the press (a row, or the display consent). */
export type ComputerTargetShareChoice = Readonly<{ key: string; access: ComputerAccessV1 }>;

function TargetRows(props: Readonly<{
    title: string;
    entries: readonly Readonly<{ entry: ComputerTargetEntry; label: string }>[];
    iconName: 'browsers' | 'desktop';
    selectedKey: string | null;
    onSelect: (key: string) => void;
    /** The agent's suggestion (an approval of its `computer.target.select`), marked on its row. */
    suggestedKey?: string | null;
    suggestedLabel?: string;
    /** The switcher marks what is shared now with a check; the form marks the pending choice with a radio. */
    mark: 'radio' | 'check';
    /** What is shared with the agent right now, said on its row. */
    currentKey?: string | null;
    /** The group's own action (Refresh). */
    action?: React.ReactNode;
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (props.entries.length === 0) return null;
    return (
        <ItemGroup
            // The group's own action sits on its title line; a plain title keeps the group's header.
            title={props.action ? (
                <View style={stylesheet.groupHeader}>
                    <Eyebrow style={stylesheet.groupTitle}>{props.title}</Eyebrow>
                    {props.action}
                </View>
            ) : props.title}
            accessibilityRole="radiogroup"
            accessibilityLabel={props.title}
        >
            {props.entries.map(({ entry, label }) => {
                const key = computerTargetKey(entry.target);
                const selected = props.selectedKey === key;
                const display = entry.target.kind === 'display';
                return (
                    <Item
                        key={key}
                        testID={`${props.testID}:${entry.target.kind}`}
                        title={label}
                        subtitle={[entry.appName, display && entry.width && entry.height ? `${entry.width} × ${entry.height}` : null,
                            display ? t('computerUse.picker.displayShared') : null,
                            props.currentKey === key ? t('computerUse.picker.usingIt') : null,
                            props.suggestedKey === key ? props.suggestedLabel : null].filter(Boolean).join(' · ') || undefined}
                        icon={entry.thumbnail ? <SafeExpoImage
                            source={{ uri: `data:${entry.thumbnail.mimeType};base64,${entry.thumbnail.base64}` }}
                            contentFit="contain"
                            style={{ width: ICON_SIZE.md, height: ICON_SIZE.md }}
                            testID={`${props.testID.replace('-target', '-thumbnail')}:${entry.target.kind}`}
                        /> : <Icon name={props.iconName} size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                        accessibilityRole="radio"
                        webRole="radio"
                        selected={selected}
                        rightElement={props.mark === 'check' ? (
                            selected ? <Icon name="check" size={ICON_SIZE.md} color={theme.colors.text.primary} /> : undefined
                        ) : (
                            <Icon
                                name={selected ? 'radio-button' : 'circle'}
                                size={ICON_SIZE.md}
                                color={selected ? theme.colors.accent.blue : theme.colors.text.tertiary}
                            />
                        )}
                        onPress={() => props.onSelect(key)}
                        showChevron={false}
                    />
                );
            })}
        </ItemGroup>
    );
}

/**
 * Sharing a whole display, confirmed on its own step (lab `b-mac` D): what it exposes, then viewing and
 * mouse-and-keyboard as two separate grants. Nothing is shared until Share display.
 */
function WholeDisplayConsent(props: Readonly<{
    displayLabel: string;
    agentName: string;
    initialUse: boolean;
    /** The machine's OS denies input: mouse and keyboard cannot be granted from here. */
    inputDenied: boolean;
    sharing: boolean;
    compact?: boolean;
    onCancel: () => void;
    onShare: (access: ComputerAccessV1) => void;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [see, setSee] = React.useState(true);
    const [use, setUse] = React.useState(props.initialUse && !props.inputDenied);
    return (
        <View role="dialog" accessibilityLabel={t('computerUse.picker.wholeDisplayTitle')} testID={props.testID}>
            <View style={stylesheet.consentHeader}>
                <Icon name="desktop" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />
                <Text style={stylesheet.consentTitle}>{t('computerUse.picker.wholeDisplayTitle')}</Text>
                <Text style={stylesheet.consentBody}>{t('computerUse.picker.wholeDisplayBody', { display: props.displayLabel })}</Text>
            </View>
            <ItemGroup>
                <Item
                    title={t('computerUse.picker.allowSee')}
                    rightElement={<Switch value={see} onValueChange={setSee} testID={`${props.testID}-see`} />}
                    showChevron={false}
                />
                <Item
                    title={t('computerUse.picker.allowUse')}
                    subtitle={props.inputDenied
                        ? `${t('computerUse.permission.input')}: ${t('computerUse.permission.denied')}`
                        : t('computerUse.picker.allowUseHint', { agent: props.agentName })}
                    rightElement={<Switch value={see && use} onValueChange={setUse} disabled={!see || props.inputDenied} testID={`${props.testID}-use`} />}
                    showChevron={false}
                />
            </ItemGroup>
            <View style={[stylesheet.footer, props.compact ? stylesheet.footerCompact : null]}>
                {props.compact ? null : <View style={stylesheet.grow} />}
                <RoundButton size={props.compact ? 'normal' : 'small'} display="secondary" title={t('common.cancel')} onPress={props.onCancel} testID={`${props.testID}-cancel`} />
                <RoundButton
                    size={props.compact ? 'normal' : 'small'}
                    title={t('computerUse.picker.shareDisplay')}
                    disabled={!see || props.sharing}
                    loading={props.sharing}
                    onPress={() => props.onShare(see && use ? 'use' : 'see')}
                    testID={`${props.testID}-share`}
                />
            </View>
        </View>
    );
}

/**
 * Choose exactly what the agent may use (lab `computer` TP/OG): one window or one whole screen on the
 * machine the request names, from that machine's own list. Nothing is preselected: the person chooses,
 * the picker never does (W7: no auto-selection). When the machine lacks the OS permission the picker
 * shows why and opens the settings pane there instead of an empty list.
 *
 * One leaf, two densities. `form` (the first consent and an approval, in a dialog or a sheet): choose,
 * set what the agent may do, then Share. `switcher` (anchored to the viewer's source switch, lab
 * `b-mac` A): the rows are the action, so pressing a window watches it with the access already
 * granted, the shared one carries a check, and there is no footer. A whole display always goes
 * through its own consent step in both.
 */
export function ComputerTargetPicker(props: Readonly<{
    machineName: string;
    state: ComputerTargetPickerState;
    selectedKey: string | null;
    onSelect: (key: string) => void;
    access: ComputerAccessV1;
    onAccessChange: (access: ComputerAccessV1) => void;
    /** The share is being applied by the machine. */
    sharing: boolean;
    /** The machine's refusal of the last share, if any. */
    noticeCode: string | null;
    /** A target is already shared: offer to stop sharing it. */
    canStopSharing: boolean;
    /** Share the pending choice, or exactly `choice` when the leaf decided it at the press. */
    onShare: (choice?: ComputerTargetShareChoice) => void;
    onStopSharing: () => void;
    onCancel: () => void;
    onRetry: () => void;
    onOpenSettings: (permission: 'capture' | 'input') => void;
    openSettings: ComputerOpenSettingsState;
    /** The agent's name, for what it may do and the ask-first line. */
    agentName: string;
    /**
     * The person's own Ask-first preferences for the agent's screenshots and its clicks/keys (the
     * existing Actions approval owner), said as one line with Change.
     */
    policy: Readonly<{ asksBeforeScreenshots: boolean; asksBeforeInput: boolean }>;
    onChangePolicy?: () => void;
    /** Phone: a bottom sheet with one full-width primary (no Cancel; the sheet closes). */
    compact?: boolean;
    /**
     * The window the agent suggested (the approval of an agent's `computer.target.select`): it starts
     * chosen and its row says "{agent} suggests"; the person may pick another before approving.
     */
    suggestedKey?: string | null;
    density?: 'form' | 'switcher';
    /** What is shared with the agent right now (the switcher marks it). */
    currentKey?: string | null;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'computer-target-picker';
    const { state, machineName } = props;
    const recovery = resolveComputerRecovery(state, props.access);
    const switcher = props.density === 'switcher';
    // The display waiting for its consent step.
    const [consentKey, setConsentKey] = React.useState<string | null>(null);

    if (state.kind === 'loading') {
        return (
            <View style={stylesheet.state} testID={`${testID}-loading`}>
                <SurfaceStateCard kind="loading" title={t('computerUse.picker.loadingTitle', { machine: machineName })} />
            </View>
        );
    }
    if (state.kind === 'failed') {
        const noScreen = recovery?.cause === 'headless';
        const unsupported = recovery?.cause === 'unsupported';
        if (recovery?.cause === 'machine_mismatch') {
            return (
                <View style={stylesheet.state} testID={`${testID}-failed`}>
                    <SurfaceStateCard
                        kind="unavailable"
                        iconName="laptop"
                        title={t('computerUse.picker.otherMachineTitle', { machine: machineName })}
                        reason={t('computerUse.picker.otherMachineBody')}
                        diagnosticCode={state.code}
                    />
                </View>
            );
        }
        return (
            <View style={stylesheet.state} testID={`${testID}-failed`}>
                <SurfaceStateCard
                    kind={noScreen || unsupported ? 'unavailable' : 'error'}
                    iconName={noScreen || unsupported ? 'desktop' : undefined}
                    title={noScreen
                        ? t('computerUse.picker.noScreenTitle', { machine: machineName })
                        : unsupported
                            ? t('computerUse.picker.unsupportedTitle', { machine: machineName })
                            : t('computerUse.picker.failedTitle', { machine: machineName })}
                    reason={noScreen
                        ? t('computerUse.picker.noScreenBody')
                        : unsupported ? t('computerUse.picker.unsupportedBody') : t('computerUse.picker.failedBody')}
                    diagnosticCode={state.code}
                    action={noScreen || unsupported ? undefined : { label: t('computerUse.picker.tryAgain'), onPress: props.onRetry }}
                />
            </View>
        );
    }
    const accessChoice = <ItemGroup>
        <SegmentedChoiceItem
            title={t('computerUse.picker.access', { agent: props.agentName })}
            value={props.access}
            onChange={props.onAccessChange}
            options={[
                { id: 'see', label: t('computerUse.picker.accessSee') },
                { id: 'use', label: t('computerUse.picker.accessValue'),
                    ...(state.grants.input === 'denied' ? { unavailableReason: `${t('computerUse.permission.input')}: ${t('computerUse.permission.denied')}` } : {}) },
            ]}
            disabled={props.sharing}
            testID={`${testID}-access`}
            testIDPrefix={`${testID}-access`}
        />
    </ItemGroup>;
    const displayNotice = state.displays?.status === 'unavailable' ? (
        <ItemGroup title={t('computerUse.picker.screens')}>
            <SurfaceStateCard
                kind="unavailable"
                size="line"
                title={t('computerUse.picker.displayUnavailable')}
                diagnosticCode={state.displays.code}
                testID={`${testID}-displays-unavailable`}
            />
        </ItemGroup>
    ) : null;
    if (recovery?.cause === 'permission_denied' || recovery?.cause === 'permission_unknown') {
        return (
            <View style={stylesheet.state} testID={`${testID}-permission`}>
                {state.grants.capture === 'granted' ? accessChoice : null}
                <ComputerPermissionCard
                    machineName={machineName}
                    grants={state.grants}
                    openSettings={props.openSettings}
                    onOpenSettings={props.onOpenSettings}
                    onCheckAgain={props.onRetry}
                />
            </View>
        );
    }
    if (recovery?.cause === 'empty') {
        return (
            <View style={stylesheet.state} testID={`${testID}-empty`}>
                {displayNotice}
                <SurfaceStateCard
                    kind="empty"
                    iconName="browsers"
                    title={t('computerUse.picker.emptyTitle', { machine: machineName })}
                    reason={t('computerUse.picker.emptyBody')}
                    action={{ label: t('computerUse.permission.checkAgain'), onPress: props.onRetry }}
                />
            </View>
        );
    }

    const groups = groupComputerTargets(state.targets);
    const windows = groups.windows
        .map((entry) => ({ entry, label: entry.title?.trim() || t('computerUse.picker.untitledWindow') }));
    const screens = groups.displays
        .map((entry, index) => ({ entry, label: entry.label?.trim() || entry.title?.trim() || t('computerUse.picker.screenLabel', { index: String(index + 1) }) }));
    const chosen = state.targets.find((entry) => computerTargetKey(entry.target) === props.selectedKey) ?? null;
    const noticeKey = props.noticeCode ? NOTICE_KEY[props.noticeCode] ?? 'computerUse.picker.selectFailed' : null;
    // A whole display shares every app and notification on it: say so before it is shared (64 §2).
    const consentDisplay = consentKey
        ? screens.find(({ entry }) => computerTargetKey(entry.target) === consentKey) ?? null
        : null;
    const notice = noticeKey ? (
        <View style={stylesheet.notice} accessibilityLiveRegion="polite" testID={`${testID}-notice`}>
            <Icon name="warning" size={ICON_SIZE.sm} color={theme.colors.state.warning.foreground} />
            <Text style={stylesheet.noticeText}>{t(noticeKey)}</Text>
        </View>
    ) : null;

    if (consentKey && consentDisplay) {
        return (
            <View style={stylesheet.root} testID={`${testID}-ready`}>
                <WholeDisplayConsent
                    displayLabel={consentDisplay.label}
                    agentName={props.agentName}
                    initialUse={!switcher && props.access === 'use'}
                    inputDenied={state.grants.input === 'denied'}
                    sharing={props.sharing}
                    compact={props.compact}
                    onCancel={() => setConsentKey(null)}
                    onShare={(access) => props.onShare({ key: consentKey, access })}
                    testID={`${testID}-display-consent`}
                />
                {notice}
            </View>
        );
    }

    const isDisplayKey = (key: string) => screens.some(({ entry }) => computerTargetKey(entry.target) === key);
    // In the switcher a row is the action: a window is watched at once, a display asks first.
    const onRowPress = switcher
        ? (key: string) => {
            if (isDisplayKey(key)) setConsentKey(key);
            else if (key !== props.currentKey) props.onShare({ key, access: props.access });
        }
        : props.onSelect;
    const rows = {
        selectedKey: switcher ? props.currentKey ?? null : props.selectedKey,
        onSelect: onRowPress,
        mark: switcher ? 'check' : 'radio',
        currentKey: props.currentKey,
        suggestedKey: props.suggestedKey,
        suggestedLabel: t('computerUse.picker.suggests', { agent: props.agentName }),
        testID: `${testID}-target`,
    } as const;
    const refresh = (
        <IconButton
            variant="plain"
            iconName="arrows-clockwise"
            accessibilityLabel={t('computerUse.picker.refresh')}
            tooltip={t('computerUse.picker.refresh')}
            onPress={props.onRetry}
            testID={`${testID}-refresh`}
        />
    );

    if (switcher) {
        return (
            <View style={stylesheet.root} testID={`${testID}-ready`}>
                <TargetRows title={t('computerUse.picker.windows')} entries={windows} iconName="browsers" action={refresh} {...rows} />
                {displayNotice}
                <TargetRows title={t('computerUse.picker.screens')} entries={screens} iconName="desktop" action={windows.length === 0 ? refresh : undefined} {...rows} />
                {notice}
                <View style={[stylesheet.policy, stylesheet.footnote]}>
                    <Icon name="shield-check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                    <Text style={stylesheet.policyText} testID={`${testID}-footnote`}>{t('computerUse.picker.footnote')}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={stylesheet.root} testID={`${testID}-ready`}>
            <TargetRows title={t('computerUse.picker.windows')} entries={windows} iconName="browsers" action={refresh} {...rows} />
            {displayNotice}
            <TargetRows title={t('computerUse.picker.screens')} entries={screens} iconName="desktop" action={windows.length === 0 ? refresh : undefined} {...rows} />
            {notice}
            {accessChoice}
            <View style={stylesheet.policy}>
                <Icon name="shield-check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                <Text style={stylesheet.policyText} testID={`${testID}-policy`}>
                    {t(props.policy.asksBeforeScreenshots && props.policy.asksBeforeInput
        ? 'computerUse.picker.policyBoth'
        : props.policy.asksBeforeInput
            ? 'computerUse.picker.policyInput'
            : props.policy.asksBeforeScreenshots
                ? 'computerUse.picker.policyCapture'
                : 'computerUse.picker.policyNone', { agent: props.agentName })}
                    {props.onChangePolicy ? (
                        <Text
                            accessibilityRole="link"
                            onPress={props.onChangePolicy}
                            style={stylesheet.policyLink}
                            testID={`${testID}-policy-change`}
                        >
                            {` ${t('computerUse.picker.policyChange')}`}
                        </Text>
                    ) : null}
                </Text>
            </View>
            <View style={[stylesheet.footer, props.compact ? stylesheet.footerCompact : null]}>
                {props.canStopSharing ? (
                    <RoundButton
                        size="small"
                        display="secondary"
                        title={t('computerUse.picker.stopSharing')}
                        onPress={props.onStopSharing}
                        testID={`${testID}-stop-sharing`}
                    />
                ) : null}
                {props.compact ? null : <View style={stylesheet.grow} />}
                {props.compact ? null : (
                    <RoundButton size="small" display="secondary" title={t('common.cancel')} onPress={props.onCancel} testID={`${testID}-cancel`} />
                )}
                <RoundButton
                    size={props.compact ? 'normal' : 'small'}
                    title={chosen?.target.kind === 'display' ? t('computerUse.picker.shareScreen')
                        : chosen?.appName ? t('computerUse.picker.shareApp', { app: chosen.appName }) : t('computerUse.picker.share')}
                    disabled={!chosen || props.sharing}
                    loading={props.sharing}
                    // A whole display is confirmed on its own step; a window is shared at once.
                    onPress={() => {
                        if (chosen?.target.kind === 'display') setConsentKey(computerTargetKey(chosen.target));
                        else props.onShare();
                    }}
                    style={props.compact ? stylesheet.fullWidth : undefined}
                    testID={`${testID}-share`}
                />
            </View>
        </View>
    );
}
