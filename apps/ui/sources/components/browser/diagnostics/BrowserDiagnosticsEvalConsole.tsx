import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type {
    BrowserDiagnosticsObjectPropertyV1,
    BrowserDiagnosticsRemoteObjectV1,
} from '@happier-dev/protocol';
import { t } from '@/text';

/**
 * DEV-3 / DEV-4 (root cause A — eval REPL + object inspector built but never consumed).
 *
 * The diagnostics runtime already exposes `requestEval` / `requestGetProperties` and receives the
 * `BrowserDiagnosticsEvalResultV1` / get-properties results, but historically discarded them
 * (`useBrowserDiagnosticsRuntime.ts:338`). This surface is the local-owner consumer: an expression
 * REPL whose results are STORED and rendered, with an expandable remote-object inspector (eruda
 * `objManager` parity). Eval stays owner-only/default-off; the agent surface remains approval-floored
 * by LANE-CONSENT — this component is only mounted while interaction is `enabled`.
 */

const MAX_OBJECT_INSPECTOR_DEPTH = 6;

export type BrowserDiagnosticsEvalConsoleEntry = Readonly<{
    evalRequestId: string;
    expression: string;
    objectGroupId: string;
    status: 'pending' | 'completed' | 'failed' | 'timedOut' | 'blocked' | 'collectorDegraded';
    result?: BrowserDiagnosticsRemoteObjectV1;
    errorCode?: string;
}>;

export type BrowserDiagnosticsObjectInspectorEntry = Readonly<{
    status: 'idle' | 'loading' | 'loaded' | 'failed';
    properties: readonly BrowserDiagnosticsObjectPropertyV1[];
    errorCode?: string;
}>;

export type BrowserDiagnosticsEvalConsoleControls = Readonly<{
    entries: readonly BrowserDiagnosticsEvalConsoleEntry[];
    objectProperties: Readonly<Record<string, BrowserDiagnosticsObjectInspectorEntry>>;
    onSubmitExpression: (expression: string) => boolean;
    onExpandObject: (objectId: string, objectGroupId: string) => boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: 8,
    },
    title: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    input: {
        ...Typography.keyHint(),
        flex: 1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 6,
        color: theme.colors.text.primary,
    },
    submit: {
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    submitText: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    entry: {
        gap: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    expression: {
        ...Typography.keyHint(),
        color: theme.colors.text.primary,
    },
    meta: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    error: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        // Q2 measured the theme's semantic FOREGROUNDS as text at 2.20–3.55:1 in light theme —
        // they are fill colours, not text colours. The words carry their own meaning here, so
        // they take `text.primary`; the hue stays on the border/glyph beside them, where it is a
        // redundant cue rather than the only one.
        color: theme.colors.text.primary,
    },
    empty: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    node: {
        gap: 2,
    },
    nodeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    nodeName: {
        ...Typography.keyHint(),
        color: theme.colors.text.primary,
    },
    nodeValue: {
        ...Typography.keyHint(),
        color: theme.colors.text.secondary,
    },
    toggle: {
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 6,
        paddingVertical: 1,
    },
    toggleText: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    children: {
        gap: 2,
        paddingLeft: 12,
    },
}));

function sanitizeTestIdPart(input: string): string {
    return input.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function describeRemoteValue(
    remote: Readonly<{
        type: string;
        value?: string | number | boolean | null;
        className?: string;
        description?: string;
    }>,
): string {
    if (remote.type === 'null') return 'null';
    if (remote.type === 'undefined') return 'undefined';
    if (remote.type === 'string') {
        return typeof remote.value === 'string' ? JSON.stringify(remote.value) : (remote.description ?? '""');
    }
    if (typeof remote.value === 'number' || typeof remote.value === 'boolean') {
        return String(remote.value);
    }
    return remote.description ?? remote.className ?? remote.type;
}

function entryStatusLabel(status: BrowserDiagnosticsEvalConsoleEntry['status']): string {
    switch (status) {
        case 'pending':
            return t('browserDiagnostics.host.interaction.eval.statusPending');
        case 'completed':
            return t('browserDiagnostics.host.interaction.eval.statusCompleted');
        case 'failed':
            return t('browserDiagnostics.host.interaction.eval.statusFailed');
        case 'timedOut':
            return t('browserDiagnostics.host.interaction.eval.statusTimedOut');
        case 'blocked':
            return t('browserDiagnostics.host.interaction.eval.statusBlocked');
        case 'collectorDegraded':
            return t('browserDiagnostics.host.interaction.eval.statusDegraded');
    }
}

type RemoteObjectNode = Readonly<{
    type: string;
    value?: string | number | boolean | null;
    objectId?: string;
    className?: string;
    description?: string;
}>;

function BrowserDiagnosticsObjectNode(props: Readonly<{
    name: string;
    remote: RemoteObjectNode;
    objectGroupId: string;
    controls: BrowserDiagnosticsEvalConsoleControls;
    depth: number;
    testID: string;
}>): React.ReactElement {
    const { remote, objectGroupId, controls, depth, testID } = props;
    const objectId = remote.objectId;
    const inspector = objectId ? controls.objectProperties[objectId] : undefined;
    const expandable = !!objectId && depth < MAX_OBJECT_INSPECTOR_DEPTH;
    // Expansion is per-node UI state, NOT derived from cache presence: deriving `expanded` from the
    // shared properties cache meant a node could never be collapsed (the "collapse" toggle just
    // re-ran `onExpandObject` and re-fetched). Track it locally so collapse hides the subtree and
    // re-expand reloads the latest properties.
    const [expanded, setExpanded] = React.useState(false);

    const onToggle = React.useCallback(() => {
        if (!objectId) return;
        if (expanded) {
            setExpanded(false);
            return;
        }
        setExpanded(true);
        controls.onExpandObject(objectId, objectGroupId);
    }, [controls, expanded, objectGroupId, objectId]);

    return (
        <View testID={testID} style={stylesheet.node}>
            <View style={stylesheet.nodeRow}>
                <Text style={stylesheet.nodeName}>{props.name}</Text>
                <Text style={stylesheet.nodeValue}>{describeRemoteValue(remote)}</Text>
                {expandable ? (
                    <Pressable
                        accessibilityRole="button"
                        onPress={onToggle}
                        style={stylesheet.toggle}
                        testID={`${testID}-expand`}
                    >
                        <Text style={stylesheet.toggleText}>
                            {expanded
                                ? t('browserDiagnostics.host.interaction.eval.collapse')
                                : t('browserDiagnostics.host.interaction.eval.expand')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
            {expanded && inspector ? (
                <View style={stylesheet.children} testID={`${testID}-children`}>
                    {inspector.status === 'loading' ? (
                        <Text style={stylesheet.meta}>{t('browserDiagnostics.host.interaction.eval.loading')}</Text>
                    ) : inspector.status === 'failed' ? (
                        <Text style={stylesheet.error}>
                            {t('browserDiagnostics.host.interaction.eval.propertiesFailed', {
                                reasonCode: inspector.errorCode ?? 'unavailable',
                            })}
                        </Text>
                    ) : inspector.properties.length === 0 ? (
                        <Text style={stylesheet.meta}>{t('browserDiagnostics.host.interaction.eval.noProperties')}</Text>
                    ) : (
                        inspector.properties.map((property) => (
                            <BrowserDiagnosticsObjectNode
                                key={property.name}
                                name={property.name}
                                remote={property.value}
                                objectGroupId={objectGroupId}
                                controls={controls}
                                depth={depth + 1}
                                testID={`${testID}-${sanitizeTestIdPart(property.name)}`}
                            />
                        ))
                    )}
                </View>
            ) : null}
        </View>
    );
}

function BrowserDiagnosticsEvalEntryView(props: Readonly<{
    entry: BrowserDiagnosticsEvalConsoleEntry;
    controls: BrowserDiagnosticsEvalConsoleControls;
    testID: string;
}>): React.ReactElement {
    const { entry, controls, testID } = props;
    return (
        <View testID={`${testID}-entry-${sanitizeTestIdPart(entry.evalRequestId)}`} style={stylesheet.entry}>
            <Text style={stylesheet.expression}>{entry.expression}</Text>
            <Text style={stylesheet.meta}>{entryStatusLabel(entry.status)}</Text>
            {entry.errorCode ? (
                <Text style={stylesheet.error}>
                    {t('browserDiagnostics.host.interaction.eval.error', { reasonCode: entry.errorCode })}
                </Text>
            ) : null}
            {entry.result ? (
                <BrowserDiagnosticsObjectNode
                    name={t('browserDiagnostics.host.interaction.eval.resultLabel')}
                    remote={entry.result}
                    objectGroupId={entry.objectGroupId}
                    controls={controls}
                    depth={0}
                    testID={`${testID}-result-${sanitizeTestIdPart(entry.evalRequestId)}`}
                />
            ) : null}
        </View>
    );
}

export function BrowserDiagnosticsEvalConsole(props: Readonly<{
    controls: BrowserDiagnosticsEvalConsoleControls;
    testID: string;
}>): React.ReactElement {
    const [expression, setExpression] = React.useState('');
    const { controls } = props;

    const submit = React.useCallback(() => {
        const trimmed = expression.trim();
        if (trimmed.length === 0) return;
        if (controls.onSubmitExpression(trimmed)) {
            setExpression('');
        }
    }, [controls, expression]);

    return (
        <View testID={`${props.testID}-console`} style={stylesheet.root}>
            <Text style={stylesheet.title}>{t('browserDiagnostics.host.interaction.eval.title')}</Text>
            <View style={stylesheet.inputRow}>
                <TextInput
                    testID={`${props.testID}-input`}
                    value={expression}
                    onChangeText={setExpression}
                    onSubmitEditing={submit}
                    placeholder={t('browserDiagnostics.host.interaction.eval.placeholder')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={stylesheet.input}
                />
                <Pressable
                    accessibilityRole="button"
                    onPress={submit}
                    style={stylesheet.submit}
                    testID={`${props.testID}-submit`}
                >
                    <Text style={stylesheet.submitText}>{t('browserDiagnostics.host.interaction.eval.run')}</Text>
                </Pressable>
            </View>
            {controls.entries.length === 0 ? (
                <Text testID={`${props.testID}-empty`} style={stylesheet.empty}>
                    {t('browserDiagnostics.host.interaction.eval.empty')}
                </Text>
            ) : (
                controls.entries.map((entry) => (
                    <BrowserDiagnosticsEvalEntryView
                        key={entry.evalRequestId}
                        entry={entry}
                        controls={controls}
                        testID={props.testID}
                    />
                ))
            )}
        </View>
    );
}
