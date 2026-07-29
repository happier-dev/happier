import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { Text } from '@/components/ui/text/Text';
import { resolvePluginUiIoniconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import type { PluginBrowserActionProjection } from '@/sync/domains/plugins/browser/actions';
import {
    resolvePluginBrowserPolicyDecision,
} from '@/sync/domains/plugins/browser/policy';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { t } from '@/text';

const ACTION_TARGET_SIZE = 44;

const stylesheet = StyleSheet.create((theme) => ({
    detailsPanel: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    detailsAction: {
        minHeight: ACTION_TARGET_SIZE,
        minWidth: ACTION_TARGET_SIZE,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    actionPressed: {
        backgroundColor: theme.colors.surface.inset,
    },
    actionDisabled: {
        opacity: 0.45,
    },
    actionText: {
        color: theme.colors.text.primary,
        fontSize: 14,
    },
    contextTriggerSlot: {
        position: 'absolute',
        right: 12,
        bottom: 44,
        zIndex: 5,
    },
    contextTrigger: {
        width: ACTION_TARGET_SIZE,
        height: ACTION_TARGET_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: ACTION_TARGET_SIZE / 2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
}));

function decisionFor(
    action: PluginBrowserActionProjection,
    policyContext: PluginUiPolicyEvaluationContext,
) {
    return resolvePluginBrowserPolicyDecision(action, policyContext);
}

export function BrowserPluginActionPlacements(props: Readonly<{
    detailsPanelActions: readonly PluginBrowserActionProjection[];
    contextMenuActions: readonly PluginBrowserActionProjection[];
    policyContext: PluginUiPolicyEvaluationContext;
    onAction: (action: PluginBrowserActionProjection) => void;
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const contextAnchorRef = React.useRef<View>(null);
    const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
    const contextMenuItems = React.useMemo<readonly ContextMenuItem[]>(
        () => props.contextMenuActions.map((action) => {
            const decision = decisionFor(action, props.policyContext);
            return {
                id: action.id,
                testID: `${props.testID}-contextMenu-${action.id}`,
                title: action.display.title,
                subtitle: decision.enabled ? undefined : decision.unavailableReason ?? undefined,
                accessibilityLabel: action.display.title,
                icon: (
                    <Ionicons
                        name={resolvePluginUiIoniconName(action.display.iconToken)}
                        size={18}
                        color={theme.colors.text.secondary}
                    />
                ),
                disabled: !decision.enabled,
            };
        }),
        [props.contextMenuActions, props.policyContext, props.testID, theme.colors.text.secondary],
    );

    if (props.detailsPanelActions.length === 0 && props.contextMenuActions.length === 0) {
        return null;
    }

    return (
        <>
            {props.detailsPanelActions.length > 0 ? (
                <View testID={`${props.testID}-detailsPanel`} style={stylesheet.detailsPanel}>
                    {props.detailsPanelActions.map((action) => {
                        const decision = decisionFor(action, props.policyContext);
                        return (
                            <Pressable
                                key={action.id}
                                testID={`${props.testID}-detailsPanel-${action.id}`}
                                accessibilityRole="button"
                                accessibilityLabel={action.display.title}
                                accessibilityHint={!decision.enabled && decision.unavailableReason
                                    ? decision.unavailableReason
                                    : undefined}
                                accessibilityState={{ disabled: !decision.enabled }}
                                disabled={!decision.enabled}
                                onPress={() => props.onAction(action)}
                                style={({ pressed }) => [
                                    stylesheet.detailsAction,
                                    pressed ? stylesheet.actionPressed : null,
                                    !decision.enabled ? stylesheet.actionDisabled : null,
                                ]}
                            >
                                <Ionicons
                                    name={resolvePluginUiIoniconName(action.display.iconToken)}
                                    size={18}
                                    color={theme.colors.text.secondary}
                                />
                                <Text style={stylesheet.actionText}>{action.display.title}</Text>
                            </Pressable>
                        );
                    })}
                </View>
            ) : null}
            {props.contextMenuActions.length > 0 ? (
                <View style={stylesheet.contextTriggerSlot}>
                    <Pressable
                        ref={contextAnchorRef}
                        testID={`${props.testID}-contextMenu-trigger`}
                        accessibilityRole="button"
                        accessibilityLabel={t('browserShell.overflow.open')}
                        accessibilityState={{ expanded: contextMenuOpen }}
                        onPress={() => setContextMenuOpen((open) => !open)}
                        style={stylesheet.contextTrigger}
                    >
                        <Ionicons
                            name="ellipsis-horizontal"
                            size={18}
                            color={theme.colors.text.primary}
                        />
                    </Pressable>
                    <ContextMenu
                        anchorRef={contextAnchorRef}
                        open={contextMenuOpen}
                        onOpenChange={setContextMenuOpen}
                        items={contextMenuItems}
                        onSelect={(actionId) => {
                            const action = props.contextMenuActions.find((candidate) => candidate.id === actionId);
                            if (action && decisionFor(action, props.policyContext).enabled) {
                                props.onAction(action);
                            }
                        }}
                        closeOnSelect={true}
                        placement="auto"
                        variant="slim"
                        showCategoryTitles={false}
                        maxWidthCap={320}
                    />
                </View>
            ) : null}
        </>
    );
}
