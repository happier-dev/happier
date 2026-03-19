import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getActionSpec, resolveEffectiveActionInputFields } from '@happier-dev/protocol';

import { buildResumeSessionExtrasFromUiState, DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { Text } from '@/components/ui/text/Text';
import { buildAvailableReviewEngineOptions } from '@/sync/domains/reviews/reviewEngineCatalog';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { useSession, useSettings } from '@/sync/domains/state/storage';
import { buildExecutionRunsGuidanceBlock, coerceExecutionRunsGuidanceEntries } from '@/sync/domains/settings/executionRunsGuidance';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resumeSession } from '@/sync/ops/sessions';
import { t } from '@/text';
import { resolveActionInputValidationError } from '@/sync/domains/actions/resolveActionInputValidationError';
import { resolveExecutionRunLauncherContainerStyle } from './resolveExecutionRunLauncherContainerStyle';
import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { resolveExecutionRunActionDefaultPermissionMode } from '@/sync/domains/actions/resolveExecutionRunActionDefaultPermissionMode';
import { resolveExecutionRunActionAllowedPermissionModes } from '@/sync/domains/actions/resolveExecutionRunActionAllowedPermissionModes';
import { ActionInputFields, getValueAtPath, setValueAtTopLevelPatch, type ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';

import {
    EXECUTION_RUN_LAUNCH_INTENTS,
    type ExecutionRunIntent,
} from './executionRunLauncherModel';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    section: {
        gap: 8,
    },
    label: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
    },
    actionRow: {
        flexDirection: 'row',
        gap: 12,
    },
    actionButton: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    primaryActionText: {
        color: theme.colors.text,
        fontWeight: '600',
    },
    secondaryActionText: {
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    errorText: {
        color: theme.colors.status?.error ?? theme.colors.textDestructive ?? theme.colors.text,
    },
    guidanceLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '600',
    },
    guidanceText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
}));

export const SessionExecutionRunLauncherView = React.memo((props: Readonly<{
    sessionId: string;
    scopeId?: string;
    initialIntent?: ExecutionRunIntent;
    presentation?: 'screen' | 'panel';
    onRequestClose?: () => void;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const hydrateReady = useHydrateSessionForRoute(props.sessionId, 'SessionExecutionRunLauncherView.hydrate');
    const session = useSession(props.sessionId);
    const settings = useSettings();
    const enabledAgentIds = useEnabledAgentIds();
    const executionRunsBackends = useExecutionRunsBackendsForSession(props.sessionId);
    const { machineReachable } = useSessionMachineReachability(props.sessionId);
    const machineId = React.useMemo(
        () => resolveSessionMachineId((session as any)?.metadata),
        [(session as any)?.metadata],
    );
    const agentId = React.useMemo(
        () => {
            const flavor = typeof (session as any)?.metadata?.flavor === 'string'
                ? String((session as any).metadata.flavor)
                : typeof (session as any)?.metadata?.agent === 'string'
                    ? String((session as any).metadata.agent)
                    : null;
            return resolveAgentIdFromFlavor(flavor);
        },
        [session],
    );
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId: agentId ?? DEFAULT_AGENT_ID,
        machineId,
        settings,
        enabled: session?.active === false,
    });

    const { state: machineCapabilitiesState } = useMachineCapabilitiesCache({
        machineId,
        enabled: Boolean(machineId),
        request: { requests: [{ id: 'tool.executionRuns' }] } as any,
    });

    const initialIntent = props.initialIntent ?? 'review';
    const [intent, setIntent] = React.useState<ExecutionRunIntent>(initialIntent);
    const initialBackendTarget = React.useMemo(
        () => (agentId ? { kind: 'builtInAgent', agentId } as const : null),
        [agentId],
    );
    const [isStarting, setIsStarting] = React.useState(false);
    const [startError, setStartError] = React.useState<string | null>(null);

    const backendChoices = React.useMemo(() => {
        if (!executionRunsBackends || Object.keys(executionRunsBackends).length === 0) return [];
        return resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds,
            executionRunsBackends,
            acpCatalogSettingsV1: (settings as any)?.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
            intent,
        });
    }, [enabledAgentIds, executionRunsBackends, intent, settings]);

    const initialBackendTargetKey = React.useMemo(() => {
        const sessionAgent = (session as any)?.metadata?.agent;
        if (typeof sessionAgent !== 'string') return null;
        const matchingChoice = backendChoices.find((choice) => choice.builtInAgentId === sessionAgent && choice.disabled !== true);
        if (matchingChoice) {
            return matchingChoice.targetKey;
        }
        return null;
    }, [backendChoices, session]);

    const buildSeedInput = React.useCallback((nextIntent: ExecutionRunIntent, previousInput?: Record<string, unknown> | null) => {
        const actionId = nextIntent === 'review' ? 'review.start' : nextIntent === 'plan' ? 'subagents.plan.start' : 'subagents.delegate.start';
        const previousInstructions = typeof getValueAtPath(previousInput ?? {}, 'instructions') === 'string'
            ? String(getValueAtPath(previousInput ?? {}, 'instructions'))
            : '';
        return buildExecutionRunActionDraftInputForUi({
            actionId: actionId as any,
            sessionId: props.sessionId,
            defaultBackendTarget: nextIntent === 'review' ? null : initialBackendTarget,
            defaultBackendId: agentId,
            instructions: previousInstructions,
        });
    }, [agentId, initialBackendTarget, props.sessionId]);

    const [actionInput, setActionInput] = React.useState<Record<string, unknown>>(() => buildSeedInput(initialIntent));
    const actionId = intent === 'review' ? 'review.start' : intent === 'plan' ? 'subagents.plan.start' : 'subagents.delegate.start';
    const actionSpec = React.useMemo(() => getActionSpec(actionId as any), [actionId]);
    const fields = React.useMemo(
        () => resolveEffectiveActionInputFields(actionSpec as any, { sessionId: props.sessionId, ...actionInput }),
        [actionInput, actionSpec, props.sessionId],
    );

    const reviewEngineOptions = React.useMemo<readonly ActionFieldOption[]>(() => {
        return buildAvailableReviewEngineOptions({
            enabledAgentIds,
            executionRunsBackends,
            resolveAgentLabel: (id) => t(getAgentCore(id as any).displayNameKey),
        }).map((option) => ({
            value: option.id,
            label: option.label ?? option.id,
            ...(option.disabled === true ? { disabled: true as const } : {}),
        }));
    }, [enabledAgentIds, executionRunsBackends]);

    const executionBackendOptions = React.useMemo<readonly ActionFieldOption[]>(() => {
        return backendChoices.map((choice) => ({
            value: choice.targetKey,
            label: choice.title,
            ...(choice.disabled ? { disabled: true as const } : {}),
        }));
    }, [backendChoices]);

    const resolveFieldOptions = React.useCallback((field: any): readonly ActionFieldOption[] => {
        const sourceId = typeof field?.optionsSourceId === 'string' ? field.optionsSourceId : '';
        if (sourceId === 'review.engines.available') return reviewEngineOptions;
        if (sourceId === 'execution.backends.enabled') return executionBackendOptions;
        const options = Array.isArray(field?.options) ? field.options : [];
        return options
            .map((option: any) => {
                const value = typeof option?.value === 'string' ? option.value : '';
                const label = typeof option?.label === 'string' ? option.label : value;
                if (!value) return null;
                return { value, label };
            })
            .filter(Boolean) as readonly ActionFieldOption[];
    }, [executionBackendOptions, reviewEngineOptions]);

    const selectedBackendChoices = React.useMemo(() => {
        const fieldPath = intent === 'review' ? 'engineIds' : 'backendTargetKeys';
        const selectedValues = Array.isArray(getValueAtPath(actionInput, fieldPath))
            ? (getValueAtPath(actionInput, fieldPath) as unknown[]).map(String)
            : [];
        return backendChoices.filter((choice) => selectedValues.includes(choice.targetKey) || selectedValues.includes(choice.builtInAgentId));
    }, [actionInput, backendChoices, intent]);

    const permissionModeOptions = React.useMemo(() => {
        const rawAgentType =
            selectedBackendChoices[0]?.builtInAgentId
            ?? (session as any)?.metadata?.agent
            ?? enabledAgentIds[0]
            ?? null;
        const agentType = typeof rawAgentType === 'string' ? rawAgentType : DEFAULT_AGENT_ID;
        return getPermissionModeOptionsForAgentType(agentType as any);
    }, [enabledAgentIds, selectedBackendChoices, session]);
    const selectedPermissionMode = React.useMemo(() => {
        const value = getValueAtPath(actionInput, 'permissionMode');
        return typeof value === 'string' ? value : '';
    }, [actionInput]);
    const allowedPermissionModes = React.useMemo(
        () => resolveExecutionRunActionAllowedPermissionModes(actionId as any),
        [actionId],
    );
    const visiblePermissionModeOptions = React.useMemo(() => {
        if (!allowedPermissionModes || allowedPermissionModes.length === 0) {
            return permissionModeOptions;
        }
        return permissionModeOptions.filter((option) => allowedPermissionModes.includes(option.value));
    }, [allowedPermissionModes, permissionModeOptions]);
    const showPermissionModeSection = visiblePermissionModeOptions.length > 1;

    React.useEffect(() => {
        const primaryField = fields.find((field: any) => field.widget === 'multiselect' && typeof field?.optionsSourceId === 'string');
        if (!primaryField?.path) return;

        const selectableValues = resolveFieldOptions(primaryField).filter((option) => option.disabled !== true).map((option) => option.value);
        const current = Array.isArray(getValueAtPath(actionInput, primaryField.path))
            ? (getValueAtPath(actionInput, primaryField.path) as unknown[]).map(String)
            : [];

        const preserved = current.filter((value) => selectableValues.includes(value));
        const preferredValue = initialBackendTargetKey && selectableValues.includes(initialBackendTargetKey) ? initialBackendTargetKey : selectableValues[0];
        const next = selectableValues.length === 0
            ? []
            : preserved.length > 0
                ? preserved
                : primaryField.requireExplicitSelection === true
                    ? []
                : preferredValue
                    ? [preferredValue]
                    : [];

        if (current.length === next.length && current.every((value, index) => value === next[index])) {
            return;
        }

        setActionInput((previous) => ({
            ...previous,
            ...setValueAtTopLevelPatch(previous, primaryField.path, next),
        }));
    }, [actionInput, fields, initialBackendTargetKey, resolveFieldOptions]);

    React.useEffect(() => {
        if (!allowedPermissionModes || allowedPermissionModes.length === 0) {
            return;
        }
        if (allowedPermissionModes.includes(selectedPermissionMode as any)) {
            return;
        }

        const defaultMode = resolveExecutionRunActionDefaultPermissionMode(actionId as any);
        const nextMode = defaultMode && allowedPermissionModes.includes(defaultMode as any)
            ? defaultMode
            : allowedPermissionModes[0];
        if (!nextMode) {
            return;
        }

        setActionInput((previous) => ({
            ...previous,
            ...setValueAtTopLevelPatch(previous, 'permissionMode', nextMode),
        }));
    }, [actionId, allowedPermissionModes, selectedPermissionMode]);

    const guidancePreview = React.useMemo(() => {
        if ((settings as any).executionRunsGuidanceEnabled !== true) return '';
        const maxCharsRaw = (settings as any).executionRunsGuidanceMaxChars;
        const maxChars = typeof maxCharsRaw === 'number' && Number.isFinite(maxCharsRaw) ? Math.floor(maxCharsRaw) : 4_000;
        const entries = coerceExecutionRunsGuidanceEntries((settings as any).executionRunsGuidanceEntries);
        return buildExecutionRunsGuidanceBlock({ entries, maxChars: Math.min(maxChars, 2_000) }).text;
    }, [settings]);

    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const { canLaunchExecutionRuns, canShowExecutionRunLauncher, executionRunsSupported } = useSessionExecutionRunLaunchability(props.sessionId, session);
    const capabilityServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || null;
    const waitingForExecutionRunCapabilities = React.useMemo(() => {
        if (canShowExecutionRunLauncher !== true) return false;
        if (canLaunchExecutionRuns === true) return false;
        if (executionRunsBackends && Object.keys(executionRunsBackends).length > 0) return false;
        return machineCapabilitiesState.status === 'idle' || machineCapabilitiesState.status === 'loading';
    }, [
        canLaunchExecutionRuns,
        canShowExecutionRunLauncher,
        executionRunsBackends,
        machineCapabilitiesState.status,
    ]);
    const validationError = React.useMemo(
        () => resolveActionInputValidationError({
            sessionId: props.sessionId,
            input: actionInput,
            spec: actionSpec as any,
            fields: fields as any,
        }),
        [actionInput, actionSpec, fields, props.sessionId],
    );
    const canStart = validationError === null && !isStarting;

    const onSelectIntent = React.useCallback((nextIntent: ExecutionRunIntent) => {
        setStartError(null);
        setIntent(nextIntent);
        setActionInput(buildSeedInput(nextIntent, actionInput));
    }, [actionInput, buildSeedInput]);

    const closeSurface = React.useCallback(() => {
        props.onRequestClose?.();
    }, [props]);

    const onStart = React.useCallback(async () => {
        if (!canStart) {
            if (validationError) setStartError(validationError);
            return;
        }
        setStartError(null);
        setIsStarting(true);
        try {
            if (session?.active === false) {
                if (!machineReachable) {
                    setStartError(t('session.machineOfflineCannotResume'));
                    return;
                }

                const permissionOverride = getPermissionModeOverrideForSpawn(session);
                const modelOverride = getModelOverrideForSpawn(session);
                const base = buildResumeSessionBaseOptionsFromSession({
                    sessionId: props.sessionId,
                    session,
                    resumeCapabilityOptions,
                    permissionOverride,
                    modelOverride,
                });
                if (!base || !agentId) {
                    setStartError(t('session.resumeFailed'));
                    return;
                }

                const resumeResult = await resumeSession({
                    ...base,
                    ...(capabilityServerId ? { serverId: capabilityServerId } : {}),
                    ...buildResumeSessionExtrasFromUiState({
                        agentId,
                        settings,
                        session,
                    }),
                });
                if (resumeResult.type === 'error') {
                    setStartError(resumeResult.errorMessage);
                    return;
                }
            }

            const result = await actionExecutor.execute(
                actionId as any,
                {
                    sessionId: props.sessionId,
                    ...actionInput,
                },
                { defaultSessionId: props.sessionId },
            );

            const errorMessage = resolveActionExecutionFailureMessage(result, t('common.requestFailed'));
            if (errorMessage) {
                setStartError(errorMessage);
                return;
            }

            if (props.presentation === 'panel') {
                closeSurface();
                return;
            }

            router.push(`/session/${props.sessionId}/runs` as any);
        } catch (error) {
            setStartError(error instanceof Error && error.message.trim().length > 0 ? error.message : t('common.requestFailed'));
        } finally {
            setIsStarting(false);
        }
    }, [
        actionExecutor,
        agentId,
        canStart,
        closeSurface,
        intent,
        machineReachable,
        capabilityServerId,
        props.presentation,
        props.sessionId,
        resumeCapabilityOptions,
        router,
        actionId,
        actionExecutor,
        actionInput,
        session,
        settings,
        validationError,
    ]);

    if (!hydrateReady) {
        return <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
    }

    if (waitingForExecutionRunCapabilities) {
        return <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
    }

    if (!canLaunchExecutionRuns) {
        return <Text style={styles.label}>{t('common.unavailable')}</Text>;
    }

    return (
        <View style={[styles.container, resolveExecutionRunLauncherContainerStyle(props.presentation)]}>
            <View style={styles.section}>
                <Text style={styles.label}>{t('executionRuns.newRun.sections.intent')}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                    {EXECUTION_RUN_LAUNCH_INTENTS.map((nextIntent) => {
                        const intentLabel = t(`executionRuns.newRun.intents.${nextIntent}` as const);
                        const selected = intent === nextIntent;
                        return (
                            <Pressable
                                key={nextIntent}
                                testID={`execution-run-launcher-intent:${nextIntent}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('executionRuns.newRun.a11y.selectIntent', { intent: intentLabel })}
                                onPress={() => onSelectIntent(nextIntent)}
                                style={({ pressed }) => ({
                                    paddingVertical: 8,
                                    paddingHorizontal: 10,
                                    borderRadius: 10,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    backgroundColor: theme.colors.surfaceHigh,
                                    opacity: pressed ? 0.7 : 1,
                                })}
                            >
                                <Text style={{ color: selected ? theme.colors.text : theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
                                    {intentLabel}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>

            {showPermissionModeSection ? (
                <View style={styles.section}>
                    <Text style={styles.label}>{t('executionRuns.newRun.sections.permissions')}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {visiblePermissionModeOptions.map((option) => {
                            const selected = selectedPermissionMode === option.value;
                            return (
                                <Pressable
                                    key={option.value}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('executionRuns.newRun.a11y.selectPermissionMode', { mode: option.label })}
                                    onPress={() => {
                                        setStartError(null);
                                        setActionInput((previous) => ({
                                            ...previous,
                                            ...setValueAtTopLevelPatch(previous, 'permissionMode', option.value),
                                        }));
                                    }}
                                    style={({ pressed }) => ({
                                        paddingVertical: 8,
                                        paddingHorizontal: 10,
                                        borderRadius: 10,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                        backgroundColor: theme.colors.surfaceHigh,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Text style={{ color: selected ? theme.colors.text : theme.colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
                                        {option.label}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>
            ) : null}

            <View style={styles.section}>
                <ActionInputFields
                    fields={fields as any}
                    input={actionInput}
                    editable={!isStarting}
                    resolveFieldOptions={(field) => resolveFieldOptions(field as any)}
                    resolveFieldTestID={(field) => (field.path === 'instructions' ? 'execution-run-new-instructions-input' : undefined)}
                    getChipAccessibilityLabel={({ field, option }) => {
                        if (field.path === 'engineIds' || field.path === 'backendTargetKeys') {
                            return t('executionRuns.newRun.a11y.toggleBackend', { backendId: option.label });
                        }
                        return undefined;
                    }}
                    onPatch={(patch) => {
                        setStartError(null);
                        const normalizedPatch =
                            intent !== 'review' && Array.isArray((patch as any).backendTargetKeys) && (patch as any).backendTargetKeys.length > 1
                                ? { ...patch, backendTargetKeys: [(patch as any).backendTargetKeys.at(-1)] }
                                : patch;
                        setActionInput((previous) => ({ ...previous, ...normalizedPatch }));
                    }}
                />
            </View>

            <View style={styles.actionRow}>
                <Pressable
                    testID="execution-run-new-start-button"
                    accessibilityRole="button"
                    accessibilityLabel={t('executionRuns.newRun.a11y.startRun')}
                    onPress={() => void onStart()}
                    disabled={!canStart}
                    style={({ pressed }) => [styles.actionButton, { opacity: !canStart ? 0.5 : pressed ? 0.7 : 1 }]}
                >
                    <Text style={styles.primaryActionText}>
                        {isStarting ? `${t('executionRuns.newRun.actions.start')}…` : t('executionRuns.newRun.actions.start')}
                    </Text>
                </Pressable>
                <Pressable
                    testID="execution-run-new-cancel-button"
                    accessibilityRole="button"
                    accessibilityLabel={t('executionRuns.newRun.a11y.cancel')}
                    onPress={closeSurface}
                    style={({ pressed }) => [styles.actionButton, { opacity: pressed ? 0.7 : 1 }]}
                >
                    <Text style={styles.secondaryActionText}>
                        {props.presentation === 'panel' ? t('common.close') : t('common.cancel')}
                    </Text>
                </Pressable>
            </View>

            {startError ?? validationError ? <Text style={styles.errorText}>{startError ?? validationError}</Text> : null}

            {guidancePreview ? (
                <View style={styles.section}>
                    <Text style={styles.guidanceLabel}>{t('executionRuns.newRun.guidancePreview')}</Text>
                    <Text style={styles.guidanceText}>{guidancePreview}</Text>
                </View>
            ) : null}
        </View>
    );
});
