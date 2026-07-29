import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import {
    buildQualifiedPluginContributionKey,
    PluginContributionIdentityV1Schema,
    PluginJsonValueV2Schema,
    type PluginJsonValueV2,
} from '@happier-dev/protocol';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';
import { Switch } from '@/components/ui/forms/Switch';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import {
    machinePluginSettingsGet,
    machinePluginSettingsSet,
    machinePluginStructuredMessageActionExecute,
} from '@/sync/ops/machineContributionRegistryProjection';
import { t } from '@/text';

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown): RecordValue | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

function localized(value: unknown): string {
    if (typeof value === 'string') return value;
    const candidate = record(value);
    return typeof candidate?.fallback === 'string' ? candidate.fallback : '';
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
    }
    const leftRecord = record(left);
    const rightRecord = record(right);
    if (!leftRecord || !rightRecord) return false;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
            && sameJsonValue(leftRecord[key], rightRecord[key]));
}

function snapshotValues(snapshot: Readonly<{
    values: Readonly<Record<string, unknown>>;
    redactedKeys: readonly string[];
}>): Readonly<Record<string, unknown>> {
    const redacted = new Set(snapshot.redactedKeys);
    return Object.fromEntries(Object.entries(snapshot.values).filter(([key]) => !redacted.has(key)));
}

function readFieldValue(
    drafts: Readonly<Record<string, unknown>>,
    values: Readonly<Record<string, unknown>>,
    fieldId: string,
): unknown {
    return Object.prototype.hasOwnProperty.call(drafts, fieldId) ? drafts[fieldId] : values[fieldId];
}

type DeclarativeActionBinding = Readonly<{
    qualifiedActionId: string;
    input: PluginJsonValueV2;
}>;

function readActionBinding(node: RecordValue, generation: string | null): DeclarativeActionBinding | null {
    const action = record(node.action);
    const identity = PluginContributionIdentityV1Schema.safeParse(action?.identity);
    const input = PluginJsonValueV2Schema.safeParse(node.input ?? null);
    if (
        !generation
        || !identity.success
        || !input.success
        || action?.generation !== generation
        || action.qualifiedId !== buildQualifiedPluginContributionKey(identity.data)
    ) {
        return null;
    }
    return {
        qualifiedActionId: action.qualifiedId,
        input: input.data,
    };
}

export function DeclarativePluginSurface(props: Readonly<{
    pluginId: string;
    model: unknown;
    machineId?: string | null;
    serverId?: string | null;
    interactionEnabled: boolean;
    authorityGeneration: number;
}>) {
    const model = record(props.model);
    const identity = record(model?.identity);
    const root = record(model?.root);
    const generation = typeof identity?.generation === 'string' ? identity.generation : null;
    const qualifiedId = typeof identity?.qualifiedId === 'string'
        ? identity.qualifiedId
        : props.pluginId;
    const visible = model?.visible === true && identity?.pluginId === props.pluginId && generation !== null;
    const [values, setValues] = React.useState<Readonly<Record<string, unknown>>>({});
    const [drafts, setDrafts] = React.useState<Readonly<Record<string, unknown>>>({});
    const [pendingActions, setPendingActions] = React.useState<ReadonlySet<string>>(new Set());
    const [settingsReady, setSettingsReady] = React.useState(false);
    const [settingsWritePending, setSettingsWritePending] = React.useState(false);
    const [settingsError, setSettingsError] = React.useState<string | null>(null);
    const [interactionFreshness, setInteractionFreshness] = React.useState(() => ({
        enabled: props.interactionEnabled,
        reconnectSequence: 0,
    }));
    let currentInteractionFreshness = interactionFreshness;
    if (interactionFreshness.enabled !== props.interactionEnabled) {
        currentInteractionFreshness = {
            enabled: props.interactionEnabled,
            reconnectSequence: interactionFreshness.reconnectSequence + (
                !interactionFreshness.enabled && props.interactionEnabled ? 1 : 0
            ),
        };
        setInteractionFreshness(currentInteractionFreshness);
    }
    const scopeSequenceRef = React.useRef(0);
    const settingsRevisionRef = React.useRef<string | null>(null);
    const settingsWritePendingRef = React.useRef(false);
    const pendingActionIdsRef = React.useRef(new Set<string>());
    const authorityScopeKey = props.interactionEnabled && visible && props.machineId
        ? [
            props.pluginId,
            props.machineId,
            props.serverId ?? 'default',
            generation,
            props.authorityGeneration,
            currentInteractionFreshness.reconnectSequence,
        ].join(':')
        : null;
    const liveAuthorityScopeKeyRef = React.useRef(authorityScopeKey);
    liveAuthorityScopeKeyRef.current = authorityScopeKey;
    const minimumTouchTarget = resolveMinimumInteractiveTargetSize(Platform.OS);
    const lastScopeRef = React.useRef<Readonly<{
        pluginId: string;
        generation: string | null;
        serverId: string | null;
        machineId: string | null;
    }> | null>(null);

    React.useEffect(() => {
        const scopeSequence = ++scopeSequenceRef.current;
        pendingActionIdsRef.current.clear();
        setPendingActions(new Set());
        const nextScope = {
            pluginId: props.pluginId,
            generation,
            serverId: props.serverId ?? null,
            machineId: props.machineId ?? null,
        };
        const lastScope = lastScopeRef.current;
        const scopeChanged = lastScope !== null && (
            lastScope.pluginId !== nextScope.pluginId
            || lastScope.generation !== nextScope.generation
            || lastScope.serverId !== nextScope.serverId
            || (
                nextScope.machineId !== null
                && lastScope.machineId !== null
                && lastScope.machineId !== nextScope.machineId
            )
        );
        if (scopeChanged) {
            setValues({});
            setDrafts({});
        }
        if (!lastScope || nextScope.machineId !== null || scopeChanged) {
            lastScopeRef.current = nextScope;
        }
        settingsRevisionRef.current = null;
        setSettingsReady(false);
        settingsWritePendingRef.current = false;
        setSettingsWritePending(false);
        setSettingsError(null);
        if (!visible || !props.machineId || !props.interactionEnabled) return;
        void machinePluginSettingsGet(props.machineId, {
            serverId: props.serverId ?? null,
            pluginId: props.pluginId,
        }).then((result) => {
            if (scopeSequenceRef.current !== scopeSequence) return;
            if (!result.supported) {
                setSettingsError(t('common.unavailable'));
                return;
            }
            const next = snapshotValues(result.snapshot);
            settingsRevisionRef.current = result.snapshot.revision;
            setValues(next);
            setDrafts(next);
            setSettingsReady(true);
            setSettingsError(null);
        });
    }, [
        generation,
        props.authorityGeneration,
        props.interactionEnabled,
        props.machineId,
        props.pluginId,
        props.serverId,
        visible,
    ]);

    const recoverSettingsAfterWriteFailure = React.useCallback((
        scopeSequence: number,
        fallbackValues: Readonly<Record<string, unknown>>,
    ) => {
        setDrafts(fallbackValues);
        setSettingsError(t('common.error'));
        if (!props.machineId || !props.interactionEnabled) return;
        void machinePluginSettingsGet(props.machineId, {
            serverId: props.serverId ?? null,
            pluginId: props.pluginId,
        }).then((result) => {
            if (scopeSequenceRef.current !== scopeSequence || !result.supported) return;
            const next = snapshotValues(result.snapshot);
            settingsRevisionRef.current = result.snapshot.revision;
            setValues(next);
            setDrafts(next);
        }).catch(() => {
            // Preserve the last known authoritative values and the visible write error.
        });
    }, [props.interactionEnabled, props.machineId, props.pluginId, props.serverId]);

    const commitField = React.useCallback((fieldId: string, value: unknown) => {
        if (
            authorityScopeKey === null
            || liveAuthorityScopeKeyRef.current !== authorityScopeKey
            || !props.machineId
            || !props.interactionEnabled
            || !visible
            || !settingsReady
            || settingsWritePendingRef.current
        ) {
            return;
        }
        const scopeSequence = scopeSequenceRef.current;
        const expectedRevision = settingsRevisionRef.current;
        if (expectedRevision === null) return;
        const authoritativeValues = values;
        settingsWritePendingRef.current = true;
        setSettingsWritePending(true);
        setSettingsError(null);
        void machinePluginSettingsSet(props.machineId, {
            serverId: props.serverId ?? null,
            pluginId: props.pluginId,
            fieldId,
            value,
            expectedRevision,
        }).then((result) => {
            if (scopeSequenceRef.current !== scopeSequence) return;
            if (!result.supported) {
                recoverSettingsAfterWriteFailure(scopeSequence, authoritativeValues);
                return;
            }
            const next = snapshotValues(result.snapshot);
            settingsRevisionRef.current = result.snapshot.revision;
            setValues(next);
            setDrafts(next);
        }).catch(() => {
            if (scopeSequenceRef.current !== scopeSequence) return;
            recoverSettingsAfterWriteFailure(scopeSequence, authoritativeValues);
        }).finally(() => {
            if (scopeSequenceRef.current !== scopeSequence) return;
            settingsWritePendingRef.current = false;
            setSettingsWritePending(false);
        });
    }, [
        authorityScopeKey,
        props.interactionEnabled,
        props.machineId,
        props.pluginId,
        props.serverId,
        recoverSettingsAfterWriteFailure,
        settingsReady,
        values,
        visible,
    ]);

    const runAction = React.useCallback((binding: DeclarativeActionBinding, enabled: boolean) => {
        const qualifiedActionId = binding.qualifiedActionId;
        if (
            authorityScopeKey === null
            || liveAuthorityScopeKeyRef.current !== authorityScopeKey
            || !props.machineId
            || !props.interactionEnabled
            || !generation
            || !enabled
            || !settingsReady
            || pendingActionIdsRef.current.has(qualifiedActionId)
        ) {
            return;
        }
        const scopeSequence = scopeSequenceRef.current;
        pendingActionIdsRef.current.add(qualifiedActionId);
        setPendingActions((current) => new Set(current).add(qualifiedActionId));
        void machinePluginStructuredMessageActionExecute(props.machineId, {
            serverId: props.serverId ?? null,
            expectedGeneration: generation,
            qualifiedActionId,
            input: binding.input,
            executionSurface: 'ui',
        }).finally(() => {
            if (scopeSequenceRef.current !== scopeSequence) return;
            pendingActionIdsRef.current.delete(qualifiedActionId);
            setPendingActions((current) => {
                const next = new Set(current);
                next.delete(qualifiedActionId);
                return next;
            });
        });
    }, [authorityScopeKey, generation, props.interactionEnabled, props.machineId, props.serverId, settingsReady]);

    const renderNode = (nodeValue: unknown): React.ReactNode => {
        const node = record(nodeValue);
        if (!node || typeof node.kind !== 'string' || typeof node.path !== 'string') return null;
        if (node.kind === 'stack' || node.kind === 'group') {
            const children = Array.isArray(node.children) ? node.children : [];
            return (
                <View
                    key={node.path}
                    testID={`plugin-declarative-${node.kind}`}
                    style={{
                        gap: node.gap === 'large' ? 16 : node.gap === 'small' ? 4 : 8,
                        flexDirection: node.kind === 'stack' && node.direction === 'horizontal'
                            ? 'row'
                            : 'column',
                        flexWrap: 'wrap',
                    }}
                >
                    {node.kind === 'group' && localized(node.title) ? (
                        <Text accessibilityRole="header">{localized(node.title)}</Text>
                    ) : null}
                    {localized(node.description) ? <Text>{localized(node.description)}</Text> : null}
                    {children.map(renderNode)}
                </View>
            );
        }
        if (node.kind === 'text') {
            return <Text key={node.path} selectable>{localized(node.text)}</Text>;
        }
        if (node.kind === 'markdown') {
            return (
                <MarkdownView
                    key={node.path}
                    testID={`plugin-declarative-markdown:${node.path}`}
                    markdown={localized(node.text)}
                    selectable
                />
            );
        }
        if (node.kind === 'status') {
            return (
                <View
                    key={node.path}
                    testID="plugin-declarative-status"
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={`${localized(node.label)}: ${localized(node.value)}`}
                >
                    <Text>{localized(node.label)}</Text>
                    <Text selectable>{localized(node.value)}</Text>
                </View>
            );
        }
        if (node.kind === 'action') {
            const binding = readActionBinding(node, generation);
            const id = binding?.qualifiedActionId ?? `invalid:${node.path}`;
            const disabled = node.enabled !== true
                || !props.interactionEnabled
                || !props.machineId
                || !binding
                || !settingsReady
                || pendingActions.has(id);
            return (
                <Pressable
                    key={node.path}
                    testID={`plugin-declarative-action:${id}`}
                    accessibilityRole="button"
                    accessibilityState={{ disabled, busy: pendingActions.has(id) }}
                    disabled={disabled}
                    onPress={disabled || !binding
                        ? undefined
                        : () => runAction(binding, node.enabled === true)}
                    style={{ minHeight: minimumTouchTarget, justifyContent: 'center' }}
                >
                    <Text>{localized(node.label)}</Text>
                </Pressable>
            );
        }
        if (node.kind === 'field') {
            const control = record(node.control);
            const setting = record(node.setting);
            const settingId = typeof setting?.id === 'string' ? setting.id : null;
            const controlSettingId = typeof control?.settingId === 'string' ? control.settingId : null;
            if (!settingId || settingId !== controlSettingId) return null;
            const fieldId = settingId;
            const value = readFieldValue(drafts, values, fieldId);
            const disabled = !props.interactionEnabled
                || !props.machineId
                || !settingsReady
                || settingsWritePending;
            if (control?.kind === 'toggle') {
                return (
                    <View key={node.path} style={{ gap: 4 }}>
                        <Text>{localized(node.label)}</Text>
                        {localized(node.description) ? <Text>{localized(node.description)}</Text> : null}
                        <Switch
                            testID={`plugin-declarative-field:${node.path}`}
                            accessibilityLabel={localized(node.label)}
                            value={value === true}
                            disabled={disabled}
                            onValueChange={(next) => {
                                setDrafts((current) => ({ ...current, [fieldId]: next }));
                                commitField(fieldId, next);
                            }}
                        />
                    </View>
                );
            }
            if (control?.kind === 'select') {
                const options = Array.isArray(control.options) ? control.options : [];
                return (
                    <View key={node.path} accessibilityRole="radiogroup" style={{ gap: 4 }}>
                        <Text>{localized(node.label)}</Text>
                        {localized(node.description) ? <Text>{localized(node.description)}</Text> : null}
                        {options.map((optionValue, index) => {
                            const option = record(optionValue);
                            if (!option || !('value' in option)) return null;
                            const selected = sameJsonValue(value, option.value);
                            return (
                                <Pressable
                                    key={`${node.path}:${index}`}
                                    testID={`plugin-declarative-field:${node.path}:option:${index}`}
                                    accessibilityRole="radio"
                                    accessibilityLabel={localized(option.label)}
                                    accessibilityState={{ selected, disabled }}
                                    disabled={disabled}
                                    onPress={disabled ? undefined : () => {
                                        setDrafts((current) => ({
                                            ...current,
                                            [fieldId]: option.value,
                                        }));
                                        commitField(fieldId, option.value);
                                    }}
                                    style={{ minHeight: minimumTouchTarget, justifyContent: 'center' }}
                                >
                                    <Text>{localized(option.label)}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                );
            }
            if (control?.kind !== 'text' && control?.kind !== 'number' && control?.kind !== 'secret') {
                return null;
            }
            const draftValue = drafts[fieldId] ?? '';
            const numberValue = control.kind === 'number'
                && typeof draftValue === 'string'
                && draftValue.trim().length > 0
                ? Number(draftValue)
                : null;
            const canSave = !disabled
                && (control.kind !== 'number' || (numberValue !== null && Number.isFinite(numberValue)));
            const committedValue = control.kind === 'number'
                ? numberValue
                : readFieldValue(drafts, values, fieldId) ?? '';
            return (
                <View key={node.path} style={{ gap: 8 }}>
                    <Text>{localized(node.label)}</Text>
                    {localized(node.description) ? <Text>{localized(node.description)}</Text> : null}
                    <TextInput
                        testID={`plugin-declarative-field:${node.path}`}
                        accessibilityLabel={localized(node.label)}
                        value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                        editable={!disabled}
                        keyboardType={control.kind === 'number' ? 'numeric' : undefined}
                        secureTextEntry={control.kind === 'secret'}
                        style={{ minHeight: minimumTouchTarget }}
                        onChangeText={(next) => setDrafts((current) => ({
                            ...current,
                            [fieldId]: next,
                        }))}
                    />
                    <Pressable
                        testID={`plugin-declarative-field-save:${node.path}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.save')}
                        accessibilityState={{ disabled: !canSave }}
                        disabled={!canSave}
                        onPress={canSave ? () => commitField(fieldId, committedValue) : undefined}
                        style={{ minHeight: minimumTouchTarget, justifyContent: 'center' }}
                    >
                        <Text>{t('common.save')}</Text>
                    </Pressable>
                </View>
            );
        }
        return null;
    };

    if (!visible || !root) return null;
    return (
        <PluginSurfaceInteractionBoundary
            surfaceId={`declarative:${props.pluginId}:${qualifiedId}`}
            snapshotTitle={localized(root.title) || qualifiedId}
            enabled={props.interactionEnabled && settingsReady}
        >
            <View testID="plugin-declarative-surface" style={{ gap: 12 }}>
                {settingsError ? (
                    <View
                        testID="plugin-declarative-settings-error"
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                    >
                        <Text>{settingsError}</Text>
                    </View>
                ) : null}
                {renderNode(root)}
            </View>
        </PluginSurfaceInteractionBoundary>
    );
}
