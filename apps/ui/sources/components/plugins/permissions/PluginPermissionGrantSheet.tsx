import React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import {
    pluginPermissionGrantScopeLabel,
    type PluginPermissionPendingGrantRequest,
} from '@/sync/domains/plugins/permissions/types';

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
    testID?: string;
}>;

function resolvePluginName(request: PluginPermissionPendingGrantRequest): string {
    const pluginName = typeof request.pluginName === 'string' ? request.pluginName.trim() : '';
    return pluginName || request.pluginId;
}

function describeScope(request: PluginPermissionPendingGrantRequest): string | null {
    return pluginPermissionGrantScopeLabel(request.targetScope);
}

export function PluginPermissionGrantSheet(props: PluginPermissionGrantSheetProps) {
    const { theme } = useUnistyles();
    const pluginName = resolvePluginName(props.pendingRequest);
    const scope = describeScope(props.pendingRequest);
    const reason = typeof props.pendingRequest.reason === 'string'
        ? props.pendingRequest.reason.trim()
        : '';

    const grant = React.useCallback(() => {
        props.onGrant({ requestId: props.pendingRequest.id });
    }, [props]);
    const dismiss = React.useCallback(() => {
        props.onDismiss({ requestId: props.pendingRequest.id });
    }, [props]);

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
            <View style={{ gap: 4 }}>
                <Text style={{ color: theme.colors.text.primary }}>
                    {pluginName}
                </Text>
                <Text style={{ color: theme.colors.text.secondary }}>
                    {props.pendingRequest.pluginId}
                </Text>
                <Text style={{ color: theme.colors.text.secondary }}>
                    {props.pendingRequest.capability}
                </Text>
                {scope ? (
                    <Text style={{ color: theme.colors.text.secondary }}>
                        {scope}
                    </Text>
                ) : null}
                {reason ? (
                    <Text style={{ color: theme.colors.text.secondary }}>
                        {reason}
                    </Text>
                ) : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Pressable
                    onPress={grant}
                    testID={props.testID ? `${props.testID}-grant` : undefined}
                    accessibilityRole="button"
                    style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        backgroundColor: theme.colors.button.primary.background,
                    }}
                >
                    <Text style={{ color: theme.colors.button.primary.tint }}>
                        {props.labels.grant}
                    </Text>
                </Pressable>
                <Pressable
                    onPress={dismiss}
                    testID={props.testID ? `${props.testID}-dismiss` : undefined}
                    accessibilityRole="button"
                    style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
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
