import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { buildToolHeaderModel } from '@/components/tools/shell/presentation/buildToolHeaderModel';
import { deriveToolTimelineDensity } from '@/components/tools/normalization/policy/deriveToolTimelineDensity';
import { useSetting } from '@/sync/domains/state/storage';
import { ToolTimelineRowHeader } from '@/components/tools/shell/views/timeline/ToolTimelineRowHeader';
import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    type ToolViewDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';

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
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        });
    }, [props.metadata, props.toolMessage.tool, theme.colors.text, theme.colors.textSecondary]);

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
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        }).icon;
    }, [iconSize, model.icon, props.metadata, props.toolMessage.tool, theme.colors.text, theme.colors.textSecondary]);

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
        />
    );
});
