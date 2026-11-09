import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { Metadata } from '@happier-dev/session-core/state';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { PermissionFooter } from '@/components/tools/shell/permissions/PermissionFooter';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { t } from '@/text';
import { usePermissionPromptModel } from '@/components/tools/shell/permissions/presentation/usePermissionPromptModel';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ActionApprovalFieldsCard } from '@/components/approvals/ActionApprovalFieldsCard';
import { McpToolDecisionBadges } from '@/components/settings/mcpServers/tools/McpToolDecisionBadges';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import { ToolInlineBody } from '@/components/tools/shell/views/ToolInlineBody';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    type ToolViewDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';
import { Icon } from '@/components/ui/icons/Icon';
import type { PromptResponseOrigin } from './executionRunPromptResponseTarget';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

const PROMPT_CARD_ICON_SIZE = 18;

export const PermissionPromptCard = React.memo(function PermissionPromptCard(props: PromptResponseOrigin & {
    request: PendingPermissionRequest;
    location: PermissionToolCallMessageLocation | null;
    serverId?: string;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    chrome?: 'card' | 'inline';
}) {
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const viewButtonHitArea = useHappierHitArea({ restingStyle: () => null });

    const toolViewDetailLevelDefault = useSetting('toolViewDetailLevelDefault');
    const toolViewDetailLevelDefaultLocalControl = useSetting('toolViewDetailLevelDefaultLocalControl');
    const toolViewDetailLevelByToolName = useSetting('toolViewDetailLevelByToolName');

    // An MCP tool named by the catalog reads as that tool, with its server's default (P8 U8.5, lab xa A).
    const scopeResolution = useServerCredentialAccountScopeResolution(props.serverId ?? transcriptSource.serverId ?? undefined);
    const [nowMs] = React.useState(() => Date.now());
    const { model } = usePermissionPromptModel({ request: props.request, metadata: props.metadata, nowMs,
        scope: scopeResolution.kind === 'bound' ? scopeResolution.scope : null });
    const headerText = model.headerText;
    const mcp = model.mcp ?? null;
    const mcpFacts = React.useMemo(() => mcp ? { unrepresentable: null, rows: mcp.argumentFacts.map(fact => ({
        kind: 'value' as const, path: fact.key, title: fact.label, value: fact.value })) } : null, [mcp]);
    const mcpEffect = mcp?.badges.includes('destructive') ? 'destructive' as const : mcp?.badges.includes('read_only') ? 'read' as const : null;
    const openToolSettings = React.useCallback(() => {
        if (!mcp) return;
        navigateWithBlurOnWeb(() => { transcriptSource.navigate?.(mcpServerRoute(mcp.serverId)); });
    }, [mcp, transcriptSource]);

    const onViewTool = React.useCallback(() => {
        if (props.sessionId === undefined) return;
        const sessionId = props.sessionId;
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(buildPermissionToolCallRoute({ sessionId, serverId: props.serverId, location: props.location }));
        });
    }, [props.location, props.sessionId, props.serverId, transcriptSource]);
    // A tool-call route is a Session transcript location; an Execution Run has none.
    const canOpenToolRoute = transcriptSource.navigate !== null && props.sessionId !== undefined && canOpenPermissionToolCallRoute(props.location);

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

    const origin = props.request.nativeChoices?.origin;
    const fromSubagent = origin !== undefined && (origin.subagentLabel !== undefined || origin.subagentId !== undefined || origin.sessionId !== props.sessionId);
    const effectiveSubtitle = React.useMemo(() => {
        const subtitle = (() => {
            if (mcp) return mcp.serverTitle;
            const base = headerText.subtitle;
            if (!base) return null;
            if (!isPreviewVisible) return base;
            const normalizedLower = headerText.normalizedToolName.trim().toLowerCase();
            const isShellTool = normalizedLower === 'bash' || normalizedLower === 'execute' || normalizedLower === 'shell' || normalizedLower === 'codexbash';
            // The question card's own body already leads with the question and its header.
            const isQuestionTool = normalizedLower === 'askuserquestion';
            return isShellTool || isQuestionTool ? null : base;
        })();
        // A subagent's request names the subagent first (lab mb B `mbAppr:child`).
        if (!fromSubagent) return subtitle;
        return t('capabilities.session.toolAsk.fromSubagent', { subtitle: subtitle ?? '', subagent: origin?.subagentLabel }).replace(/\s*·\s*$/, '');
    }, [fromSubagent, origin?.subagentLabel, mcp?.serverTitle, headerText.normalizedToolName, headerText.subtitle, isPreviewVisible]);
    // The viewer's availability is the caller-specific projection on the pending request, never re-decided here.
    const nativeChoiceAvailability = props.request.nativeChoiceAvailability;
    const permissionOwnerLabel = props.request.permissionOwnerLabel;
    const footerPermission = React.useMemo(() => nativeChoiceAvailability || permissionOwnerLabel
        ? { ...model.tool.permission, ...(nativeChoiceAvailability ? { nativeChoiceAvailability } : {}),
            ...(permissionOwnerLabel ? { permissionOwnerLabel } : {}) } : model.tool.permission,
    [model.tool.permission, nativeChoiceAvailability, permissionOwnerLabel]);

    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);
    const chrome = props.chrome ?? 'card';

    if (props.disabledReason === 'inactive') {
        return null;
    }

    return (
        <ApprovalPromptChrome
            testID="permission-prompt-card"
            title={mcp ? mcp.title : headerText.title}
            subtitle={effectiveSubtitle}
            titleNumberOfLines={1}
            subtitleNumberOfLines={2}
            icon="lock"
            chrome={chrome}
            bodyBottomInset={0}
            headerAccessory={(
                <>
                    {mcpEffect ? <McpToolDecisionBadges effect={mcpEffect} testID="permission-prompt-mcp-badge" /> : null}
                    {headerActions && !mcp ? <View style={styles.headerActions}>{headerActions}</View> : null}
                    {canOpenToolRoute ? (
                        <Pressable
                            testID="permission-prompt-view-tool"
                            onPress={onViewTool}
                            hitSlop={viewButtonHitArea.hitSlop}
                            onLayout={viewButtonHitArea.onLayout}
                            accessibilityRole="button"
                            accessibilityLabel={t('toolView.open')}
                            style={({ pressed }) => [
                                styles.viewButton,
                                pressed && styles.viewButtonPressed,
                            ]}
                        >
                            {viewButtonHitArea.frame}
                            <Icon name="arrow-square-out" size={PROMPT_CARD_ICON_SIZE} color={theme.colors.text.secondary} />
                        </Pressable>
                    ) : null}
                </>
            )}
            footer={(
                <PermissionFooter
                    {...(props.executionRun === undefined
                        ? { sessionId: props.sessionId }
                        : { executionRun: props.executionRun })}
                    embedded={true}
                    alignFirstButtonToStart={true}
                    permission={footerPermission}
                    serverId={props.serverId}
                    toolName={props.request.tool}
                    toolInput={props.request.arguments}
                    metadata={props.metadata || null}
                    canApprovePermissions={props.canApprovePermissions}
                    disabledReason={props.disabledReason}
                />
            )}
        >
            {mcp && mcpFacts ? (
                <View style={styles.mcpBody}>
                    {mcpFacts.rows.length > 0 ? <ActionApprovalFieldsCard presentation={mcpFacts} serverId={props.serverId ?? transcriptSource.serverId ?? null} /> : null}
                    {mcp.serverDefault ? (
                        <View style={styles.mcpDefault}>
                            <Icon name="shield-check" size={14} color={theme.colors.text.secondary} />
                            <Text variant="meta" style={styles.mcpDefaultText} numberOfLines={1}>
                                {`${mcp.serverTitle}: ${t(mcp.serverDefault === 'ask' ? 'capabilities.mcp.tools.defaultAsk'
                                    : mcp.serverDefault === 'allow_read_only' ? 'capabilities.mcp.tools.defaultReadOnly' : 'capabilities.mcp.tools.defaultAll')}`}
                            </Text>
                            {transcriptSource.navigate ? <TextLinkButton testID="permission-prompt-tool-settings" size="meta" tone="strong"
                                label={t('capabilities.session.toolAsk.toolSettings')} onPress={openToolSettings} /> : null}
                        </View>
                    ) : null}
                </View>
            ) : isPreviewVisible ? (
                <ToolInlineBody
                    mode="timeline"
                    tool={model.tool}
                    normalizedToolName={headerText.normalizedToolName}
                    metadata={props.metadata}
                    messages={[]}
                    sessionId={props.sessionId}
                    serverId={props.serverId}
                    interaction={{
                        canSendMessages: false,
                        canApprovePermissions: props.canApprovePermissions,
                        permissionDisabledReason: props.disabledReason,
                    }}
                    detailLevel={inlineDetailLevel === 'full' ? 'full' : 'summary'}
                    sectionSpacing="compact"
                    setHeaderActions={setHeaderActions}
                />
            ) : null}
        </ApprovalPromptChrome>
    );
});

const styles = StyleSheet.create((theme) => ({
    viewButton: {
        padding: theme.space.s6,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    viewButtonPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    mcpBody: {
        gap: theme.space.s8,
    },
    mcpDefault: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    mcpDefaultText: {
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
}));
