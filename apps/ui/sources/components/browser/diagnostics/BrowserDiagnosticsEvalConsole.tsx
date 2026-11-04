import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';

import { Text, TextInput } from '@/components/ui/text/Text';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosedCodeText, DisclosureCaret, useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { Typography } from '@/constants/Typography';
import type {
    BrowserDiagnosticsEvalResultV1,
    BrowserDiagnosticsObjectPropertyV1,
    BrowserDiagnosticsRemoteObjectV1,
} from '@happier-dev/protocol/browser/diagnostics/v1';
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

export type BrowserDiagnosticsEvalConsoleEntry = Readonly<{
    evalRequestId: string;
    expression: string;
    objectGroupId: string;
    status: 'pending' | BrowserDiagnosticsEvalResultV1['status'];
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
    onCancelEval: (evalRequestId: string) => void;
}>;

const MONO_MICRO = { ...Typography.variant('micro', 'regular'), ...Typography.mono(), ...Typography.tabular() };

const stylesheet = StyleSheet.create((theme) => ({
    // The REPL reads as the console's tail: its log lines in the console's row rhythm, its input last.
    root: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s2,
    },
    entry: {
        paddingVertical: theme.space.s2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.subtle,
    },
    entryFailed: {
        backgroundColor: theme.colors.state.danger.background,
    },
    prompt: {
        ...MONO_MICRO,
        width: ICON_SIZE.xxs + ICON_SIZE.xs + theme.space.s8,
        color: theme.colors.text.secondary,
    },
    promptSlot: {
        width: ICON_SIZE.xxs + ICON_SIZE.xs + theme.space.s8,
        paddingTop: 1,
    },
    expression: {
        ...MONO_MICRO,
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
    },
    meta: {
        ...Typography.variant('micro', 'regular'),
        color: theme.colors.text.secondary,
    },
    error: {
        ...Typography.variant('micro', 'regular'),
        flex: 1,
        minWidth: 0,
        // Semantic foregrounds are fill colours; the words stay ink, the glyph carries the hue.
        color: theme.colors.text.primary,
    },
    errorBody: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
        alignItems: 'flex-start',
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s6,
    },
    input: {
        ...MONO_MICRO,
        flex: 1,
        minWidth: 0,
        paddingVertical: theme.space.s4,
        color: theme.colors.text.primary,
    },
    empty: {
        ...Typography.variant('micro', 'regular'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s4,
    },
    node: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    nodeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s4,
    },
    nodeName: {
        ...MONO_MICRO,
        color: theme.colors.text.secondary,
    },
    nodeValue: {
        ...MONO_MICRO,
        color: theme.colors.text.primary,
    },
    caretSlot: {
        width: ICON_SIZE.xxs,
        alignItems: 'center',
    },
    children: {
        gap: theme.space.s2,
        paddingLeft: theme.space.s12,
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

/** The one sentence for an entry that did not produce a value; `null` while it has one or is still running. */
function entryProblem(status: BrowserDiagnosticsEvalConsoleEntry['status']): string | null {
    switch (status) {
        case 'pending':
        case 'completed':
            return null;
        case 'cancelled':
            return t('status.canceled');
        case 'failed':
            return t('browserDiagnostics.host.devtools.eval.failed');
        case 'timedOut':
            return t('browserDiagnostics.host.devtools.eval.timedOut');
        case 'blocked':
            return t('browserDiagnostics.host.devtools.eval.blocked');
        case 'collectorDegraded':
            return t('browserDiagnostics.host.devtools.eval.degraded');
    }
}

type RemoteObjectNode = Readonly<{
    type: string;
    value?: string | number | boolean | null;
    objectId?: string;
    className?: string;
    description?: string;
    previewTruncated?: boolean;
}>;

function BrowserDiagnosticsObjectNode(props: Readonly<{
    name: string;
    remote: RemoteObjectNode;
    objectGroupId: string;
    controls: BrowserDiagnosticsEvalConsoleControls;
    testID: string;
}>): React.ReactElement {
    const { remote, objectGroupId, controls, testID } = props;
    const objectId = remote.objectId;
    const inspector = objectId ? controls.objectProperties[objectId] : undefined;
    const expandable = !!objectId;
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
            <Pressable
                testID={expandable ? `${testID}-expand` : undefined}
                disabled={!expandable}
                onPress={onToggle}
                accessibilityRole={expandable ? 'button' : undefined}
                accessibilityState={expandable ? { expanded } : undefined}
                accessibilityLabel={expandable
                    ? (expanded
                        ? t('browserDiagnostics.host.interaction.eval.collapse')
                        : t('browserDiagnostics.host.interaction.eval.expand'))
                    : undefined}
                style={stylesheet.nodeRow}
            >
                <View style={stylesheet.caretSlot}>
                    {expandable ? <DisclosureCaret expanded={expanded} density="compact" /> : null}
                </View>
                {props.name ? <Text style={stylesheet.nodeName}>{`${props.name}:`}</Text> : null}
                <Text selectable style={stylesheet.nodeValue}>{describeRemoteValue(remote)}{remote.previewTruncated ? ' …' : ''}</Text>
            </Pressable>
            {expanded && inspector ? (
                <View style={stylesheet.children} testID={`${testID}-children`}>
                    {inspector.status === 'loading' ? (
                        <Text style={stylesheet.meta}>{t('browserDiagnostics.host.interaction.eval.loading')}</Text>
                    ) : inspector.status === 'failed' ? (
                        <Text style={stylesheet.meta}>{t('browserDiagnostics.host.devtools.eval.propertiesFailed')}</Text>
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
                                testID={`${testID}-${sanitizeTestIdPart(property.name)}`}
                            />
                        ))
                    )}
                </View>
            ) : null}
        </View>
    );
}

function EvalErrorLine(props: Readonly<{ problem: string; errorCode?: string; testID: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    const binding = useCoreDisclosureToggleBinding();
    const [open, setOpen] = React.useState(false);
    return (
        <View style={stylesheet.line}>
            <View style={stylesheet.promptSlot}>
                <Icon name="x-circle" size={ICON_SIZE.xs} color={theme.colors.state.danger.foreground} />
            </View>
            <View style={stylesheet.errorBody}>
                <Text testID={`${props.testID}-problem`} style={stylesheet.error}>{props.problem}</Text>
                {props.errorCode ? (
                    <>
                        <HappierDisclosureToggle
                            testID={`${props.testID}-details`}
                            label={t('browserDiagnostics.host.devtools.eval.details')}
                            open={open}
                            onPress={() => setOpen((value) => !value)}
                            caret={binding.renderCaret(open)}
                            renderLabel={binding.renderLabel}
                            focusColor={binding.focusColor}
                        />
                        {open ? <DisclosedCodeText testID={`${props.testID}-code`}>{props.errorCode}</DisclosedCodeText> : null}
                    </>
                ) : null}
            </View>
        </View>
    );
}

function BrowserDiagnosticsEvalEntryView(props: Readonly<{
    entry: BrowserDiagnosticsEvalConsoleEntry;
    controls: BrowserDiagnosticsEvalConsoleControls;
    testID: string;
}>): React.ReactElement {
    const { entry, controls, testID } = props;
    const entryId = sanitizeTestIdPart(entry.evalRequestId);
    const problem = entryProblem(entry.status) ?? (entry.errorCode ? t('browserDiagnostics.host.devtools.eval.failed') : null);
    return (
        <View testID={`${testID}-entry-${entryId}`} style={[stylesheet.entry, problem && entry.status !== 'cancelled' ? stylesheet.entryFailed : null]}>
            <View style={stylesheet.line}>
                <Text style={stylesheet.prompt}>{'›'}</Text>
                <Text selectable style={stylesheet.expression}>{entry.expression}</Text>
                {entry.status === 'pending' ? (
                    <ToolbarButton testID={`${testID}-cancel-${entryId}`}
                        label={t('common.cancel')} onPress={() => controls.onCancelEval(entry.evalRequestId)} />
                ) : null}
            </View>
            {entry.status === 'pending' ? (
                <View style={stylesheet.line}>
                    <Text style={stylesheet.prompt}>{'‹'}</Text>
                    <Text style={stylesheet.meta}>{t('browserDiagnostics.host.interaction.eval.statusPending')}</Text>
                </View>
            ) : null}
            {problem ? <EvalErrorLine problem={problem} errorCode={entry.errorCode} testID={`${testID}-error-${entryId}`} /> : null}
            {entry.result ? (
                <View style={stylesheet.line}>
                    <Text style={stylesheet.prompt}>{'‹'}</Text>
                    <BrowserDiagnosticsObjectNode
                        name=""
                        remote={entry.result}
                        objectGroupId={entry.objectGroupId}
                        controls={controls}
                        testID={`${testID}-result-${entryId}`}
                    />
                </View>
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
            {/* It sits under the Console tab, so it carries no "Console" title of its own. */}
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
            <View style={stylesheet.inputRow}>
                <Text style={stylesheet.prompt}>{'›'}</Text>
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
                <ToolbarButton
                    onPress={submit}
                    testID={`${props.testID}-submit`}
                    label={t('browserDiagnostics.host.interaction.eval.run')}
                />
            </View>
        </View>
    );
}
