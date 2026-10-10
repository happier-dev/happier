import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { useRemoteSshBootstrapTask, type RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import type { PlanChecklistItem } from '@/components/systemTasks/planChecklist';
import { usePlanChecklistController } from '@/components/systemTasks/planChecklist';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useRemoteHostCatalogSnapshot } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { withRemoteHostSshConfig, runRemoteHostRelayAccessTask } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { startAdmittedRemoteHostSystemTask } from '@/components/settings/remoteHosts/remoteHostTaskOperations';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseSshTarget } from '@happier-dev/protocol/ssh/sshTarget';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverridesStore } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { applyConfiguredSshHostSuggestionToDraft, createDefaultSshCredentialsDraft, isSshCredentialsDraftReady, parseSshPortNumber } from '@/components/ssh/sshCredentialsDraft';
import { filterConfiguredSshHostSuggestions, type SshConfiguredHostSuggestion } from '@/components/ssh/filterConfiguredSshHostSuggestions';
import { useConfiguredSshHostSuggestions } from '@/components/ssh/useConfiguredSshHostSuggestions';
import { isLoopbackServerUrl } from '@/sync/domains/server/url/serverUrlClassification';

import { buildRemoteSshChecklistItems } from './buildRemoteSshChecklistItems';
import { mapRemoteSshTaskToChecklistExecution } from './mapRemoteSshTaskToChecklistExecution';
import { getRemoteSshChecklistCopy } from './copy';
import type { RemoteSshChecklistMode, RemoteSshChecklistPhase } from './types';
import { remoteSshChecklistStyles } from './styles';
import { RemoteSshChecklistPromptCard } from './RemoteSshChecklistPromptCard';
import { RemoteSshChecklistCredentialsPhase } from './RemoteSshChecklistCredentialsPhase';
import { RemoteSshChecklistPlanPhase } from './RemoteSshChecklistPlanPhase';
import { RemoteSshChecklistExecutionPhase } from './RemoteSshChecklistExecutionPhase';
import { RemoteSshChecklistCompletePhase } from './RemoteSshChecklistCompletePhase';
import { resolveRemoteSshBootstrapFormState, buildRemoteSshBootstrapFormStateFromSshConfig } from './resolveRemoteSshBootstrapFormState';
import { persistRemoteHostAfterRemoteSshCompletion } from './persistRemoteHostAfterRemoteSshCompletion';

const SAVED_REMOTE_HOST_NEW_ID = '__new__';
const EMPTY_REMOTE_HOSTS: readonly RemoteHost[] = [];

function buildRemoteHostDraftFromHost(remoteHost: RemoteHost): SshCredentialsDraft {
    const parsed = parseSshTarget(remoteHost.ssh.target);
    const username = String(parsed.username ?? '').trim();
    const host = String(parsed.host ?? '').trim();
    const port = typeof remoteHost.ssh.port === 'number' && Number.isFinite(remoteHost.ssh.port) ? String(remoteHost.ssh.port) : '';
    const authMode = remoteHost.ssh.authMode;

    const identityFilePath = (() => {
        try {
            const overrides = getRemoteHostLocalOverridesStore().get(remoteHost.id);
            const value = overrides?.identityFilePath;
            return typeof value === 'string' ? value : '';
        } catch {
            return '';
        }
    })();

    return {
        username,
        host,
        port,
        authMode,
        identityFilePath,
        password: '',
    };
}

function toPlanChecklistItem(
    item: Readonly<{
        id: string;
        title: string;
        subtitle: string;
        satisfied?: boolean;
        selected: boolean;
        disabled: boolean;
        optional: boolean;
        details: string;
    }>,
    params: Readonly<{ defaultSelected?: boolean }> = {},
): PlanChecklistItem {
    return {
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        satisfied: item.satisfied ?? false,
        disabled: item.disabled,
        defaultSelected: params.defaultSelected ?? item.selected,
        badge: item.optional ? t('common.optional') : undefined,
        details: item.details,
    };
}

function resolveRemoteRelayCompletionUrl(params: Readonly<{
    publicRelayUrl?: string | null;
    relayRuntimeUrl?: string | null;
}>): string | null {
    const publicRelayUrl = typeof params.publicRelayUrl === 'string' ? params.publicRelayUrl.trim() : '';
    if (publicRelayUrl.length > 0 && !isLoopbackServerUrl(publicRelayUrl)) {
        return publicRelayUrl;
    }

    const relayRuntimeUrl = typeof params.relayRuntimeUrl === 'string' ? params.relayRuntimeUrl.trim() : '';
    if (relayRuntimeUrl.length > 0 && !isLoopbackServerUrl(relayRuntimeUrl)) {
        return relayRuntimeUrl;
    }

    return null;
}

function buildRelayAccessTargetFromResolvedFormState(params: Readonly<{
    sshUsername: string;
    sshHost: string;
    sshPort: string;
    sshAuth: 'agent' | 'keyfile' | 'password';
    sshPassword: string;
    identityFilePath: string;
    addressOnly?: boolean;
}>): RelayAccessTaskTarget | null {
    const username = params.sshUsername.trim();
    const host = params.sshHost.trim();
    if (!host) {
        return null;
    }

    const target = username ? `${username}@${host}` : host;
    const portText = params.sshPort.trim();
    const port = parseSshPortNumber(portText);
    const password = params.sshPassword.trim();
    const identityFile = params.identityFilePath.trim();

    if (params.sshAuth === 'keyfile' && !identityFile) {
        return null;
    }
    if (params.sshAuth === 'password' && !password && !params.addressOnly) {
        return null;
    }

    return {
        kind: 'ssh',
        ssh: {
            target,
            auth: params.sshAuth,
            ...(port !== null ? { port } : {}),
            ...(params.sshAuth === 'keyfile' ? { identityFile } : {}),
            ...(params.sshAuth === 'password' && !params.addressOnly ? { password } : {}),
        },
    };
}

export const RemoteSshChecklistStep = React.memo(function RemoteSshChecklistStep(props: Readonly<{
    testID?: string;
    mode: RemoteSshChecklistMode;
    relayUrl: string;
    webappUrl?: string;
    publicRelayUrl?: string;
    initialDraft?: Partial<SshCredentialsDraft>;
    initialInstallRelayRuntime?: boolean;
    runner?: SystemTaskRunner;
    onWizardPrimaryChange?: (state: Readonly<{ label: string; disabled: boolean; onPress: (() => void) | (() => Promise<void>) }> | null) => void;
    onWizardBackChange?: (state: Readonly<{ hidden?: boolean; label?: React.ReactNode; onPress?: () => void }> | null) => void;
    onWizardSkipChange?: (state: Readonly<{ hidden?: boolean; label?: React.ReactNode; disabled?: boolean; onPress?: () => void }> | null) => void;
    onRequestAdvance?: () => void;
    onCompleted?: (payload: Readonly<{
        machineId: string | null;
        relayRuntimeUrl: string | null;
        relayAccessTarget: RelayAccessTaskTarget | null;
        runWithRelayAccessTarget?: <T>(run: (target: RelayAccessTaskTarget, startSpec?: (spec: SystemTaskSpec) => Promise<string>, admittedUpstreamUrl?: string | null) => Promise<T>) => Promise<T>;
        mode: RemoteSshChecklistMode;
    }>) => void;
    onCancel?: () => void;
}>) {
    const styles = remoteSshChecklistStyles;
    const copy = React.useMemo(() => getRemoteSshChecklistCopy(props.mode), [props.mode]);
    const [phase, setPhase] = React.useState<RemoteSshChecklistPhase>('credentials');
    const supportedAuthModes = props.runner?.mode === 'native'
        ? (['keyfile', 'password'] as const)
        : undefined;
    const [draft, setDraft] = React.useState<SshCredentialsDraft>(() => ({
        ...createDefaultSshCredentialsDraft(props.runner?.mode === 'native' ? 'password' : 'agent'),
        ...(props.initialDraft ?? {}),
    }));
    const hostScope = useActiveServerAccountScope();
    const hostCatalog = useRemoteHostCatalogSnapshot(hostScope);
    const catalogHosts = hostCatalog?.data ?? EMPTY_REMOTE_HOSTS;
    const runner = props.runner ?? getSystemTasksRunner();
    const [hostPickerOpen, setHostPickerOpen] = React.useState(false);
    const [selectedSavedRemoteHostId, setSelectedSavedRemoteHostId] = React.useState<string>(SAVED_REMOTE_HOST_NEW_ID);
    const savedDraftRef = React.useRef<SshCredentialsDraft>(draft);
    const completionHandledRef = React.useRef(false);
    const completionRelayAccessTargetRef = React.useRef<RelayAccessTaskTarget | null>(null);
    const runContextRef = React.useRef<Readonly<{
        selectedSavedRemoteHostId: string;
        saveHost: boolean;
        saveSecretMaterial: boolean;
        scope: ServerAccountScope | null;
        expectedRevision: number | 'absent' | null;
        host: RemoteHost | null;
        lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
    }> | null>(null);

    React.useEffect(() => {
        if (props.runner?.mode !== 'native') {
            return;
        }
        setDraft((current) => current.authMode === 'agent'
            ? { ...current, authMode: 'password' }
            : current);
    }, [props.runner?.mode]);

    const remoteHostsManagementEnabled = useFeatureEnabled('remoteHosts.management');
    const remoteHostsSecretMaterialEnabled = useFeatureEnabled('remoteHosts.secretMaterial');
    const canDiscoverConfiguredSshHosts = props.runner
        ? props.runner.mode === 'tauri'
        : isDesktopHost();
    const configuredHostSuggestions = useConfiguredSshHostSuggestions({
        ...(props.runner ? { runner: props.runner } : {}),
        enabled: canDiscoverConfiguredSshHosts,
    });

    const usableRemoteHosts = React.useMemo(
        () => (remoteHostsManagementEnabled ? catalogHosts : EMPTY_REMOTE_HOSTS),
        [remoteHostsManagementEnabled, catalogHosts],
    );
    const filteredConfiguredHostSuggestions = React.useMemo(() => filterConfiguredSshHostSuggestions({
        suggestions: configuredHostSuggestions.suggestions,
        remoteHosts: usableRemoteHosts,
    }), [configuredHostSuggestions.suggestions, usableRemoteHosts]);

    const [saveHost, setSaveHost] = React.useState(false);
    const saveHostInitializedRef = React.useRef(false);
    React.useEffect(() => {
        if (saveHostInitializedRef.current) return;
        if (!remoteHostsManagementEnabled) return;
        if (!isDesktopHost()) return;
        setSaveHost(true);
        saveHostInitializedRef.current = true;
    }, [remoteHostsManagementEnabled]);
    const [saveSecretMaterial, setSaveSecretMaterial] = React.useState(false);
    const [privateKeyMaterialDraft, setPrivateKeyMaterialDraft] = React.useState('');
    const [startErrorMessage, setStartErrorMessage] = React.useState<string | null>(null);

    React.useEffect(() => {
        // The secret-material toggle is auth-mode specific; clear it when switching modes.
        // Also clear any pasted private key content when leaving keyfile auth (avoid accidental persistence).
        setSaveSecretMaterial(false);
        if (draft.authMode !== 'keyfile') {
            setPrivateKeyMaterialDraft('');
        }
    }, [draft.authMode]);

    const remoteHostItems = React.useMemo((): DropdownMenuItem[] => ([
        { id: SAVED_REMOTE_HOST_NEW_ID, title: t('setupOnboarding.remoteHosts.newHostOption') },
        ...usableRemoteHosts.map((host) => ({
            id: host.id,
            title: host.name,
            subtitle: host.ssh.target,
        })),
    ]), [usableRemoteHosts]);

    const selectedSavedHost = React.useMemo(() => {
        if (selectedSavedRemoteHostId === SAVED_REMOTE_HOST_NEW_ID) return null;
        return usableRemoteHosts.find((host) => host.id === selectedSavedRemoteHostId) ?? null;
    }, [selectedSavedRemoteHostId, usableRemoteHosts]);
    const usingSavedHost = selectedSavedHost != null;

    const handleToggleSaveHost = React.useCallback(() => {
        setSaveHost((current) => {
            const next = !current;
            if (!next) {
                setSaveSecretMaterial(false);
            }
            return next;
        });
    }, []);

    const handleSelectSavedRemoteHostId = React.useCallback((itemId: string) => {
        setHostPickerOpen(false);
        if (itemId === SAVED_REMOTE_HOST_NEW_ID) {
            setSelectedSavedRemoteHostId(SAVED_REMOTE_HOST_NEW_ID);
            setDraft(savedDraftRef.current);
            return;
        }

        const selected = usableRemoteHosts.find((host) => host.id === itemId) ?? null;
        if (!selected) return;

        if (selectedSavedRemoteHostId === SAVED_REMOTE_HOST_NEW_ID) {
            savedDraftRef.current = draft;
        }

        setSelectedSavedRemoteHostId(itemId);
        setDraft(buildRemoteHostDraftFromHost(selected));
    }, [draft, selectedSavedRemoteHostId, usableRemoteHosts]);

    const handleSelectConfiguredHostSuggestion = React.useCallback((suggestion: SshConfiguredHostSuggestion) => {
        setHostPickerOpen(false);
        setSelectedSavedRemoteHostId(SAVED_REMOTE_HOST_NEW_ID);
        setDraft((current) => {
            const next = applyConfiguredSshHostSuggestionToDraft(current, suggestion);
            savedDraftRef.current = next;
            return next;
        });
    }, []);

    const {
        activeTaskSnapshot,
        answerPasswordPrompt,
        cancel,
        completedMachineId,
        continueAfterPrompt,
        declinePrompt,
        dismissPrompt,
        isStarting,
        prompt,
        resetPromptResolution,
        start,
    } = useRemoteSshBootstrapTask({
        ...(props.runner ? { runner: props.runner } : {}),
        relayUrl: props.relayUrl,
        webappUrl: props.webappUrl,
        publicRelayUrl: props.publicRelayUrl,
        serviceMode: props.mode === 'remoteRelayHost' ? 'none' : 'user',
        intent: props.mode === 'remoteRelayHost' ? 'personalHome.create' : 'machineSetup',
    });

    const runWithRemoteSshFormStateForExecution = React.useCallback(async <T,>(installRelayRuntime: boolean,
        run: (form: RemoteSshBootstrapFormState, startSpec?: (spec: SystemTaskSpec) => Promise<string>) => Promise<T>): Promise<T> => {
        if (selectedSavedRemoteHostId !== SAVED_REMOTE_HOST_NEW_ID) {
            if (!hostScope || !selectedSavedHost || !hostCatalog || hostCatalog.stale || hostCatalog.catalog.status !== 'ready'
                || hostCatalog.catalog.cleanup === 'pending' || typeof hostCatalog.catalog.revision !== 'number') {
                throw new Error('remote_host_catalog_unavailable');
            }
            const account = await captureLazyActionAccountContext(hostScope.serverId);
            try {
                if (account.accountId !== hostScope.accountId) throw new Error('action_account_scope_changed');
                return await withRemoteHostSshConfig(account, { hostId: selectedSavedHost.id, expectedRevision: hostCatalog.catalog.revision },
                    async ({ config, assertCurrent }) => {
                        const form = buildRemoteSshBootstrapFormStateFromSshConfig({ config: config.value, draft, installRelayRuntime });
                        assertCurrent();
                        return run(form, async spec => (await startAdmittedRemoteHostSystemTask({ runner, assertCurrent }, spec)).taskId);
                    });
            } finally { account.dispose(); }
        }
        const form = await resolveRemoteSshBootstrapFormState({
            draft,
            usingSavedHost,
            selectedSavedHost,
            privateKeyMaterialDraft,
            saveSecretMaterial,
            installRelayRuntime,
            remoteHostsSecretMaterialEnabled,
        });
        return run(form);
    }, [
        draft,
        privateKeyMaterialDraft,
        remoteHostsSecretMaterialEnabled,
        saveSecretMaterial,
        selectedSavedHost,
        usingSavedHost,
        selectedSavedRemoteHostId,
        hostCatalog,
        hostScope,
        runner,
    ]);

    const items = React.useMemo(() => buildRemoteSshChecklistItems({
        mode: props.mode,
    }), [props.mode]);
    const planItems = React.useMemo(() => items.map((item) => toPlanChecklistItem(item, {
        defaultSelected: item.id === 'install_relay_runtime'
            ? Boolean(props.initialInstallRelayRuntime ?? true)
            : undefined,
    })), [items, props.initialInstallRelayRuntime]);

    type RemoteSshChecklistExecutionPlan = Readonly<{ installRelayRuntime: boolean }>;

    const buildExecutionPlan = React.useCallback((selectedIds: readonly string[]): RemoteSshChecklistExecutionPlan => ({
        installRelayRuntime: selectedIds.includes('install_relay_runtime'),
    }), []);

    const runExecutionPlan = React.useCallback(async (
        plan: RemoteSshChecklistExecutionPlan,
        _publishSnapshot: (snapshot: SystemTaskRunState | null) => void,
    ) => {
        await runWithRemoteSshFormStateForExecution(plan.installRelayRuntime, async (formState, startSpec) => {
            completionRelayAccessTargetRef.current = buildRelayAccessTargetFromResolvedFormState({ ...formState, addressOnly: true });
            await start(formState, startSpec);
        });
    }, [runWithRemoteSshFormStateForExecution, start]);

    const mapExecutionSnapshotToRowState = React.useCallback((
        snapshot: SystemTaskRunState | null,
        _planItems: readonly PlanChecklistItem[],
        selectedIds: readonly string[],
    ) => mapRemoteSshTaskToChecklistExecution({
        snapshot,
        items,
        selectedIds,
        errorTitle: t('common.error'),
    }), [items]);

    const normalizePlanSelection = React.useCallback((selectedIds: readonly string[], nextItems: readonly PlanChecklistItem[]) => {
        return nextItems
            .filter((item) => selectedIds.includes(item.id) && !(item.satisfied && item.disabled))
            .map((item) => item.id);
    }, []);

    const checklist = usePlanChecklistController<RemoteSshChecklistExecutionPlan, SystemTaskRunState | null>({
        items: planItems,
        normalizeSelectedIds: normalizePlanSelection,
        buildExecutionPlan,
        runExecutionPlan,
        mapExecutionSnapshotToRowState,
        onCancelExecution: cancel,
    });

    const installRelayRuntimeSelected = React.useMemo(
        () => checklist.selectedIds.includes('install_relay_runtime'),
        [checklist.selectedIds],
    );

    React.useEffect(() => {
        if (phase !== 'execution') {
            return;
        }
        checklist.publishSnapshot(activeTaskSnapshot);
    }, [activeTaskSnapshot, checklist.publishSnapshot, phase]);
    const relayRuntimeResult = React.useMemo(() => {
        if (!activeTaskSnapshot?.result?.ok) {
            return null;
        }
        const relayRuntime = (activeTaskSnapshot.result.data as {
            relayRuntime?: { relayUrl?: unknown };
        } | undefined)?.relayRuntime;
        const relayUrl = typeof relayRuntime?.relayUrl === 'string' ? relayRuntime.relayUrl.trim() : '';
        return relayUrl.length > 0 ? relayUrl : null;
    }, [activeTaskSnapshot]);
    const completionRelayUrl = React.useMemo(() => {
        return resolveRemoteRelayCompletionUrl({
            publicRelayUrl: props.publicRelayUrl,
            relayRuntimeUrl: relayRuntimeResult,
        });
    }, [props.publicRelayUrl, relayRuntimeResult]);

    React.useEffect(() => {
        if (phase !== 'execution') {
            return;
        }
        if (activeTaskSnapshot?.result?.ok && !completionHandledRef.current) {
            completionHandledRef.current = true;
            const currentRun = runContextRef.current;
            let relayRevision = currentRun?.expectedRevision ?? null;
            const completion = {
                machineId: completedMachineId,
                relayRuntimeUrl: completionRelayUrl,
                relayAccessTarget: completionRelayAccessTargetRef.current,
                runWithRelayAccessTarget: async <T,>(run: (target: RelayAccessTaskTarget,
                    startSpec?: (spec: SystemTaskSpec) => Promise<string>, admittedUpstreamUrl?: string | null) => Promise<T>): Promise<T> => {
                    if (currentRun?.host && currentRun.scope && typeof relayRevision === 'number') {
                        if (!currentRun.lifetime?.isCurrent()) throw new Error('action_account_scope_changed');
                        return runRemoteHostRelayAccessTask({ scope: currentRun.scope, hostId: currentRun.host.id,
                            expectedRevision: relayRevision, run: (target, admittedUpstreamUrl, assertCurrent) => run(target,
                                async spec => (await startAdmittedRemoteHostSystemTask({ runner, assertCurrent }, spec)).taskId,
                                admittedUpstreamUrl) });
                    }
                    return runWithRemoteSshFormStateForExecution(installRelayRuntimeSelected, async form => {
                        const target = buildRelayAccessTargetFromResolvedFormState(form);
                        if (!target) throw new Error('relay_access_target_unavailable');
                        return run(target);
                    });
                },
                mode: props.mode,
            } as const;

            const persistence = persistRemoteHostAfterRemoteSshCompletion({
                managementEnabled: remoteHostsManagementEnabled,
                secretMaterialEnabled: remoteHostsSecretMaterialEnabled,
                scope: currentRun?.scope ?? null,
                expectedRevision: currentRun?.expectedRevision ?? null,
                host: currentRun?.host ?? undefined,
                assertCurrent: () => { if (currentRun?.scope && !currentRun.lifetime?.isCurrent()) throw new Error('action_account_scope_changed'); },
                selectedSavedRemoteHostId,
                runContext: currentRun,
                newHostSentinelId: SAVED_REMOTE_HOST_NEW_ID,
                draft,
                privateKeyMaterialDraft,
                completion: {
                    machineId: completion.machineId,
                    relayRuntimeUrl: completion.relayRuntimeUrl,
                },
            });
            persistence.then(
                result => {
                    if (result.ok && result.localOverrides !== 'retired') relayRevision = result.revision;
                    if (!result.ok && remoteHostsManagementEnabled && (currentRun?.saveHost || currentRun?.host)) {
                        setStartErrorMessage(t('errors.operationFailed'));
                    }
                    setPhase('complete');
                    if (result.ok && result.localOverrides !== 'retired' && currentRun?.scope) {
                        const scope = currentRun.scope;
                        const hostId = result.hostId;
                        const revision = result.revision;
                        const lifetime = currentRun.lifetime;
                        const runWithRelayAccessTarget = async <T,>(run: (target: RelayAccessTaskTarget,
                            startSpec?: (spec: SystemTaskSpec) => Promise<string>, admittedUpstreamUrl?: string | null) => Promise<T>): Promise<T> => {
                            if (!lifetime?.isCurrent()) throw new Error('action_account_scope_changed');
                            return runRemoteHostRelayAccessTask({ scope, hostId, expectedRevision: revision,
                                run: (target, admittedUpstreamUrl, assertCurrent) => run(target,
                                    async spec => (await startAdmittedRemoteHostSystemTask({ runner, assertCurrent }, spec)).taskId,
                                    admittedUpstreamUrl) });
                        };
                        setDraft(current => ({ ...current, password: '' }));
                        setPrivateKeyMaterialDraft('');
                        props.onCompleted?.({ ...completion, runWithRelayAccessTarget });
                    } else {
                        props.onCompleted?.(completion);
                    }
                },
                (error: unknown) => {
                    completionHandledRef.current = false;
                    setStartErrorMessage(error instanceof Error
                        ? error.message
                        : t('setupOnboarding.remoteSshChecklist.continueFailed'));
                },
            );
        }
    }, [
        activeTaskSnapshot?.result?.ok,
        completedMachineId,
        draft,
        phase,
        privateKeyMaterialDraft,
        props.mode,
        props.onCompleted,
        relayRuntimeResult,
        completionRelayUrl,
        remoteHostsManagementEnabled,
        remoteHostsSecretMaterialEnabled,
        runWithRemoteSshFormStateForExecution,
        installRelayRuntimeSelected,
        selectedSavedRemoteHostId,
    ]);

    const handleStartExecution = React.useCallback(async () => {
        setStartErrorMessage(null);
        resetPromptResolution();
        completionHandledRef.current = false;
        runContextRef.current = {
            selectedSavedRemoteHostId,
            saveHost,
            saveSecretMaterial,
            scope: hostScope,
            expectedRevision: hostCatalog && !hostCatalog.stale && hostCatalog.catalog.status === 'ready' && hostCatalog.catalog.cleanup !== 'pending'
                ? hostCatalog.catalog.revision : null,
            host: selectedSavedHost,
            lifetime: captureActiveServerAccountScopeLifetime(),
        };
        setPhase('execution');
        try {
            await checklist.continue();
        } catch (error) {
            setStartErrorMessage(error instanceof Error ? error.message : t('setupOnboarding.remoteSshChecklist.startFailed'));
            setPhase('plan');
            checklist.resetToSelect();
        }
    }, [
        checklist.continue,
        checklist.resetToSelect,
        completionHandledRef,
        resetPromptResolution,
        saveHost,
        saveSecretMaterial,
        selectedSavedRemoteHostId,
        selectedSavedHost,
        hostScope,
        hostCatalog,
    ]);

    const handleContinueAfterPrompt = React.useCallback(async () => {
        if (!prompt) return;
        setStartErrorMessage(null);
        try {
            await runWithRemoteSshFormStateForExecution(installRelayRuntimeSelected, async (formState, startSpec) => {
                if (prompt.kind === 'ssh.password') {
                    await answerPasswordPrompt(formState);
                    return;
                }
                await continueAfterPrompt(formState, startSpec);
            });
        } catch (error) {
            setStartErrorMessage(error instanceof Error ? error.message : t('setupOnboarding.remoteSshChecklist.continueFailed'));
        }
    }, [
        answerPasswordPrompt,
        continueAfterPrompt,
        installRelayRuntimeSelected,
        prompt,
        runWithRemoteSshFormStateForExecution,
    ]);

    const handleCopyDiagnostics = React.useCallback(async (itemId: string): Promise<boolean> => {
        const item = items.find((entry) => entry.id === itemId);
        const execution = checklist.executionById[itemId];
        if (!item || !execution) {
            return false;
        }

        const lines = [
            `Remote SSH checklist diagnostics (${props.mode})`,
            `Item: ${item.title}`,
            `Status: ${execution.status}`,
            item.details,
            ...execution.logs.map((entry) => entry.message),
            execution.error?.message ? `Error: ${execution.error.message}` : null,
        ].filter((line): line is string => Boolean(line && line.trim().length > 0));

        const copied = await setClipboardStringSafe(lines.join('\n'));
        if (!copied) {
            await Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
            return false;
        }
        return true;
    }, [checklist.executionById, items, props.mode]);

    const promptBlock = prompt ? (
        <RemoteSshChecklistPromptCard
            testID={props.testID ? `${props.testID}-prompt-password` : 'remote-ssh-checklist-prompt-password'}
            prompt={prompt}
            password={draft.password}
            isStarting={isStarting}
            onChangePassword={(nextPassword) => {
                setDraft((current) => ({ ...current, password: nextPassword }));
            }}
        />
    ) : null;

    const requestAdvanceRef = React.useRef(props.onRequestAdvance);
    React.useEffect(() => {
        requestAdvanceRef.current = props.onRequestAdvance;
    }, [props.onRequestAdvance]);

    React.useEffect(() => {
        if (phase === 'credentials') {
            props.onWizardBackChange?.(null);
            props.onWizardSkipChange?.(null);

            const credentialsReady = selectedSavedRemoteHostId !== SAVED_REMOTE_HOST_NEW_ID
                ? true
                : isSshCredentialsDraftReady(draft);
            props.onWizardPrimaryChange?.({
                label: t('common.continue'),
                disabled: !credentialsReady,
                onPress: () => setPhase('plan'),
            });
            return;
        }

        if (phase === 'plan') {
            props.onWizardBackChange?.({
                onPress: () => setPhase('credentials'),
            });
            props.onWizardSkipChange?.(null);
            props.onWizardPrimaryChange?.({
                label: t('common.continue'),
                disabled: !checklist.canContinue,
                onPress: async () => {
                    await handleStartExecution();
                },
            });
            return;
        }

        if (phase === 'complete') {
            props.onWizardBackChange?.({ hidden: true });
            props.onWizardSkipChange?.({ hidden: true });
            props.onWizardPrimaryChange?.({
                label: t('common.continue'),
                disabled: false,
                onPress: requestAdvanceRef.current ?? (() => undefined),
            });
            return;
        }

        // execution
        props.onWizardBackChange?.({ hidden: true });
        if (prompt) {
            props.onWizardSkipChange?.({
                hidden: false,
                // Declining either setup decision stops setup, so it is a
                // Cancel here exactly as in the SSH and this-computer modals.
                label: t('common.cancel'),
                disabled: isStarting,
                onPress: () => {
                    if (prompt.kind === 'daemon.replaceRemoteBackgroundServices'
                        || prompt.kind === 'releaseChannel.switchDefaultForSetup') {
                        void declinePrompt().catch((error) => {
                            setStartErrorMessage(error instanceof Error ? error.message : t('setupOnboarding.remoteSshChecklist.continueFailed'));
                        });
                        return;
                    }
                    dismissPrompt();
                },
            });

            const primaryLabel = prompt.kind === 'ssh.password'
                ? t('common.continue')
                : prompt.kind === 'auth.approveRemoteProvisioning'
                    ? t('settings.machineSetupRemotePromptApproveAction')
                    : prompt.kind === 'releaseChannel.switchDefaultForSetup'
                        ? t('common.continue')
                    : prompt.kind === 'daemon.replaceRemoteBackgroundServices'
                        ? t('settings.machineSetupRemotePromptReplaceServicesAction')
                    : prompt.kind === 'ssh.replaceHostKey'
                        ? t('settings.machineSetupRemotePromptReplaceAction')
                        : t('settings.machineSetupRemotePromptTrustAction');
            const passwordRequired = prompt.kind === 'ssh.password' && draft.password.trim().length === 0;
            props.onWizardPrimaryChange?.({
                label: primaryLabel,
                disabled: isStarting || passwordRequired,
                onPress: async () => {
                    await handleContinueAfterPrompt();
                },
            });
            return;
        }

        props.onWizardSkipChange?.({ hidden: true });
        if (activeTaskSnapshot?.result && !activeTaskSnapshot.result.ok) {
            props.onWizardPrimaryChange?.({
                label: t('common.retry'),
                disabled: isStarting,
                onPress: async () => {
                    setStartErrorMessage(null);
                    resetPromptResolution();
                    await checklist.retry();
                },
            });
            return;
        }
        props.onWizardPrimaryChange?.({
            label: t('common.continue'),
            disabled: true,
            onPress: () => undefined,
        });
    }, [
        activeTaskSnapshot?.result,
        checklist.canContinue,
        checklist.retry,
        declinePrompt,
        dismissPrompt,
        draft,
        handleContinueAfterPrompt,
        handleStartExecution,
        isStarting,
        phase,
        prompt,
        selectedSavedRemoteHostId,
        props.onWizardBackChange,
        props.onWizardPrimaryChange,
        props.onWizardSkipChange,
        resetPromptResolution,
    ]);

    React.useEffect(() => () => {
        props.onWizardPrimaryChange?.(null);
        props.onWizardBackChange?.(null);
        props.onWizardSkipChange?.(null);
    }, [props.onWizardBackChange, props.onWizardPrimaryChange, props.onWizardSkipChange]);

    if (phase === 'complete' && activeTaskSnapshot?.result?.ok) {
        return (
            <RemoteSshChecklistCompletePhase
                testID={props.testID}
                copy={copy}
                planItems={planItems}
                selectedIds={checklist.selectedIds}
                completionRelayUrl={completionRelayUrl}
            />
        );
    }

    if (phase === 'credentials') {
        return (
            <RemoteSshChecklistCredentialsPhase
                testID={props.testID}
                copy={copy}
                remoteHostsCount={usableRemoteHosts.length}
                hostPickerOpen={hostPickerOpen}
                onChangeHostPickerOpen={setHostPickerOpen}
                hostPickerItems={remoteHostItems}
                selectedHostPickerId={selectedSavedRemoteHostId}
                onSelectHostPickerId={handleSelectSavedRemoteHostId}
                usingSavedHost={usingSavedHost}
                configuredHostSuggestions={{
                    suggestions: filteredConfiguredHostSuggestions,
                    loading: configuredHostSuggestions.loading,
                    refreshing: configuredHostSuggestions.refreshing,
                    unsupported: configuredHostSuggestions.unsupported,
                    error: configuredHostSuggestions.error,
                }}
                onRefreshConfiguredHostSuggestions={configuredHostSuggestions.refresh}
                onSelectConfiguredHostSuggestion={handleSelectConfiguredHostSuggestion}
                draft={draft}
                onChangeDraft={(next) => {
                    savedDraftRef.current = next;
                    setDraft(next);
                }}
                supportedAuthModes={supportedAuthModes}
                remoteHostsManagementEnabled={remoteHostsManagementEnabled}
                remoteHostsSecretMaterialEnabled={remoteHostsSecretMaterialEnabled}
                saveHost={saveHost}
                onToggleSaveHost={handleToggleSaveHost}
                saveSecretMaterial={saveSecretMaterial}
                onToggleSaveSecretMaterial={() => setSaveSecretMaterial((current) => !current)}
                privateKeyMaterialDraft={privateKeyMaterialDraft}
                onChangePrivateKeyMaterialDraft={setPrivateKeyMaterialDraft}
            />
        );
    }

    if (phase === 'plan') {
        return (
            <RemoteSshChecklistPlanPhase
                testID={props.testID}
                copy={copy}
                planItems={planItems}
                selectedIds={checklist.selectedIds}
                expandedIds={checklist.expandedIds}
                onToggleItem={checklist.toggleItem}
                onToggleExpanded={checklist.toggleExpanded}
                startErrorMessage={startErrorMessage}
            />
        );
    }

    return (
        <RemoteSshChecklistExecutionPhase
            testID={props.testID}
            copy={copy}
            planItems={planItems}
            executionById={checklist.executionById}
            selectedIds={checklist.selectedIds}
            expandedIds={checklist.expandedIds}
            onToggleExpanded={checklist.toggleExpanded}
            onCopyDiagnostics={(item) => handleCopyDiagnostics(item.id)}
            promptBlock={promptBlock}
            startErrorMessage={startErrorMessage}
            activeTaskSnapshot={activeTaskSnapshot}
        />
    );
});
