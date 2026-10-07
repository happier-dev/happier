import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { computerTargetKeyV1, type ComputerAccessV1, type ComputerGrantStatusV1, type ComputerTargetsListResponseV1 } from '@happier-dev/protocol/computer/v1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { ComputerPermissionCard, needsComputerPermission, type ComputerOpenSettingsState } from './ComputerPermissionCard';

export type ComputerTargetEntry = ComputerTargetsListResponseV1['targets'][number];

/** What the picker shows: the machine's own list, or why there is none. */
export type ComputerTargetPickerState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; targets: readonly ComputerTargetEntry[]; grants: ComputerGrantStatusV1; displays?: ComputerTargetsListResponseV1['displays'] }>
    | Readonly<{ kind: 'failed'; code: string }>;

/** The exact physical target, in the computer owner's own key shape (display, kind, process, window). */
export const computerTargetKey = computerTargetKeyV1;

/**
 * The listed window an agent's suggestion names (a title or app hint it wrote): the first whose title
 * contains it, ignoring case. A hint is not an identity; the person still sees and confirms the row.
 */
export function resolveSuggestedTargetKey(targets: readonly ComputerTargetEntry[], suggestion: string | null | undefined): string | null {
    const hint = suggestion?.trim().toLocaleLowerCase();
    if (!hint) return null;
    const match = targets.find((entry) => entry.title?.toLocaleLowerCase().includes(hint) || entry.appName?.toLocaleLowerCase().includes(hint));
    return match ? computerTargetKey(match.target) : null;
}

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
    policyLink: {
        color: theme.colors.accent.blue,
    },
}));

function TargetRows(props: Readonly<{
    title: string;
    entries: readonly Readonly<{ entry: ComputerTargetEntry; label: string }>[];
    iconName: 'browsers' | 'desktop';
    selectedKey: string | null;
    onSelect: (key: string) => void;
    /** The agent's suggestion (an approval of its `computer.target.select`), marked on its row. */
    suggestedKey?: string | null;
    suggestedLabel?: string;
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (props.entries.length === 0) return null;
    return (
        <ItemGroup title={props.title} accessibilityRole="radiogroup" accessibilityLabel={props.title}>
            {props.entries.map(({ entry, label }) => {
                const key = computerTargetKey(entry.target);
                const selected = props.selectedKey === key;
                return (
                    <Item
                        key={key}
                        testID={`${props.testID}:${entry.target.kind}`}
                        title={label}
                        subtitle={[entry.appName, entry.target.kind === 'display' && entry.width && entry.height ? `${entry.width} × ${entry.height}` : null,
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
                        rightElement={(
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
 * Choose exactly what the agent may use (lab `computer` TP/OG): one window or one whole screen on the
 * machine the request names, from that machine's own list. Nothing is preselected: the person chooses,
 * the picker never does (W7: no auto-selection). When the machine lacks the OS permission the picker
 * shows why and opens the settings pane there instead of an empty list.
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
    onShare: () => void;
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
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'computer-target-picker';
    const { state, machineName } = props;

    if (state.kind === 'loading') {
        return (
            <View style={stylesheet.state} testID={`${testID}-loading`}>
                <SurfaceStateCard kind="loading" title={t('computerUse.picker.loadingTitle', { machine: machineName })} />
            </View>
        );
    }
    if (state.kind === 'failed') {
        const noScreen = state.code === 'computer_display_unavailable';
        const unsupported = state.code === 'target_unsupported';
        if (state.code === 'computer_machine_mismatch') {
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
    if (needsComputerPermission(state.grants, props.access)) {
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
    if (state.targets.length === 0) {
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

    const windows = state.targets
        .filter((entry) => entry.target.kind === 'window')
        .map((entry) => ({ entry, label: entry.title?.trim() || t('computerUse.picker.untitledWindow') }));
    const screens = state.targets
        .filter((entry) => entry.target.kind === 'display')
        .map((entry, index) => ({ entry, label: entry.label?.trim() || entry.title?.trim() || t('computerUse.picker.screenLabel', { index: String(index + 1) }) }));
    const chosen = state.targets.find((entry) => computerTargetKey(entry.target) === props.selectedKey) ?? null;
    const noticeKey = props.noticeCode ? NOTICE_KEY[props.noticeCode] ?? 'computerUse.picker.selectFailed' : null;

    return (
        <View style={stylesheet.root} testID={`${testID}-ready`}>
            <TargetRows
                title={t('computerUse.picker.windows')}
                entries={windows}
                iconName="browsers"
                selectedKey={props.selectedKey}
                onSelect={props.onSelect}
                suggestedKey={props.suggestedKey}
                suggestedLabel={t('computerUse.picker.suggests', { agent: props.agentName })}
                testID={`${testID}-target`}
            />
            {displayNotice}
            <TargetRows
                title={t('computerUse.picker.screens')}
                entries={screens}
                iconName="desktop"
                selectedKey={props.selectedKey}
                onSelect={props.onSelect}
                suggestedKey={props.suggestedKey}
                suggestedLabel={t('computerUse.picker.suggests', { agent: props.agentName })}
                testID={`${testID}-target`}
            />
            {noticeKey ? (
                <View style={stylesheet.notice} accessibilityLiveRegion="polite" testID={`${testID}-notice`}>
                    <Icon name="warning" size={ICON_SIZE.sm} color={theme.colors.state.warning.foreground} />
                    <Text style={stylesheet.noticeText}>{t(noticeKey)}</Text>
                </View>
            ) : null}
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
                    onPress={props.onShare}
                    style={props.compact ? stylesheet.fullWidth : undefined}
                    testID={`${testID}-share`}
                />
            </View>
        </View>
    );
}
