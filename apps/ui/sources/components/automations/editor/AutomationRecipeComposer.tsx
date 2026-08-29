import * as React from 'react';
import { View } from 'react-native';
import {
    ExecutionRunDetachedStartRequestV1Schema,
    SessionServerStartSpawnDraftV1Schema,
    pluginJsonValuesEqual,
    type AutomationRunExecutionTargetV1,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectionList, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { composeSessionServerStartDraft } from '@/components/sessions/new/serverStartDraftComposer';
import { presentSessionServerStartDraftComposer } from '@/components/sessions/new/serverStartDraftComposerPresentation';
import { resolveExecutionRunLauncherBackendChoices } from '@/components/sessions/runs/launcher/resolveExecutionRunLauncherBackendChoices';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import { openAutomationRecipeForAuthoring, buildAutomationRecipeFromSessionAuthoring } from '@/sync/domains/automations/automationRecipeAuthoring';
import { replaceAutomationEditorExecutionRecipe, type AutomationEditorDraft } from '@/sync/domains/automations/automationEditorDraft';
import { isAutomationSessionCandidate } from '@/sync/domains/automations/isAutomationSessionCandidate';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage, useSessions, useSettings } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { Modal } from '@/modal';

export function buildAutomationExecutionRunTarget(params: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    permissionMode: 'no_tools' | 'read_only';
}>): Extract<AutomationRunExecutionTargetV1, Readonly<{ kind: 'executionRun' }>> {
    return {
        kind: 'executionRun',
        request: ExecutionRunDetachedStartRequestV1Schema.parse({
            intent: 'task',
            backendTarget: params.backendTarget,
            permissionMode: params.permissionMode,
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        }),
    };
}

export function sessionCanBeAutomationExecutionTarget(
    draft: AutomationEditorDraft,
    sessionId: string,
): boolean {
    return !draft.triggers.some((trigger) => (
        trigger.definition?.kind === 'sessionLifecycle'
        && trigger.definition.scope.sourceSessionId === sessionId
    ));
}

export function AutomationRecipeComposer(props: Readonly<{
    value: AutomationEditorDraft;
    onChange: (value: AutomationEditorDraft) => void;
}>): React.ReactElement {
    const sessions = useSessions() ?? [];
    const settings = useSettings();
    const enabledAgentIds = useEnabledAgentIds();
    const activeServer = useActiveServerSnapshot();
    const enabledAssignments = props.value.assignments.filter((assignment) => assignment.enabled);
    const machineId = enabledAssignments.length === 1 ? enabledAssignments[0]!.machineId : null;
    const [picker, setPicker] = React.useState<'none' | 'existingSession' | 'executionRun'>('none');
    const [changing, setChanging] = React.useState(false);
    const mountedRef = React.useRef(true);
    const latestValueRef = React.useRef(props.value);
    latestValueRef.current = props.value;
    React.useEffect(() => () => { mountedRef.current = false; }, []);
    const { state: capabilities } = useMachineCapabilitiesCache({
        machineId,
        serverId: activeServer.serverId,
        enabled: Boolean(machineId),
        request: { requests: [{ id: 'tool.executionRuns' }] },
    });
    const projection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: activeServer.serverId,
        enabled: Boolean(machineId),
    });
    const executionRunsBackends = extractExecutionRunsBackendsFromMachineCapabilitiesState(capabilities);
    const backendChoices = React.useMemo(() => resolveExecutionRunLauncherBackendChoices({
        enabledAgentIds,
        executionRunsBackends,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        intent: 'task',
        mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById ?? null,
    }).filter((choice) => !choice.disabled), [
        enabledAgentIds,
        executionRunsBackends,
        projection.inputs?.mergedBackendProjectionById,
        projection.inputs?.mergedProviderProjectionById,
        settings,
    ]);
    const existingSessionOptions = React.useMemo<readonly SelectionListOption[]>(() => sessions
        .filter((session) => (
            session.serverId === activeServer.serverId
            && isAutomationSessionCandidate(session, settings)
        ))
        .map((session) => ({
            id: session.id,
            label: getSessionName(session),
            disabled: !sessionCanBeAutomationExecutionTarget(props.value, session.id),
        })), [activeServer.serverId, props.value, sessions, settings]);
    const existingSessionStep = React.useMemo<SelectionListStep>(() => ({
        id: 'automation-recipe-existing-session',
        inputPlaceholder: t('sessionsList.searchSessionsPlaceholder'),
        sections: [{ kind: 'static', id: 'sessions', options: existingSessionOptions, virtualization: 'force' }],
    }), [existingSessionOptions]);
    const backendStep = React.useMemo<SelectionListStep>(() => ({
        id: 'automation-recipe-execution-backend',
        sections: [{
            kind: 'static',
            id: 'backends',
            options: backendChoices.map((choice) => ({ id: choice.targetKey, label: choice.title })),
            virtualization: 'force',
        }],
    }), [backendChoices]);

    const applyTarget = React.useCallback(async (target: AutomationRunExecutionTargetV1) => {
        const credentials = sync.getCredentials();
        if (!credentials) return;
        const captured = props.value;
        if (target.kind === 'existingSession') {
            const candidate = storage.getState().sessions[target.sessionId];
            if (
                !candidate
                || candidate.serverId !== getActiveServerSnapshot().serverId
                || !isAutomationSessionCandidate(candidate, storage.getState().settings)
                || !sessionCanBeAutomationExecutionTarget(captured, target.sessionId)
            ) return;
        }
        if (pluginJsonValuesEqual(captured.executionRecipe.target, target)) {
            setPicker('none');
            return;
        }
        setChanging(true);
        try {
            const program = await openAutomationRecipeForAuthoring({
                recipe: captured.executionRecipe,
                ...(sync.encryption ? {
                    decryptRaw: (ciphertext: string) => sync.encryption!.decryptAutomationTemplateRaw(ciphertext),
                } : {}),
                isCurrent: () => mountedRef.current && latestValueRef.current === captured,
            });
            const recipe = await buildAutomationRecipeFromSessionAuthoring({
                credentials,
                templateVersion: captured.expectedTemplateVersion === null
                    ? captured.executionRecipe.templateVersion
                    : captured.expectedTemplateVersion + 1,
                prompt: program.prompt,
                mentions: program.mentions,
                target,
                ...(sync.encryption ? {
                    encryptRaw: (value: unknown) => sync.encryption!.encryptAutomationTemplateRaw(value),
                } : {}),
                isCurrent: () => mountedRef.current && latestValueRef.current === captured,
            });
            if (mountedRef.current && latestValueRef.current === captured) {
                props.onChange(replaceAutomationEditorExecutionRecipe(captured, recipe));
                setPicker('none');
            }
        } catch (error) {
            if (mountedRef.current && latestValueRef.current === captured) {
                await Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : t('automations.edit.updateFailed'),
                );
            }
        } finally {
            if (mountedRef.current) setChanging(false);
        }
    }, [props]);

    const chooseNewSession = React.useCallback(async () => {
        if (!machineId || !activeServer.serverId || changing) return;
        const currentSpawn = props.value.executionRecipe.target.kind === 'newSession'
            ? props.value.executionRecipe.target.spawn
            : null;
        setChanging(true);
        try {
            const outcome = await composeSessionServerStartDraft({
                target: { serverId: activeServer.serverId, machineId },
                draft: currentSpawn ? {
                    directory: currentSpawn.directory,
                    agentId: currentSpawn.agentTarget.identity.localId,
                    executionTarget: currentSpawn.executionTarget,
                    ...(currentSpawn.permissionMode ? { permissionMode: currentSpawn.permissionMode } : {}),
                    ...(currentSpawn.profileId ? { profileId: currentSpawn.profileId } : {}),
                } : undefined,
                isCurrent: () => mountedRef.current,
                present: presentSessionServerStartDraftComposer,
            });
            if (outcome.kind === 'submitted') {
                const spawn = SessionServerStartSpawnDraftV1Schema.parse({
                    ...(currentSpawn ?? {}),
                    ...outcome.draft,
                });
                await applyTarget({ kind: 'newSession', spawn });
            }
        } finally {
            if (mountedRef.current) setChanging(false);
        }
    }, [activeServer.serverId, applyTarget, changing, machineId, props.value.executionRecipe.target]);

    const target = props.value.executionRecipe.target;
    return (
        <ItemGroup title={t('automations.form.trigger.target')}>
            {(['newSession', 'existingSession', 'executionRun'] as const).map((kind) => (
                <Item
                    key={kind}
                    testID={`automation-recipe-target-${kind}`}
                    title={kind === 'newSession'
                        ? t('automations.form.trigger.targetNewSession')
                        : kind === 'existingSession'
                            ? t('automations.form.trigger.targetExistingSession')
                            : t('automations.form.trigger.targetExecutionRun')}
                    selected={target.kind === kind}
                    disabled={changing || (kind !== 'existingSession' && !machineId)}
                    onPress={kind === 'newSession'
                        ? () => { void chooseNewSession(); }
                        : () => setPicker(kind)}
                    showChevron={kind !== 'newSession'}
                />
            ))}
            {picker === 'existingSession' ? (
                <View>
                    <SelectionList
                        testID="automation-recipe-existing-session-picker"
                        rootStep={existingSessionStep}
                        selectedOptionId={target.kind === 'existingSession' ? target.sessionId : null}
                        listAccessibilityLabel={t('automations.form.trigger.chooseExistingSession')}
                        onSelect={(sessionId) => { void applyTarget({ kind: 'existingSession', sessionId }); }}
                        onRequestClose={() => setPicker('none')}
                        maxHeight={360}
                        autoFocusInputOnWeb
                    />
                </View>
            ) : null}
            {picker === 'executionRun' ? (
                <View>
                    <SelectionList
                        testID="automation-recipe-execution-backend-picker"
                        rootStep={backendStep}
                        listAccessibilityLabel={t('automations.form.trigger.targetExecutionRun')}
                        onSelect={(targetKey) => {
                            const backend = backendChoices.find((choice) => choice.targetKey === targetKey);
                            if (!backend) return;
                            void applyTarget(buildAutomationExecutionRunTarget({
                                backendTarget: backend.backendTarget,
                                permissionMode: target.kind === 'executionRun'
                                    ? target.request.permissionMode
                                    : 'read_only',
                            }));
                        }}
                        onRequestClose={() => setPicker('none')}
                        maxHeight={360}
                        autoFocusInputOnWeb
                    />
                </View>
            ) : null}
            {target.kind === 'executionRun' ? (
                <>
                    <Item
                        testID="automation-recipe-execution-permission-no-tools"
                        title={t('automations.form.trigger.executionNoTools')}
                        selected={target.request.permissionMode === 'no_tools'}
                        onPress={() => { void applyTarget({
                            kind: 'executionRun',
                            request: { ...target.request, permissionMode: 'no_tools' },
                        }); }}
                        disabled={changing}
                        showChevron={false}
                    />
                    <Item
                        testID="automation-recipe-execution-permission-read-only"
                        title={t('automations.form.trigger.executionReadOnly')}
                        selected={target.request.permissionMode === 'read_only'}
                        onPress={() => { void applyTarget({
                            kind: 'executionRun',
                            request: { ...target.request, permissionMode: 'read_only' },
                        }); }}
                        disabled={changing}
                        showChevron={false}
                    />
                </>
            ) : null}
        </ItemGroup>
    );
}
