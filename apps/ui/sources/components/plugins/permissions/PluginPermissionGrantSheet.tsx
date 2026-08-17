import React from 'react';
import { I18nManager, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierBrandMark } from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { PluginPermissionPendingGrantRequest } from '@/sync/domains/plugins/permissions/types';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

export type PluginPermissionGrantSheetLabels = Readonly<{
    title: string;
    body: (params: Readonly<{ pluginName: string; pluginId: string }>) => string;
    grant: string;
    dismiss: string;
}>;

export type PluginPermissionGrantSheetProps = Readonly<{
    pendingRequest: PluginPermissionPendingGrantRequest;
    labels: PluginPermissionGrantSheetLabels;
    onGrant: (input: Readonly<{ requestId: string }>) => void;
    onDismiss: (input: Readonly<{ requestId: string }>) => void;
    /** Consumer-owned, already localized facts that belong to this exact grant subject. */
    detailRows?: readonly Readonly<{ key: string; label?: string; value: string }>[];
    disabled?: boolean;
    testID?: string;
}>;

function resolvePluginName(request: PluginPermissionPendingGrantRequest): string {
    const pluginName = typeof request.pluginName === 'string' ? request.pluginName.trim() : '';
    return pluginName || request.pluginId;
}

function describeScope(request: PluginPermissionPendingGrantRequest): string | null {
    const scope = request.targetScope;
    if (!scope) return null;
    if (scope.kind === 'account') return t('pluginPermissions.scope.account');
    if (scope.kind === 'project') {
        return `${t('pluginPermissions.scope.project')} · ${scope.projectId}`;
    }
    return `${t('pluginPermissions.scope.workspace')} · ${scope.workspaceId}`;
}

function describeRequester(request: PluginPermissionPendingGrantRequest): string | null {
    const requester = request.requester;
    if (!requester) return null;
    if (requester.kind === 'user') {
        return `${t('pluginPermissions.requester.user')} · ${requester.userId}`;
    }
    if (requester.kind === 'host') {
        return requester.label
            ? `${t('pluginPermissions.requester.host')} · ${requester.label}`
            : t('pluginPermissions.requester.host');
    }
    return [
        `${t('pluginPermissions.requester.plugin')} · ${requester.pluginId}`,
        requester.sessionId
            ? `${t('pluginPermissions.identifiers.session')} · ${requester.sessionId}`
            : null,
        requester.requestId
            ? `${t('pluginPermissions.identifiers.request')} · ${requester.requestId}`
            : null,
    ].filter(Boolean).join(' | ');
}

function describeAuthority(request: PluginPermissionPendingGrantRequest): string | null {
    const authority = request.authoritySource;
    if (!authority) return null;
    if (authority.kind === 'bundled') return t('pluginPermissions.authority.bundled');
    return [
        t('pluginPermissions.authority.machineInstallation'),
        `${t('pluginPermissions.identifiers.machine')} · ${authority.machineId}`,
        `${t('pluginPermissions.identifiers.installation')} · ${authority.installationId}`,
    ].join(' | ');
}

function describeTimestamp(value: number): string | null {
    if (!Number.isFinite(value)) return null;
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) return null;
    try {
        return formatWithCachedDateTimeFormatter(
            timestamp,
            getPreferredLanguage(),
            { dateStyle: 'medium', timeStyle: 'short' },
        );
    } catch {
        return null;
    }
}

function describeField(label: string | undefined, value: string): string {
    return label ? `${label}: ${value}` : value;
}

export function PluginPermissionGrantSheet(props: PluginPermissionGrantSheetProps) {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const pluginName = resolvePluginName(props.pendingRequest);
    const scope = describeScope(props.pendingRequest);
    const requester = describeRequester(props.pendingRequest);
    const authority = describeAuthority(props.pendingRequest);
    const requestedAt = describeTimestamp(props.pendingRequest.createdAt);
    const disabled = props.disabled === true;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const reason = typeof props.pendingRequest.reason === 'string'
        ? props.pendingRequest.reason.trim()
        : '';
    const detailRows = [
        {
            key: 'plugin-id',
            label: t('pluginPermissions.fields.pluginId'),
            value: props.pendingRequest.pluginId,
        },
        {
            key: 'capability',
            label: t('pluginPermissions.fields.capability'),
            value: props.pendingRequest.capability,
        },
        scope
            ? { key: 'scope', label: t('pluginPermissions.fields.scope'), value: scope }
            : null,
        requester
            ? { key: 'requester', label: t('pluginPermissions.fields.requester'), value: requester }
            : null,
        authority
            ? { key: 'authority', label: t('pluginPermissions.fields.authority'), value: authority }
            : null,
        requestedAt
            ? { key: 'requested-at', label: t('pluginPermissions.fields.requestedAt'), value: requestedAt }
            : null,
        ...(props.detailRows ?? []).map((row) => ({ ...row })),
    ].filter((row): row is Readonly<{ key: string; label?: string; value: string }> => row !== null);
    const detailsAccessibilityLabel = t('pluginPermissions.accessibilitySummary', {
        details: detailRows.map((row) => describeField(row.label, row.value)).join('. '),
    });

    const grant = React.useCallback(() => {
        if (disabled) return;
        props.onGrant({ requestId: props.pendingRequest.id });
    }, [disabled, props]);
    const dismiss = React.useCallback(() => {
        if (disabled) return;
        props.onDismiss({ requestId: props.pendingRequest.id });
    }, [disabled, props]);

    return (
        <View
            testID={props.testID}
            style={{
                gap: 10,
                padding: 12,
                borderWidth: 1,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.inset,
            }}
        >
            <Text style={{ color: theme.colors.text.primary }}>
                {props.labels.title}
            </Text>
            <Text style={{ color: theme.colors.text.secondary }}>
                {props.labels.body({ pluginName, pluginId: props.pendingRequest.pluginId })}
            </Text>
            <HappierBrandMark
                displayName={pluginName}
                size="small"
                externallyLabelled
                theme={presentationTheme}
                colorScheme={theme.dark ? 'dark' : 'light'}
                testID={props.testID ? `${props.testID}-brand` : undefined}
            />
            <View
                testID={props.testID ? `${props.testID}-details` : undefined}
                accessible
                accessibilityRole="summary"
                accessibilityLabel={detailsAccessibilityLabel}
                style={{ gap: 4, direction: I18nManager.isRTL ? 'rtl' : 'ltr' }}
            >
                <Text style={{ color: theme.colors.text.primary }}>
                    {pluginName}
                </Text>
                {detailRows.map((row) => (
                    <Text
                        key={row.key}
                        testID={props.testID ? `${props.testID}-${row.key}` : undefined}
                        style={{
                            color: theme.colors.text.secondary,
                            flexShrink: 1,
                            writingDirection: I18nManager.isRTL ? 'rtl' : 'ltr',
                        }}
                        selectable
                    >
                        {describeField(row.label, row.value)}
                    </Text>
                ))}
                {reason ? (
                    <Text style={{ color: theme.colors.text.secondary }}>
                        {reason}
                    </Text>
                ) : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Pressable
                    onPress={disabled ? undefined : grant}
                    testID={props.testID ? `${props.testID}-grant` : undefined}
                    accessibilityRole="button"
                    accessibilityState={{ disabled }}
                    disabled={disabled}
                    style={{
                        minHeight: minimumInteractiveTargetSize,
                        justifyContent: 'center',
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        backgroundColor: theme.colors.button.primary.background,
                        opacity: disabled ? 0.5 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.button.primary.tint }}>
                        {props.labels.grant}
                    </Text>
                </Pressable>
                <Pressable
                    onPress={disabled ? undefined : dismiss}
                    testID={props.testID ? `${props.testID}-dismiss` : undefined}
                    accessibilityRole="button"
                    accessibilityState={{ disabled }}
                    disabled={disabled}
                    style={{
                        minHeight: minimumInteractiveTargetSize,
                        justifyContent: 'center',
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        opacity: disabled ? 0.5 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.text.primary }}>
                        {props.labels.dismiss}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}
