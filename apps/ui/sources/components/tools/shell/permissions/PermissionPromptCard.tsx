import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { Text } from '@/components/ui/text/Text';
import { PermissionFooter } from '@/components/tools/shell/permissions/PermissionFooter';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { t } from '@/text';
import { buildPermissionPromptModel } from '@/components/tools/shell/permissions/presentation/buildPermissionPromptModel';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import { ToolInlineBody } from '@/components/tools/shell/views/ToolInlineBody';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    type ToolViewDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

export const PermissionPromptCard = React.memo(function PermissionPromptCard(props: {
    request: PendingPermissionRequest;
    location: PermissionToolCallMessageLocation | null;
    sessionId: string;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    chrome?: 'card' | 'inline';
}) {
    const { theme } = useUnistyles();
    const router = useRouter();

    const toolViewDetailLevelDefault = useSetting('toolViewDetailLevelDefault');
    const toolViewDetailLevelDefaultLocalControl = useSetting('toolViewDetailLevelDefaultLocalControl');
    const toolViewDetailLevelByToolName = useSetting('toolViewDetailLevelByToolName');

    const model = React.useMemo(() => {
        return buildPermissionPromptModel({ request: props.request, metadata: props.metadata, nowMs: Date.now() });
    }, [props.metadata, props.request]);
    const headerText = model.headerText;

    const onViewTool = React.useCallback(() => {
        router.push(buildPermissionToolCallRoute({ sessionId: props.sessionId, location: props.location }));
    }, [props.location, props.sessionId, router]);
    const canOpenToolRoute = canOpenPermissionToolCallRoute(props.location);

    const previewDetailLevel = React.useMemo(() => {
        const normalizedToolViewDetailLevelDefaultSetting: ToolViewDetailLevelSetting =
            toolViewDetailLevelDefault === 'default' ||
            toolViewDetailLevelDefault === 'title' ||
            toolViewDetailLevelDefault === 'compact' ||
            toolViewDetailLevelDefault === 'summary' ||
            toolViewDetailLevelDefault === 'full'
                ? toolViewDetailLevelDefault
                : 'default';
        const resolvedDetailLevelDefault = resolveToolViewDetailLevelDefaultForChromeMode({
            chromeMode: 'cards',
            setting: normalizedToolViewDetailLevelDefaultSetting,
        });

        return resolveToolViewDetailLevel({
            toolName: headerText.normalizedToolName,
            toolInput: model.tool.input,
            detailLevelDefault: resolvedDetailLevelDefault,
            detailLevelDefaultLocalControl: toolViewDetailLevelDefaultLocalControl,
            detailLevelByToolName: toolViewDetailLevelByToolName as any,
        });
    }, [
        headerText.normalizedToolName,
        model.tool.input,
        toolViewDetailLevelByToolName,
        toolViewDetailLevelDefault,
        toolViewDetailLevelDefaultLocalControl,
    ]);
    const inlineDetailLevel =
        isGenericSubAgentToolName(headerText.normalizedToolName) && previewDetailLevel === 'full'
            ? 'summary'
            : previewDetailLevel;
    const isPreviewVisible = inlineDetailLevel !== 'title' && inlineDetailLevel !== 'compact';

    const effectiveSubtitle = React.useMemo(() => {
        const subtitle = headerText.subtitle;
        if (!subtitle) return null;
        if (!isPreviewVisible) return subtitle;
        const normalizedLower = headerText.normalizedToolName.trim().toLowerCase();
        const isShellTool = normalizedLower === 'bash' || normalizedLower === 'execute' || normalizedLower === 'shell' || normalizedLower === 'codexbash';
        return isShellTool ? null : subtitle;
    }, [headerText.normalizedToolName, headerText.subtitle, isPreviewVisible]);

    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);
    const chrome = props.chrome ?? 'card';

    if (props.disabledReason === 'inactive') {
        return null;
    }

    return (
        <View testID="permission-prompt-card" style={[styles.container, chrome === 'inline' ? styles.containerInline : null]}>
            <View style={styles.header}>
                <View style={styles.icon}>
                    <Ionicons name="lock-closed-outline" size={16} color={theme.colors.warning} />
                </View>
                <View style={styles.headerText}>
                    <Text style={styles.title} numberOfLines={1}>
                        {headerText.title}
                    </Text>
                    {effectiveSubtitle ? (
                        <Text style={styles.subtitle} numberOfLines={2}>
                            {effectiveSubtitle}
                        </Text>
                    ) : null}
                </View>
                {headerActions ? <View style={styles.headerActions}>{headerActions}</View> : null}
                {canOpenToolRoute ? (
                    <Pressable
                        testID="permission-prompt-view-tool"
                        onPress={onViewTool}
                        accessibilityRole="button"
                        accessibilityLabel={t('toolView.open')}
                        style={({ pressed }) => [styles.viewButton, pressed && styles.viewButtonPressed]}
                    >
                        <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                ) : null}
            </View>

            {isPreviewVisible ? (
                <View style={styles.preview}>
                    <ToolInlineBody
                        mode="timeline"
                        tool={model.tool}
                        normalizedToolName={headerText.normalizedToolName}
                        metadata={props.metadata}
                        messages={[]}
                        sessionId={props.sessionId}
                        interaction={{
                            canSendMessages: false,
                            canApprovePermissions: props.canApprovePermissions,
                            permissionDisabledReason: props.disabledReason,
                        }}
                        detailLevel={inlineDetailLevel === 'full' ? 'full' : 'summary'}
                        setHeaderActions={setHeaderActions}
                    />
                </View>
            ) : null}

            <View style={styles.actions}>
                <PermissionFooter
                    embedded={true}
                    permission={{
                        id: props.request.id,
                        status: 'pending',
                        ...(typeof props.request.permissionSuggestions !== 'undefined'
                            ? { suggestions: props.request.permissionSuggestions }
                            : {}),
                    }}
                    sessionId={props.sessionId}
                    toolName={props.request.tool}
                    toolInput={props.request.arguments}
                    metadata={props.metadata || null}
                    canApprovePermissions={props.canApprovePermissions}
                    disabledReason={props.disabledReason}
                />
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        overflow: 'hidden',
    },
    containerInline: {
        borderRadius: 0,
        borderWidth: 0,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 10,
    },
    icon: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        fontSize: 13,
        fontWeight: '700',
        color: theme.colors.text,
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    viewButton: {
        padding: 6,
        borderRadius: 8,
    },
    viewButtonPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    preview: {
        paddingHorizontal: 12,
        paddingBottom: 10,
    },
    actions: {
        paddingHorizontal: 12,
        paddingBottom: 12,
    },
}));
