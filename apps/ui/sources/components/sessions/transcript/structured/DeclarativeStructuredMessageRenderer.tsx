import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import type { DaemonPluginStructuredMessageResolveResponse } from '@happier-dev/protocol';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';

type ResolvedMessage = Extract<DaemonPluginStructuredMessageResolveResponse, { ok: true }>;
type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function localized(value: unknown): string {
    if (typeof value === 'string') return value;
    const valueRecord = record(value);
    return typeof valueRecord?.fallback === 'string' ? valueRecord.fallback : '';
}

function renderNode(
    nodeValue: unknown,
    onAction?: (action: Readonly<{ qualifiedId: string; input?: unknown }>) => void,
    actionPending = false,
): React.ReactNode {
    const node = record(nodeValue);
    if (!node || typeof node.kind !== 'string' || typeof node.path !== 'string') return null;
    if (node.kind === 'stack' || node.kind === 'group') {
        const children = Array.isArray(node.children) ? node.children : [];
        return (
            <View key={node.path} testID={`plugin-declarative-${node.kind}`}>
                {node.kind === 'group' && localized(node.title) ? <Text>{localized(node.title)}</Text> : null}
                {localized(node.description) ? <Text>{localized(node.description)}</Text> : null}
                {children.map((child) => renderNode(child, onAction, actionPending))}
            </View>
        );
    }
    if (node.kind === 'action') {
        if (onAction === undefined) return null;
        const action = record(node.action);
        const qualifiedId = typeof action?.qualifiedId === 'string' ? action.qualifiedId : '';
        const enabled = node.enabled === true
            && qualifiedId.length > 0
            && !actionPending;
        const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
        return (
            <Pressable
                key={node.path}
                testID={`plugin-declarative-action:${qualifiedId}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: !enabled, busy: actionPending }}
                disabled={!enabled}
                onPress={enabled ? () => onAction({
                    qualifiedId,
                    ...(node.input === undefined ? {} : { input: node.input }),
                }) : undefined}
                style={{
                    minWidth: minimumInteractiveTargetSize,
                    minHeight: minimumInteractiveTargetSize,
                    justifyContent: 'center',
                }}
            >
                <Text>{localized(node.label)}</Text>
            </Pressable>
        );
    }
    if (node.kind === 'field') {
        return <Text key={node.path}>{localized(node.label)}</Text>;
    }
    if (node.kind === 'status') {
        return (
            <View key={node.path} testID="plugin-declarative-status">
                <Text>{localized(node.label)}</Text>
                <Text>{localized(node.value)}</Text>
            </View>
        );
    }
    if (node.kind === 'text' || node.kind === 'markdown') {
        return <Text key={node.path}>{localized(node.text)}</Text>;
    }
    return null;
}

export function DeclarativeStructuredMessageRenderer(props: Readonly<{
    resolution: ResolvedMessage;
    onAction?: (action: Readonly<{ qualifiedId: string; input?: unknown }>) => void;
    actionPending?: boolean;
}>): React.ReactElement {
    return (
        <View testID="plugin-structured-message-declarative">
            {renderNode(props.resolution.renderer.root, props.onAction, props.actionPending)}
        </View>
    );
}
