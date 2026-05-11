import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { resolveRecipientAccentColor } from '@/components/sessions/agentInput/routing/resolveRecipientAccentColor';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { SessionSubagentQuickActions } from '@/components/sessions/agents/actions/SessionSubagentQuickActions';
import { resolveSessionSubagentPrimaryTitle } from '@/components/sessions/agents/presentation/resolveSessionSubagentPrimaryTitle';
import { t } from '@/text';
import { SessionSubagentFactsRow } from './SessionSubagentFactsRow';

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 16,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 14,
        paddingVertical: 14,
        gap: 12,
    },
    rowMain: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    leadingIcon: {
        width: 28,
        height: 28,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 6,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        minWidth: 0,
    },
    titleBlock: {
        flex: 1,
        minWidth: 0,
        gap: 6,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text.primary,
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        fontWeight: '600',
    },
    statusPill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '700',
    },
    permissionPill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.accent.yellow,
        backgroundColor: theme.colors.surface.base,
    },
    permissionText: {
        fontSize: 11,
        fontWeight: '700',
        color: theme.colors.accent.yellow,
    },
    subtitle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    activity: {
        color: theme.colors.text.primary,
        fontSize: 12,
    },
    footer: {
        gap: 8,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
        gap: 8,
    },
    iconButton: {
        width: 30,
        height: 30,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
}));

const ViewWithClick = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & { onClick?: any; onKeyDown?: any; tabIndex?: number }
>;

function resolveKindIconName(kind: SessionSubagent['kind']): React.ComponentProps<typeof Ionicons>['name'] {
    if (kind === 'execution_run') return 'play-circle-outline';
    if (kind === 'agent_team_member') return 'people-outline';
    return 'layers-outline';
}

function buildSubtitle(subagent: SessionSubagent): string {
    return [
        subagent.display.subtitle,
        subagent.kind === 'execution_run' ? subagent.runRef?.runId : null,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' · ');
}

function resolveStatusColor(status: SessionSubagent['status'], theme: ReturnType<typeof useUnistyles>['theme']): string {
    if (status === 'running') return theme.colors.accent.blue;
    if (status === 'succeeded') return theme.colors.accent.green;
    if (status === 'failed') return theme.colors.accent.red;
    if (status === 'cancelled' || status === 'terminated') return theme.colors.accent.orange;
    return theme.colors.text.secondary;
}

export const SessionSubagentRow = React.memo((props: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
    activityPreview?: string | null;
    hasPendingPermission?: boolean;
    onOpenPreview: () => void;
    onOpenFull: (() => void) | null;
    onOpenAdvanced: (() => void) | null;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const accentColor = props.subagent.display.accentName
        ? resolveRecipientAccentColor({ theme, accentName: props.subagent.display.accentName })
        : undefined;
    const subtitle = buildSubtitle(props.subagent);
    const title = resolveSessionSubagentPrimaryTitle(props.subagent);
    const kindIconName = resolveKindIconName(props.subagent.kind);
    const statusColor = resolveStatusColor(props.subagent.status, theme);
    const openPreviewFromEvent = React.useCallback((event?: unknown) => {
        const maybeEvent = event as {
            stopPropagation?: () => void;
            nativeEvent?: { stopPropagation?: () => void };
            key?: string;
        } | undefined;
        try { maybeEvent?.stopPropagation?.(); } catch {}
        try { maybeEvent?.nativeEvent?.stopPropagation?.(); } catch {}
        props.onOpenPreview();
    }, [props]);

    if (Platform.OS === 'web') {
        return (
            <ViewWithClick
                testID={`session-subagent-row:${props.subagent.id}`}
                accessibilityLabel={title}
                onClick={openPreviewFromEvent}
                onKeyDown={(event: { key?: string; preventDefault?: () => void; stopPropagation?: () => void; nativeEvent?: { stopPropagation?: () => void } }) => {
                    const key = String(event?.key ?? '');
                    if (key !== 'Enter' && key !== ' ') return;
                    event?.preventDefault?.();
                    openPreviewFromEvent(event);
                }}
                tabIndex={0}
                style={styles.row}
            >
                <View testID={`session-subagent-main:${props.subagent.id}`} style={styles.rowMain}>
                    <View
                        style={[
                            styles.leadingIcon,
                            accentColor ? { borderColor: accentColor } : null,
                        ]}
                    >
                        <Ionicons name={kindIconName} size={16} color={accentColor ?? theme.colors.text.secondary} />
                    </View>
                    <View style={styles.copy}>
                        <View style={styles.headerRow}>
                            <View style={styles.titleBlock}>
                                <View style={styles.titleRow}>
                                    <Text numberOfLines={1} style={styles.title}>{title}</Text>
                                    {props.hasPendingPermission ? (
                                        <View testID={`session-subagent-permission-blocked:${props.subagent.id}`} style={styles.permissionPill}>
                                            <Text style={styles.permissionText}>{t('connect.waitingForApproval')}</Text>
                                        </View>
                                    ) : null}
                                    <View style={styles.statusPill}>
                                        <Text style={[styles.statusText, { color: statusColor }]}>{props.subagent.status}</Text>
                                    </View>
                                </View>
                                {subtitle ? (
                                    <Text numberOfLines={2} style={styles.subtitle}>{subtitle}</Text>
                                ) : null}
                            </View>
                            <SessionSubagentQuickActions
                                testID={`session-subagent-actions:${props.subagent.id}`}
                                sessionId={props.sessionId}
                                subagent={props.subagent}
                                onOpenFull={
                                    props.onOpenFull
                                        ? () => {
                                            props.onOpenFull?.();
                                        }
                                        : null
                                }
                                onSend={
                                    props.subagent.capabilities.canSend
                                        ? () => {
                                            props.onOpenPreview();
                                        }
                                        : null
                                }
                                style={{ actions: styles.actions, iconButton: styles.iconButton }}
                            />
                        </View>
                        {props.activityPreview ? (
                            <Text
                                testID={`session-subagent-activity:${props.subagent.id}`}
                                numberOfLines={2}
                                style={styles.activity}
                            >
                                {props.activityPreview}
                            </Text>
                        ) : null}
                    </View>
                </View>
                <View testID={`session-subagent-footer:${props.subagent.id}`} style={styles.footer}>
                    <SessionSubagentFactsRow subagent={props.subagent} onOpenAdvanced={props.onOpenAdvanced} />
                </View>
            </ViewWithClick>
        );
    }

    return (
        <Pressable
            testID={`session-subagent-row:${props.subagent.id}`}
            accessibilityRole="button"
            onPress={props.onOpenPreview}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}
        >
            <View testID={`session-subagent-main:${props.subagent.id}`} style={styles.rowMain}>
                <View
                    style={[
                        styles.leadingIcon,
                        accentColor ? { borderColor: accentColor } : null,
                    ]}
                >
                    <Ionicons name={kindIconName} size={16} color={accentColor ?? theme.colors.text.secondary} />
                </View>
                <View style={styles.copy}>
                    <View style={styles.headerRow}>
                        <View style={styles.titleBlock}>
                            <View style={styles.titleRow}>
                                <Text numberOfLines={1} style={styles.title}>{title}</Text>
                                {props.hasPendingPermission ? (
                                    <View testID={`session-subagent-permission-blocked:${props.subagent.id}`} style={styles.permissionPill}>
                                        <Text style={styles.permissionText}>{t('connect.waitingForApproval')}</Text>
                                    </View>
                                ) : null}
                                <View style={styles.statusPill}>
                                    <Text style={[styles.statusText, { color: statusColor }]}>{props.subagent.status}</Text>
                                </View>
                            </View>
                            {subtitle ? (
                                <Text numberOfLines={2} style={styles.subtitle}>{subtitle}</Text>
                            ) : null}
                        </View>
                        <SessionSubagentQuickActions
                            testID={`session-subagent-actions:${props.subagent.id}`}
                            sessionId={props.sessionId}
                            subagent={props.subagent}
                            onOpenFull={
                                props.onOpenFull
                                    ? () => {
                                        props.onOpenFull?.();
                                    }
                                    : null
                            }
                            onSend={
                                props.subagent.capabilities.canSend
                                    ? () => {
                                        props.onOpenPreview();
                                    }
                                    : null
                            }
                            style={{ actions: styles.actions, iconButton: styles.iconButton }}
                        />
                    </View>
                    {props.activityPreview ? (
                        <Text
                            testID={`session-subagent-activity:${props.subagent.id}`}
                            numberOfLines={2}
                            style={styles.activity}
                        >
                            {props.activityPreview}
                        </Text>
                    ) : null}
                </View>
            </View>
            <View testID={`session-subagent-footer:${props.subagent.id}`} style={styles.footer}>
                <SessionSubagentFactsRow subagent={props.subagent} onOpenAdvanced={props.onOpenAdvanced} />
            </View>
        </Pressable>
    );
});
