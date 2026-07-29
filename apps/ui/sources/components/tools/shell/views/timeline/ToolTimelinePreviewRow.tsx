import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { buildToolHeaderModel } from '@/components/tools/shell/presentation/buildToolHeaderModel';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { deriveToolTimelineDensity } from '@/components/tools/normalization/policy/deriveToolTimelineDensity';
import { useSetting } from '@/sync/domains/state/storage';
import { ToolTimelineRowHeader } from '@/components/tools/shell/views/timeline/ToolTimelineRowHeader';
import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    type ToolViewDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import { resolveToolErrorSummary } from '@/components/tools/shell/presentation/resolveToolErrorSummary';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolveToolPermissionTerminalErrorMessage } from '@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage';

export const ToolTimelinePreviewRow = React.memo(function ToolTimelinePreviewRow(props: {
    toolMessage: ToolCallMessage;
    metadata: Metadata | null;
    onPress?: (() => void) | null;
}) {
    const { theme } = useUnistyles();

    const toolViewDetailLevelDefault = useSetting('toolViewDetailLevelDefault');
    const toolViewDetailLevelDefaultLocalControl = useSetting('toolViewDetailLevelDefaultLocalControl');
    const toolViewDetailLevelByToolName = useSetting('toolViewDetailLevelByToolName');

    const model = React.useMemo(() => {
        return buildToolHeaderModel({
            tool: props.toolMessage.tool,
            metadata: props.metadata,
            iconSize: 18,
            iconColorPrimary: theme.colors.text.primary,
            iconColorSecondary: theme.colors.text.secondary,
        });
    }, [props.metadata, props.toolMessage.tool, theme.colors.text.primary, theme.colors.text.secondary]);

    const collapsedDetailLevel = React.useMemo(() => {
        const normalizedToolViewDetailLevelDefaultSetting: ToolViewDetailLevelSetting =
            toolViewDetailLevelDefault === 'default' ||
            toolViewDetailLevelDefault === 'title' ||
            toolViewDetailLevelDefault === 'compact' ||
            toolViewDetailLevelDefault === 'summary' ||
            toolViewDetailLevelDefault === 'full'
                ? toolViewDetailLevelDefault
                : 'default';
        const resolvedDetailLevelDefault = resolveToolViewDetailLevelDefaultForChromeMode({
            chromeMode: 'activity_feed',
            setting: normalizedToolViewDetailLevelDefaultSetting,
        });

        const toolForRendering = model.toolForRendering;
        if (toolForRendering.name.startsWith('mcp__') || model.shouldCollapseUnknownToolByDefault) {
            return 'title';
        }

        return resolveToolViewDetailLevel({
            toolName: model.normalizedToolName,
            toolInput: toolForRendering.input,
            detailLevelDefault: resolvedDetailLevelDefault,
            detailLevelDefaultLocalControl: toolViewDetailLevelDefaultLocalControl,
            detailLevelByToolName: toolViewDetailLevelByToolName as any,
        });
    }, [
        model.normalizedToolName,
        model.shouldCollapseUnknownToolByDefault,
        model.toolForRendering,
        toolViewDetailLevelByToolName,
        toolViewDetailLevelDefault,
        toolViewDetailLevelDefaultLocalControl,
    ]);

    const headerSubtitle = collapsedDetailLevel === 'title' ? null : model.subtitle;
    const headerStatusText = collapsedDetailLevel === 'title' ? null : model.statusText;
    const { density, iconSize } = deriveToolTimelineDensity(collapsedDetailLevel);
    const icon = React.useMemo(() => {
        if (iconSize === 18) return model.icon;
        return buildToolHeaderModel({
            tool: props.toolMessage.tool,
            metadata: props.metadata,
            iconSize,
            iconColorPrimary: theme.colors.text.primary,
            iconColorSecondary: theme.colors.text.secondary,
        }).icon;
    }, [iconSize, model.icon, props.metadata, props.toolMessage.tool, theme.colors.text.primary, theme.colors.text.secondary]);

    const statusKind = resolveToolStatusIndicatorKind(model.toolForRendering);
    const terminalStatusSummary =
        statusKind === 'error'
            ? (resolveToolErrorSummary(model.toolForRendering) ?? t('common.error'))
            : statusKind === 'permission_blocked'
                ? (
                    resolveToolPermissionTerminalErrorMessage({
                        tool: model.toolForRendering,
                        metadata: props.metadata,
                    }) ?? t('errors.permissionDenied')
                )
                : null;
    const rightElement =
        terminalStatusSummary ? (
            <View
                testID={statusKind === 'permission_blocked'
                    ? 'tool-timeline-preview-row-permission-blocked'
                    : 'tool-timeline-preview-row-error'}
                accessible={true}
                accessibilityLabel={terminalStatusSummary}
                style={styles.terminalStatusContainer}
            >
                <Ionicons
                    name={statusKind === 'permission_blocked' ? 'remove-circle-outline' : 'alert-circle'}
                    size={16}
                    color={theme.colors.state.danger.foreground}
                />
                <Text style={styles.terminalStatusText} numberOfLines={1}>
                    {terminalStatusSummary}
                </Text>
            </View>
        ) : null;

    return (
        <ToolTimelineRowHeader
            density={density}
            icon={icon}
            title={model.title}
            subtitle={headerSubtitle}
            statusText={headerStatusText}
            onPress={props.onPress ?? null}
            canOpen={false}
            onOpen={null}
            rightElement={rightElement}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    terminalStatusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: 220,
    },
    terminalStatusText: {
        fontSize: 12,
        color: theme.colors.state.danger.foreground,
        fontWeight: '600',
    },
}));
