import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ToolCallMessage } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';

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
import { ToolOutcomeStatus } from '@/components/tools/shell/presentation/ToolOutcomeStatus';
import { resolveToolActionFailure } from '@/components/tools/shell/presentation/resolveToolActionFailure';
import { t } from '@/text';
import { resolveToolPermissionTerminalErrorMessage } from '@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage';
import { formatToolPermissionDecisionLabel } from '@/components/approvals/approvalStatusLabel';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { readTranscriptProjectCommandCall } from '@/components/sessions/transcript/references/transcriptProjectCommandReference';
import { ProjectCommandToolTimelineRowHeader } from './ProjectCommandToolTimelineRowHeader';

export const ToolTimelinePreviewRow = React.memo(function ToolTimelinePreviewRow(props: {
    toolMessage: ToolCallMessage;
    metadata: Metadata | null;
    onPress?: (() => void) | null;
}) {
    const { theme } = useUnistyles();
    const historicalAgentId = useHistoricalTranscriptAgentId(props.toolMessage.seq ?? null);

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
            historicalAgentId,
        });
    }, [historicalAgentId, props.metadata, props.toolMessage.tool, theme.colors.text.primary, theme.colors.text.secondary]);

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

    const statusKind = resolveToolStatusIndicatorKind(model.toolForRendering);
    const actionFailure = statusKind === 'error' ? resolveToolActionFailure(model.toolForRendering) : null;
    const isRefusal = actionFailure?.outcome === 'refused'
        || formatToolPermissionDecisionLabel(model.toolForRendering.permission) !== null;
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
            historicalAgentId,
        }).icon;
    }, [historicalAgentId, iconSize, model.icon, props.metadata, props.toolMessage.tool, theme.colors.text.primary, theme.colors.text.secondary]);

    // Optional: a Run page renders tool previews without a transcript source.
    const transcriptSource = useOptionalSessionTranscriptSource();
    const projectCommandCall = React.useMemo(
        () => readTranscriptProjectCommandCall(model.toolForRendering),
        [model.toolForRendering],
    );
    const terminalStatusSummary =
        statusKind === 'error'
            ? (resolveToolErrorSummary(model.toolForRendering) ?? t('common.error'))
            : statusKind === 'permission_blocked'
                ? (
                    resolveToolPermissionTerminalErrorMessage({
                        tool: model.toolForRendering,
                        metadata: props.metadata,
                        historicalAgentId,
                    }) ?? t('errors.permissionDenied')
                )
                : null;
    const terminalStatus = terminalStatusSummary ? (
        <ToolOutcomeStatus
            testID={statusKind === 'permission_blocked'
                ? 'tool-timeline-preview-row-permission-blocked'
                : 'tool-timeline-preview-row-error'}
            label={terminalStatusSummary}
            glyph={statusKind === 'permission_blocked' || isRefusal ? 'minus-circle' : 'warning-circle'}
            tone={isRefusal ? 'quiet' : 'danger'}
        />
    ) : null;

    const header: React.ComponentProps<typeof ToolTimelineRowHeader> = {
        density,
        icon,
        title: model.title,
        subtitle: headerSubtitle,
        statusText: headerStatusText,
        causeText: actionFailure?.summary ?? null,
        onPress: props.onPress ?? null,
        canOpen: false,
        onOpen: null,
        terminalStatus,
    };
    // The collapsed group's last lines read an agent's Project command the same way its full rows do.
    return projectCommandCall ? (
        <ProjectCommandToolTimelineRowHeader
            header={header}
            call={projectCommandCall}
            tool={model.toolForRendering}
            serverId={transcriptSource?.serverId ?? null}
        />
    ) : <ToolTimelineRowHeader {...header} />;
});
