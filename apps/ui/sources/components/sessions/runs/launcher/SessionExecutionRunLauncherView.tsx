import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    buildBackendTargetKey,
    buildBackendTargetKeyV2,
    convertBackendTargetRefV2ToV1,
    type EffectiveActionInputField,
    getActionSpec,
    resolveEffectiveActionInputFields,
} from '@happier-dev/protocol';

import { buildResumeSessionExtrasFromUiState, isBundledAgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import {
    isSessionRouteHydrationAvailable,
    isSessionRouteHydrationMissing,
    type SessionRouteHydrationState,
} from '@/sync/domains/session/sessionRouteHydrationState';
import { Text } from '@/components/ui/text/Text';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { useSession, useSettings } from '@/sync/domains/state/storage';
import { buildExecutionRunsGuidanceBlock, coerceExecutionRunsGuidanceEntries } from '@/sync/domains/settings/executionRunsGuidance';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resumeSession } from '@/sync/ops/sessions';
import { t } from '@/text';
import { resolveActionInputValidationError } from '@/sync/domains/actions/resolveActionInputValidationError';
import { resolveExecutionRunLauncherContainerStyle } from './resolveExecutionRunLauncherContainerStyle';
import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';
import { extractExecutionRunProfilesFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import {
    doesExecutionRunProfileMatchSelectedBackends,
    resolveExecutionRunLauncherProfileChoices,
} from './resolveExecutionRunLauncherProfileChoices';
import { ExecutionRunProfilePicker } from './ExecutionRunProfilePicker';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { normalizeActionInputPatch } from '@/sync/domains/actions/normalizeActionInputPatch';
import { resolveExecutionRunActionDefaultPermissionMode } from '@/sync/domains/actions/resolveExecutionRunActionDefaultPermissionMode';
import { resolveExecutionRunActionAllowedPermissionModes } from '@/sync/domains/actions/resolveExecutionRunActionAllowedPermissionModes';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { ActionInputFields, getValueAtPath, setValueAtTopLevelPatch, type ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

import {
    EXECUTION_RUN_LAUNCH_INTENTS,
    resolveExecutionRunLauncherActionId,
    type ExecutionRunIntent,
} from './executionRunLauncherModel';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    section: {
        gap: 8,
    },
    label: {
        color: theme.colors.text.secondary,
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
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    primaryActionText: {
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
    secondaryActionText: {
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    errorText: {
        color: theme.colors.status?.error ?? theme.colors.state.danger.foreground ?? theme.colors.text.primary,
    },
    guidanceLabel: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '600',
    },
    guidanceText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
}));

type SessionExecutionRunLauncherViewProps = Readonly<{
    sessionId: string;
    scopeId?: string;
    initialIntent?: ExecutionRunIntent;
    presentation?: 'screen' | 'panel';
    onRequestClose?: () => void;
    routeHydrationState?: SessionRouteHydrationState;
}>;

type SessionExecutionRunLauncherContentProps = Omit<SessionExecutionRunLauncherViewProps, 'routeHydrationState'> & Readonly<{
    routeHydrationState: SessionRouteHydrationState;
}>;

const SessionExecutionRunLauncherContent = React.memo((props: SessionExecutionRunLauncherContentProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const hydrateReady = isSessionRouteHydrationAvailable(props.routeHydrationState);
    const hydrateMissing = isSessionRouteHydrationMissing(props.routeHydrationState);
    const session = useSession(props.sessionId);
    const settings = useSettings();
    const enabledAgentIds = useEnabledAgentIds();
    const { canLaunchExecutionRuns, canShowExecutionRunLauncher, executionRunsBackends, sessionServerId } =
        useSessionExecutionRunLaunchability(props.sessionId, session);
    const { machineReachable } = useSessionMachineReachability(props.sessionId);
    const machineTarget = useSessionMachineTarget(props.sessionId);
    const machineId = React.useMemo(
        () => machineTarget?.machineId ?? resolveSessionMachineId((session as any)?.metadata),
        [machineTarget?.machineId, (session as any)?.metadata],
    );
    const agentId = React.useMemo(
        () => {
            const fromMetadata = resolveAgentIdFromSessionMetadata((session as any)?.metadata);
            if (fromMetadata) return fromMetadata;
            const agent = typeof (session as any)?.metadata?.agent === 'string'
                ? (session as any).metadata.agent.trim()
                : '';
            return agent || null;
        },
        [session],
    );
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId,
        settings,
        enabled: session?.active === false,
    });
    const { state: machineCapabilitiesState } = useMachineCapabilitiesCache({
        machineId,
        enabled: Boolean(machineId),
        ...(sessionServerId ? { serverId: sessionServerId } : {}),
        request: { requests: [{ id: 'tool.executionRuns', params: { sessionId: props.sessionId } }] } as any,
    });

    const initialIntent = props.initialIntent ?? 'review';
    const sessionActionDefaultBackend = React.useMemo(
        () => resolveSessionActionDefaultBackend({
            session,
            enabledAgentIds,
            fallbackAgentId: agentId ?? undefined,
        }),
        [agentId, enabledAgentIds, session],
    );
    const [intent, setIntent] = React.useState<ExecutionRunIntent>(initialIntent);
    const initialBackendTarget = React.useMemo(
        () => sessionActionDefaultBackend?.backendTarget ?? null,
        [sessionActionDefaultBackend],
    );
    const initialDefaultBackendId = sessionActionDefaultBackend?.defaultBackendId ?? null;
    const [isStarting, setIsStarting] = React.useState(false);
    const [startError, setStartError] = React.useState<string | null>(null);

    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: sessionServerId ?? null,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });

    const backendChoices = React.useMemo(() => {
        if (!executionRunsBackends || Object.keys(executionRunsBackends).length === 0) return [];
        return resolveExecutionRunLauncherBackendChoices({
            enabledAgentIds,
            executionRunsBackends,
            acpCatalogSettingsV1: (settings as any)?.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
            intent,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
        });
    }, [
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
        executionRunsBackends,
        intent,
        settings,
    ]);

    const executionRunProfiles = React.useMemo(
        () => extractExecutionRunProfilesFromMachineCapabilitiesState(machineCapabilitiesState),
        [machineCapabilitiesState],
    );
    const profileChoices = React.useMemo(
        () => resolveExecutionRunLauncherProfileChoices({
            intent,
            profiles: executionRunProfiles,
            backendChoices,
        }),
        [backendChoices, executionRunProfiles, intent],
    );

    const initialBackendTargetKey = React.useMemo(() => {
        if (!initialBackendTarget) return null;
        const targetKey = buildBackendTargetKey(convertBackendTargetRefV2ToV1(initialBackendTarget) as any);
        return backendChoices.some((choice) => choice.targetKey === targetKey && choice.disabled !== true) ? targetKey : null;
    }, [backendChoices, initialBackendTarget]);

    const buildSeedInput = React.useCallback((nextIntent: ExecutionRunIntent, previousInput?: Record<string, unknown> | null) => {
        const actionId = resolveExecutionRunLauncherActionId(nextIntent);
        const previousInstructions = typeof getValueAtPath(previousInput ?? {}, 'instructions') === 'string'
            ? String(getValueAtPath(previousInput ?? {}, 'instructions'))
            : '';
        return buildExecutionRunActionDraftInputForUi({
            actionId: actionId as any,
            sessionId: props.sessionId,
            defaultBackendTarget: nextIntent === 'review' ? null : initialBackendTarget,
            defaultBackendId: initialDefaultBackendId,
            instructions: previousInstructions,
        });
    }, [initialBackendTarget, initialDefaultBackendId, props.sessionId]);

    const [actionInput, setActionInput] = React.useState<Record<string, unknown>>(() => buildSeedInput(initialIntent));
    const selectedProfileId = typeof actionInput.profileId === 'string' ? actionInput.profileId : '';
    const selectedProfileGenerationId = typeof actionInput.profileGenerationId === 'string'
        ? actionInput.profileGenerationId
        : '';
    const selectedProfileChoice = profileChoices.find((choice) => (
        choice.id === selectedProfileId && choice.generationId === selectedProfileGenerationId
    )) ?? null;
    const actionId = resolveExecutionRunLauncherActionId(intent);
    const actionSpec = React.useMemo(() => getActionSpec(actionId as any), [actionId]);
    const fields = React.useMemo(
        () => resolveEffectiveActionInputFields(actionSpec as any, { sessionId: props.sessionId, ...actionInput }),
        [actionInput, actionSpec, props.sessionId],
    );

    const reviewEngineOptions = React.useMemo<readonly ActionFieldOption[]>(() => {
        if (intent !== 'review') {
            return [];
        }
        return backendChoices.map((choice) => ({
            value: choice.backendId,
            label: choice.title,
            ...(choice.disabled ? { disabled: true as const } : {}),
        }));
    }, [backendChoices, intent]);

    const executionBackendOptions = React.useMemo<readonly ActionFieldOption[]>(() => {
        return backendChoices.map((choice) => ({
            value: choice.targetKey,
            label: choice.title,
            ...(choice.disabled ? { disabled: true as const } : {}),
        }));
    }, [backendChoices]);

    const resolveFieldOptions = React.useCallback((field: EffectiveActionInputField): readonly ActionFieldOption[] => {
        const sourceId = typeof field?.optionsSourceId === 'string' ? field.optionsSourceId : '';
        if (sourceId === 'review.engines.available') return reviewEngineOptions;
        if (sourceId === 'execution.backends.enabled') return executionBackendOptions;
        return field.options ?? [];
    }, [executionBackendOptions, reviewEngineOptions]);

    const selectedBackendChoices = React.useMemo(() => {
        const fieldPath = intent === 'review' ? 'engineIds' : 'backendTargetKeys';
        const selectedValues = Array.isArray(getValueAtPath(actionInput, fieldPath))
            ? (getValueAtPath(actionInput, fieldPath) as unknown[]).map(String)
            : [];
        return backendChoices.filter((choice) => selectedValues.includes(choice.targetKey) || selectedValues.includes(choice.backendId));
    }, [actionInput, backendChoices, intent]);
    const selectedProfileMatchesSelectedBackend = !selectedProfileChoice || doesExecutionRunProfileMatchSelectedBackends(
        selectedProfileChoice,
        selectedBackendChoices.map((choice) => choice.backendId),
    );

    const permissionModeOptions = React.useMemo(() => {
        const rawAgentType = selectedBackendChoices[0] && isBundledAgentId(selectedBackendChoices[0].backendId)
            ? selectedBackendChoices[0].backendId
            : sessionActionDefaultBackend?.defaultBackendId
            ?? (session as any)?.metadata?.agent
            ?? enabledAgentIds[0]
            ?? null;
        if (typeof rawAgentType !== 'string') {
            return [];
        }
        return getPermissionModeOptionsForAgentType(rawAgentType as any);
    }, [enabledAgentIds, selectedBackendChoices, session, sessionActionDefaultBackend]);
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
        if (!selectedProfileId) return;
        if (
            selectedProfileChoice
            && selectedProfileChoice.disabled !== true
            && selectedProfileMatchesSelectedBackend
        ) return;
        setActionInput((previous) => {
            const next = { ...previous };
            delete next.profileId;
            delete next.profileGenerationId;
            return next;
        });
    }, [selectedProfileChoice, selectedProfileId, selectedProfileMatchesSelectedBackend]);

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

    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: () => sessionServerId,
        }),
        [sessionServerId],
    );
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
    const canStart = validationError === null
        && !isStarting
        && (!selectedProfileId || (
            selectedProfileChoice?.disabled === false && selectedProfileMatchesSelectedBackend
        ));

    const onSelectProfile = React.useCallback((choice: (typeof profileChoices)[number]) => {
        if (!choice.compatibleAgentId) return;
        const backendChoice = backendChoices.find((backend) => backend.backendId === choice.compatibleAgentId);
        if (!backendChoice || backendChoice.disabled) return;
        const backendField = intent === 'review' ? 'engineIds' : 'backendTargetKeys';
        const backendValue = intent === 'review' ? backendChoice.backendId : backendChoice.targetKey;
        setStartError(null);
        setActionInput((previous) => ({
            ...previous,
            profileId: choice.id,
            profileGenerationId: choice.generationId,
            ...setValueAtTopLevelPatch(previous, backendField, [backendValue]),
        }));
    }, [backendChoices, intent]);

    const resolveProfileAccessibilityLabel = React.useCallback(
        (title: string) => t('executionRuns.newRun.a11y.selectProfile', { profile: title }),
        [],
    );

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
                const modelOverride = sessionActionDefaultBackend
                    ? getModelOverrideForSpawn(
                        session,
                        buildBackendTargetKeyV2(sessionActionDefaultBackend.backendTarget),
                    )
                    : null;
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
                    ...(sessionServerId ? { serverId: sessionServerId } : {}),
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
        sessionServerId,
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

    if (hydrateMissing) {
        return <Text style={styles.label}>{t('common.unavailable')}</Text>;
    }

    if (!hydrateReady) {
        return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;
    }

    if (waitingForExecutionRunCapabilities) {
        return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;
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
                                    borderColor: theme.colors.border.default,
                                    backgroundColor: theme.colors.surface.inset,
                                    opacity: pressed ? 0.7 : 1,
                                })}
                            >
                                <Text style={{ color: selected ? theme.colors.text.primary : theme.colors.text.secondary, fontSize: 12, fontWeight: '600' }}>
                                    {intentLabel}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>

            <ExecutionRunProfilePicker
                choices={profileChoices}
                selectedId={selectedProfileId}
                selectedGenerationId={selectedProfileGenerationId}
                sectionLabel={t('executionRuns.newRun.sections.profiles')}
                resolveAccessibilityLabel={resolveProfileAccessibilityLabel}
                onSelect={onSelectProfile}
            />

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
                                        borderColor: theme.colors.border.default,
                                        backgroundColor: theme.colors.surface.inset,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Text style={{ color: selected ? theme.colors.text.primary : theme.colors.text.secondary, fontSize: 12, fontWeight: '600' }}>
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
                    fields={fields}
                    input={actionInput}
                    editable={!isStarting}
                    resolveFieldOptions={resolveFieldOptions}
                    resolveFieldTestID={(field) => (field.path === 'instructions' ? 'execution-run-new-instructions-input' : undefined)}
                    getChipAccessibilityLabel={({ field, option }) => {
                        if (field.path === 'engineIds' || field.path === 'backendTargetKeys') {
                            return t('executionRuns.newRun.a11y.toggleBackend', { backendId: option.label });
                        }
                        return undefined;
                    }}
                    onPatch={(patch) => {
                        setStartError(null);
                        const normalizedPatch = normalizeActionInputPatch({ actionId, patch });
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

const SessionExecutionRunLauncherOwnHydration = React.memo((props: Omit<SessionExecutionRunLauncherViewProps, 'routeHydrationState'>) => {
    const routeHydrationState = useHydrateSessionForRoute(props.sessionId, 'SessionExecutionRunLauncherView.hydrate');
    return <SessionExecutionRunLauncherContent {...props} routeHydrationState={routeHydrationState} />;
});

export const SessionExecutionRunLauncherView = React.memo((props: SessionExecutionRunLauncherViewProps) => {
    const { routeHydrationState, ...launcherProps } = props;
    if (routeHydrationState) {
        return <SessionExecutionRunLauncherContent {...launcherProps} routeHydrationState={routeHydrationState} />;
    }
    return <SessionExecutionRunLauncherOwnHydration {...launcherProps} />;
});
