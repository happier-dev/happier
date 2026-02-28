import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import { useSetting } from '@/sync/domains/state/storage';
import { ToolInlineBody } from '@/components/tools/shell/views/ToolInlineBody';
import { TranscriptCollapsible } from '@/components/sessions/transcript/motion/TranscriptCollapsible';
import { buildToolHeaderModel } from '@/components/tools/shell/presentation/buildToolHeaderModel';
import { deriveToolTimelineDensity } from '@/components/tools/normalization/policy/deriveToolTimelineDensity';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    resolveToolViewExpandedDetailLevelDefaultForChromeMode,
    type ToolViewDetailLevelSetting,
    type ToolViewExpandedDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import { ToolTimelineRowHeader } from '@/components/tools/shell/views/timeline/ToolTimelineRowHeader';

export const ToolTimelineRow = React.memo((props: {
    tool: ToolCall;
    metadata: Metadata | null;
    messages?: Message[];
    sessionId?: string;
    messageId?: string;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    };
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();

    const headerModel = React.useMemo(() => {
        return buildToolHeaderModel({
            tool: props.tool,
            metadata: props.metadata,
            iconSize: 18,
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        });
    }, [props.metadata, props.tool, theme.colors.text, theme.colors.textSecondary]);
    const toolForRendering = headerModel.toolForRendering;

    const toolViewDetailLevelDefault = useSetting('toolViewDetailLevelDefault');
    const toolViewDetailLevelDefaultLocalControl = useSetting('toolViewDetailLevelDefaultLocalControl');
    const toolViewDetailLevelByToolName = useSetting('toolViewDetailLevelByToolName');
    const toolViewExpandedDetailLevelDefault = useSetting('toolViewExpandedDetailLevelDefault');
    const toolViewExpandedDetailLevelByToolName = useSetting('toolViewExpandedDetailLevelByToolName');
    const toolViewTimelineFeedDefaultExpanded = useSetting('toolViewTimelineFeedDefaultExpanded');
    const toolViewTimelineFeedTapAction = useSetting('toolViewTimelineFeedTapAction');

    const initialIsExpandedRef = React.useRef<boolean>(toolViewTimelineFeedDefaultExpanded === true);
    const [isExpanded, setIsExpanded] = React.useState<boolean>(initialIsExpandedRef.current);
    const [expandedByUser, setExpandedByUser] = React.useState<boolean>(false);

    const handleOpen = React.useCallback(() => {
        if (props.sessionId && props.messageId) {
            router.push(`/session/${props.sessionId}/message/${props.messageId}`);
        }
    }, [props.messageId, props.sessionId, router]);

    const canOpen = !!(props.sessionId && props.messageId);
    const primaryTapAction: 'expand' | 'open' =
        toolViewTimelineFeedTapAction === 'open' && canOpen ? 'open' : 'expand';

    const handleToggleExpand = React.useCallback(() => {
        const next = !isExpanded;
        setIsExpanded(next);
        // Only show the persistent "expanded" chevron when the tool started collapsed and the user expanded it.
        if (initialIsExpandedRef.current === false && next === true) {
            setExpandedByUser(true);
        } else {
            setExpandedByUser(false);
        }
    }, [isExpanded]);

    const onPress = primaryTapAction === 'open' ? handleOpen : handleToggleExpand;

    const normalizedToolName = headerModel.normalizedToolName;
    const title = headerModel.title;
    const subtitle = headerModel.subtitle;
    const statusText = headerModel.statusText;
    const shouldHideBodyPermanently = headerModel.shouldHideBodyPermanently;
    const shouldCollapseUnknownToolByDefault = headerModel.shouldCollapseUnknownToolByDefault;

    const normalizedToolViewDetailLevelDefaultSetting: ToolViewDetailLevelSetting =
        toolViewDetailLevelDefault === 'default' ||
        toolViewDetailLevelDefault === 'title' ||
        toolViewDetailLevelDefault === 'compact' ||
        toolViewDetailLevelDefault === 'summary' ||
        toolViewDetailLevelDefault === 'full'
            ? toolViewDetailLevelDefault
            : 'default';

    const normalizedToolViewExpandedDetailLevelDefaultSetting: ToolViewExpandedDetailLevelSetting =
        toolViewExpandedDetailLevelDefault === 'default' ||
        toolViewExpandedDetailLevelDefault === 'summary' ||
        toolViewExpandedDetailLevelDefault === 'full'
            ? toolViewExpandedDetailLevelDefault
            : 'default';

    const resolvedDetailLevelDefault = resolveToolViewDetailLevelDefaultForChromeMode({
        chromeMode: 'activity_feed',
        setting: normalizedToolViewDetailLevelDefaultSetting,
    });
    const resolvedExpandedDetailLevelDefault = resolveToolViewExpandedDetailLevelDefaultForChromeMode({
        chromeMode: 'activity_feed',
        setting: normalizedToolViewExpandedDetailLevelDefaultSetting,
    });

    const collapsedDetailLevel =
        toolForRendering.name.startsWith('mcp__') || shouldCollapseUnknownToolByDefault
            ? 'title'
            : resolveToolViewDetailLevel({
                  toolName: normalizedToolName,
                  toolInput: toolForRendering.input,
                  detailLevelDefault: resolvedDetailLevelDefault,
                  detailLevelDefaultLocalControl: toolViewDetailLevelDefaultLocalControl,
                  detailLevelByToolName: toolViewDetailLevelByToolName as any,
              });

    const expandedDetailLevel: 'summary' | 'full' =
        (toolViewExpandedDetailLevelByToolName as any)?.[normalizedToolName] ?? resolvedExpandedDetailLevelDefault;

    const effectiveDetailLevel = isExpanded ? expandedDetailLevel : collapsedDetailLevel;
    const inlineDetailLevel =
        normalizedToolName === 'Task' && effectiveDetailLevel === 'full'
            ? 'summary'
            : effectiveDetailLevel;

    // Keep the header density stable across expand/collapse toggles so tool titles don't "jump" in size.
    const headerDensityDetailLevel = initialIsExpandedRef.current ? expandedDetailLevel : collapsedDetailLevel;
    const { density, iconSize } = deriveToolTimelineDensity(headerDensityDetailLevel);
    const icon = React.useMemo(() => {
        if (iconSize === 18) return headerModel.icon;
        return buildToolHeaderModel({
            tool: props.tool,
            metadata: props.metadata,
            iconSize,
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        }).icon;
    }, [headerModel.icon, iconSize, props.metadata, props.tool, theme.colors.text, theme.colors.textSecondary]);

    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);

    const isBodyVisible = inlineDetailLevel !== 'title' && inlineDetailLevel !== 'compact';
    const bodyDetailLevel: 'summary' | 'full' = inlineDetailLevel === 'full' ? 'full' : 'summary';
    const lastVisibleBodyDetailLevelRef = React.useRef<'summary' | 'full'>(bodyDetailLevel);
    if (isBodyVisible) {
        lastVisibleBodyDetailLevelRef.current = bodyDetailLevel;
    }
    const renderBodyDetailLevel = isBodyVisible ? bodyDetailLevel : lastVisibleBodyDetailLevelRef.current;

    const collapsibleId =
        props.messageId ??
        toolForRendering.id ??
        `${props.sessionId ?? 'no-session'}:${normalizedToolName}:${toolForRendering.createdAt}`;

    const headerSubtitle = effectiveDetailLevel === 'title' ? null : subtitle;
    const headerStatusText = effectiveDetailLevel === 'title' ? null : statusText;
    const disclosure =
        primaryTapAction === 'expand'
            ? expandedByUser && isExpanded
                ? ({ behavior: 'persistent', state: 'expanded' } as const)
                : !isExpanded
                    ? ({ behavior: 'hover', state: 'collapsed' } as const)
                    : null
            : null;

    return (
        <View style={styles.container}>
            <ToolTimelineRowHeader
                testID="tool-timeline-row"
                density={density}
                icon={icon}
                title={title}
                subtitle={headerSubtitle}
                statusText={headerStatusText}
                onPress={onPress}
                canOpen={canOpen}
                onOpen={handleOpen}
                rightElement={headerActions}
                disclosure={disclosure}
            />

            {shouldHideBodyPermanently ? null : (
                <TranscriptCollapsible id={collapsibleId} createdAt={toolForRendering.createdAt} expanded={isBodyVisible}>
                    <View testID="tool-timeline-body" style={styles.body}>
                        <ToolInlineBody
                            mode="timeline"
                            tool={toolForRendering}
                            normalizedToolName={normalizedToolName}
                            metadata={props.metadata}
                            messages={props.messages ?? []}
                            sessionId={props.sessionId}
                            interaction={props.interaction}
                            detailLevel={renderBodyDetailLevel}
                            setHeaderActions={setHeaderActions}
                        />
                    </View>
                </TranscriptCollapsible>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 0,
    },
    body: {
        paddingLeft: 38,
        paddingRight: 10,
        paddingBottom: 12,
        paddingTop: 2,
    },
}));
