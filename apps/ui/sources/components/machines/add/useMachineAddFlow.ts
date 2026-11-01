import * as React from 'react';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { t } from '@/text';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById, getServerProfilesGeneration, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { useRemoteHostCatalogSnapshot } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { getRemoteHostLocalOverridesStore } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { z } from 'zod/mini';
import type { MachineAddSshAnswerSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import { buildSshCredentialsDraftFromRemoteHostConfig } from '@/components/settings/remoteHosts/remoteHostOutcomeActions';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { confirmThisComputerAccountMove } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import { useThisComputerSetupPreflight } from '@/components/onboarding/checklists/setupThisComputer/useThisComputerSetupPreflight';
import { buildRemoteSshChecklistItems } from '@/components/onboarding/checklists/remoteSsh/buildRemoteSshChecklistItems';
import { mapRemoteSshTaskToChecklistExecution } from '@/components/onboarding/checklists/remoteSsh/mapRemoteSshTaskToChecklistExecution';
import { useAwaitedMachineArrival, type AwaitedMachineArrivalBaseline } from '@/components/onboarding/detection/useAwaitedMachineArrival';
import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { applyConfiguredSshHostSuggestionToDraft, createDefaultSshCredentialsDraft, isSshCredentialsDraftReady } from '@/components/ssh/sshCredentialsDraft';
import { useConfiguredSshHostSuggestions } from '@/components/ssh/useConfiguredSshHostSuggestions';
import { filterConfiguredSshHostSuggestions } from '@/components/ssh/filterConfiguredSshHostSuggestions';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { resolveRemoteSshBootstrapPrompt } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { buildThisComputerSetupStageModel } from '@/components/systemTasks/thisComputerSetup/buildThisComputerSetupStageModel';
import { mapThisComputerSetupExecutionToStages } from '@/components/systemTasks/thisComputerSetup/mapThisComputerSetupExecutionToStages';
import { resolveThisComputerSetupPrompt } from '@/components/systemTasks/thisComputerSetup/resolveThisComputerSetupPrompt';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { resolveSystemTaskStepLabel } from '@/components/systemTasks/resolveSystemTaskStepLabel';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { resolveLocalDeviceLabel } from '@/utils/platform/resolveLocalDeviceLabel';
import { resolveMachineAddInitialPath, type MachineAddPathId } from './machineAddPaths';
import { useMachineAddPaths } from './useMachineAddPaths';
import { buildMachineAddCommand, detectClientCommandOs, MACHINE_ADD_COMMAND_OS, type MachineAddCommandOs } from './machineAddCommand';
import { cancelMachineAddFlowTasks, discardMachineAddFlowDraft, readMachineAddFlowDraft, updateMachineAddFlowDraft, useMachineAddFlowDraft, useMachineAddFlowDraftSelector, type MachineAddTaskHandle } from './machineAddFlowStore';
import { beginMachineAddWatch, startMachineAddTask, hasRunningMachineAddTask as hasRunningTask } from './machineAddTaskLifetime';
import { getMachineAddSshSupportedAuthModes } from './machineAddSshTask';

export type MachineAddDraftRow = Readonly<{ title: string; entityTitle: string | null; status: string | null; tone: 'draft' | 'waiting' | 'running' | 'failed' | 'arrived' }>;
export type MachineAddStep = Readonly<{ id: string; label: string; state: 'done' | 'running' | 'pending' | 'failed'; elapsedMs: number | null }>;
export type MachineAddThisComputer =
    | Readonly<{ kind: 'checking' }>
    | Readonly<{ kind: 'ready'; machineName: string; platformLabel: string }>
    | Readonly<{ kind: 'onAnotherHome'; otherHomeName: string | null }>
    | Readonly<{ kind: 'needsAuth' | 'pairingRequired' }>;

type TaskKind = 'thisComputer' | 'ssh';
const EMPTY_REMOTE_HOSTS: readonly RemoteHost[] = [];
const taskKey = (kind: TaskKind) => kind === 'ssh' ? 'sshTask' as const : 'thisComputerTask' as const;

function replaceTaskId(kind: TaskKind, expectedId: string | null, nextId: string | null): void {
    // Initial starts are adopted by their exact promise; only a continuation replaces an id.
    if (expectedId === null) return;
    const key = taskKey(kind);
    const handle = readMachineAddFlowDraft()[key];
    if (!handle || handle.startPromise || handle.taskId !== expectedId || expectedId === nextId) return;
    handle.unsubscribeCompletion?.();
    const unsubscribeCompletion = nextId ? handle.observeCompletion?.(nextId) : undefined;
    updateMachineAddFlowDraft((current) => ({ ...current, [key]: { ...handle, taskId: nextId, unsubscribeCompletion } }));
}

function useHomeProfile(serverId: string) {
    const generation = React.useSyncExternalStore(subscribeServerProfiles, getServerProfilesGeneration, getServerProfilesGeneration);
    return React.useMemo(() => getServerProfileById(serverId), [generation, serverId]);
}

function makeDraftRow(path: MachineAddPathId | null, creating: boolean, host: string, handle: MachineAddTaskHandle | null, snapshot: SystemTaskRunState | null, arrived: boolean, watching: boolean): MachineAddDraftRow | null {
    if (path === null && !creating) return null;
    const entityTitle = !creating && path === 'ssh' ? host.trim() || null : null;
    const title = entityTitle ?? t('machineAdd.newMachine');
    if (arrived) return { title, entityTitle, status: t('machineAdd.connected'), tone: 'arrived' };
    if (handle?.startError || (snapshot?.result && !snapshot.result.ok)) return { title, entityTitle, status: snapshot?.status === 'canceled' ? t('machineAdd.cancelled') : t('machineAdd.failed'), tone: 'failed' };
    if (handle?.starting || (snapshot && !snapshot.result)) return { title, entityTitle, status: snapshot?.currentStepId ? resolveSystemTaskStepLabel(snapshot.currentStepId) : t('machineAdd.waiting'), tone: 'running' };
    // Choosing what to create: nothing is waiting to connect yet.
    if (creating) return { title, entityTitle, status: t('managedMachines.add.choosingCreate'), tone: 'draft' };
    return watching ? { title, entityTitle, status: t('machineAdd.waiting'), tone: 'waiting' }
        : { title, entityTitle, status: t('common.draft'), tone: 'draft' };
}

/** Rail/title projections never mount preflight, task starters, discovery or prompt modals. */
function useMachineAddProgress() {
    const selected = useMachineAddFlowDraftSelector(useShallow((current) => ({
        serverId: current.serverId, path: current.path, creating: current.creating, host: current.path === 'ssh' ? current.sshDraft.host : '',
        handle: current.path === 'ssh' ? current.sshTask : current.thisComputerTask, baseline: current.baseline, startedAtMs: current.startedAtMs,
    })));
    const profile = useHomeProfile(selected.serverId ?? '');
    const snapshot = useSystemTaskSnapshot(selected.handle?.runner ?? null, selected.handle?.taskId ?? null);
    const setBaseline = React.useCallback((baseline: AwaitedMachineArrivalBaseline) => {
        updateMachineAddFlowDraft((current) => current.serverId === selected.serverId && current.startedAtMs === selected.startedAtMs
            && current.startedAtMs !== null && current.baseline !== baseline ? { ...current, baseline } : current);
    }, [selected.serverId, selected.startedAtMs]);
    const arrival = useAwaitedMachineArrival({ enabled: selected.startedAtMs !== null && selected.serverId !== null,
        serverId: selected.serverId, serverUrl: profile?.serverUrl, baseline: selected.baseline, onBaselineCaptured: setBaseline });
    const machine = selected.startedAtMs !== null && arrival.status === 'arrived' ? arrival.machine : null;
    const watching = selected.startedAtMs !== null;
    const row = React.useMemo(() => makeDraftRow(selected.path, selected.creating, selected.host, selected.handle, snapshot, machine !== null, watching), [selected.path, selected.creating, selected.host, selected.handle, snapshot, machine, watching]);
    return { selected, profile, snapshot, machine, row };
}

export function useMachineAddDraftRow(): MachineAddDraftRow | null { return useMachineAddProgress().row; }
/** Lifecycle teardown; user operations must use the admitted discard below. */
export function discardMachineAdd(): void { discardMachineAddFlowDraft(); }

type MachineAddActionExecute = ReturnType<typeof useMountedActionExecution>['execute'];

async function cancelMachineAddSshThroughActions(execute: MachineAddActionExecute): Promise<boolean> {
    const handle = readMachineAddFlowDraft().sshTask;
    if (!handle) return true;
    const snapshot = handle.taskId ? handle.runner.getSnapshot(handle.taskId) : null;
    // A terminal task or an owner-issued cancellation needs only local view disposal.
    if (!handle.starting && (snapshot?.result || snapshot?.cancelRequested)) return true;
    let errorCode: string | null = null;
    try {
        const result = await execute('machines.add.ssh.cancel', handle.starting ? {} : { taskId: handle.taskId });
        if (result.ok) {
            const current = readMachineAddFlowDraft().sshTask;
            return current === null || current === handle;
        }
        errorCode = result.errorCode ?? result.error;
    } catch { errorCode = 'machine_setup_cancel_failed'; }
    updateMachineAddFlowDraft(draft => draft.sshTask !== handle ? draft : { ...draft, sshTask: { ...handle, startError: errorCode } });
    return false;
}

/** Header Discard, flow Discard and Add another all consume the same cancellation admission. */
async function discardMachineAddThroughActions(execute: MachineAddActionExecute): Promise<boolean> {
    if (!await cancelMachineAddSshThroughActions(execute)) return false;
    discardMachineAddFlowDraft();
    return true;
}

export function useMachineAddFlow(options: Readonly<{ serverId?: string; initialPath?: MachineAddPathId; runner?: SystemTaskRunner }> = {}): {
    serverId: string;
    homeName: string;
    paths: ReturnType<typeof useMachineAddPaths>;
    path: MachineAddPathId | null;
    choosePath: (id: MachineAddPathId) => void;
    os: MachineAddCommandOs;
    detectedOs: MachineAddCommandOs | null;
    setOs: (os: MachineAddCommandOs) => void;
    commands: Record<MachineAddCommandOs, string> | null;
    ssh: {
        draft: ReturnType<typeof readMachineAddFlowDraft>['sshDraft'];
        setDraft: (draft: SshCredentialsDraft) => void;
        ready: boolean;
        hostError: string | null;
        suggestions: { id: string; title: string; subtitle: string; apply: () => void }[];
        supportedAuthModes: ReturnType<typeof getMachineAddSshSupportedAuthModes>;
        privateKeyMaterial: string;
        setPrivateKeyMaterial: (value: string) => void;
    };
    thisComputer: MachineAddThisComputer;
    run: {
        kind: 'ssh' | 'thisComputer';
        running: boolean;
        steps: readonly MachineAddStep[];
        failure: { title: string; body: string; details: null } | null;
        prompt: ReturnType<typeof resolveRemoteSshBootstrapPrompt> | ReturnType<typeof resolveThisComputerSetupPrompt>;
    } | null;
    approval: ReturnType<typeof useMountedActionExecution>['approval'];
    watch: { status: 'arrived' | 'idle' | 'watching'; startedAtMs: number | null; notSeeing: boolean };
    arrived: { machineId: string; name: string; facts: string } | null;
    draftRow: MachineAddDraftRow | null;
    startThisComputer: () => void;
    resolveOnAnotherHome: (choice: 'move' | 'keep') => void;
    startSsh: () => void;
    startWatching: () => void;
    retry: () => void;
    cancel: () => Promise<boolean>;
    discard: () => Promise<boolean>;
    addAnother: () => Promise<void>;
    continueSshPrompt: () => void;
    declineSshPrompt: () => void;
} {
    const { draft, update, notSeeing } = useMachineAddFlowDraft();
    const active = useActiveServerSnapshot();
    const serverId = draft.serverId ?? options.serverId ?? active.serverId;
    const isActiveHome = areServerProfileIdentifiersEquivalent(active.serverId, serverId);
    const profile = useHomeProfile(serverId);
    const runner = draft.thisComputerTask?.runner ?? draft.sshTask?.runner ?? options.runner ?? getSystemTasksRunner();
    const paths = useMachineAddPaths(serverId, runner);
    const progress = useMachineAddProgress();
    const preflight = useThisComputerSetupPreflight({ runner });
    const detectedOs = detectClientCommandOs();
    const initialized = React.useRef(false);
    React.useEffect(() => {
        if (initialized.current || !serverId || paths.length === 0) return;
        initialized.current = true;
        update((current) => current.path !== null ? current : { ...current, serverId,
            path: resolveMachineAddInitialPath(paths, options.initialPath), os: detectedOs ?? current.os,
            sshDraft: runner.mode === 'native' && !current.sshDraft.host ? createDefaultSshCredentialsDraft('password') : current.sshDraft,
        });
    }, [detectedOs, options.initialPath, paths, runner.mode, serverId, update]);
    const descriptor = React.useMemo(() => profile ? buildHomeConnectionDescriptorForProfile(profile) : null, [profile]);
    const localTask = useThisComputerSetupTask({ runner, taskId: draft.thisComputerTask?.taskId ?? null,
        onTaskIdChange: (id) => replaceTaskId('thisComputer', draft.thisComputerTask?.taskId ?? null, id),
        ...(profile ? { authRequestApproval: { expectedRelayUrl: profile.serverUrl, serverId } } : {}),
    });
    const sshSnapshot = useSystemTaskSnapshot(draft.sshTask?.runner ?? runner, draft.sshTask?.taskId ?? null);
    const sshPrompt = resolveRemoteSshBootstrapPrompt(sshSnapshot);
    const hostScope = useActiveServerAccountScope(serverId);
    const sshActions = useMountedActionExecution(hostScope ?? serverId, { runner });
    const hostCatalog = useRemoteHostCatalogSnapshot(hostScope);
    const managementEnabled = useFeatureEnabled('remoteHosts.management');
    const savedHosts = managementEnabled && isActiveHome ? hostCatalog?.data ?? EMPTY_REMOTE_HOSTS : EMPTY_REMOTE_HOSTS;
    const configured = useConfiguredSshHostSuggestions({ runner, enabled: runner.mode === 'tauri' && draft.path === 'ssh' });
    const configuredHosts = React.useMemo(() => filterConfiguredSshHostSuggestions({ suggestions: configured.suggestions, remoteHosts: savedHosts }), [configured.suggestions, savedHosts]);
    const recordSshError = React.useCallback((error: unknown) => update((current) => current.serverId !== serverId || current.path !== 'ssh' ? current : ({ ...current, sshTask: {
        ...(current.sshTask ?? { runner, taskId: null, starting: false }), startError: error instanceof Error ? error.message : t('settings.systemTaskStartFailed'),
    } })), [runner, serverId, update]);
    const setDraft = React.useCallback((next: SshCredentialsDraft) => update((current) => ({ ...current, sshDraft: { ...next,
        privateKeyMaterial: next.authMode === 'keyfile' ? current.sshDraft.privateKeyMaterial : undefined,
        savedHostId: ['host', 'username', 'port', 'authMode', 'identityFilePath'].every((key) => next[key as keyof SshCredentialsDraft] === current.sshDraft[key as keyof SshCredentialsDraft]) ? current.sshDraft.savedHostId : null,
        savedHostExpectedRevision: ['host', 'username', 'port', 'authMode', 'identityFilePath'].every((key) => next[key as keyof SshCredentialsDraft] === current.sshDraft[key as keyof SshCredentialsDraft]) ? current.sshDraft.savedHostExpectedRevision : undefined,
    } })), [update]);
    const suggestions = React.useMemo(() => [
        ...savedHosts.map((host) => ({ id: host.id, title: host.name, subtitle: host.ssh.target, apply: () => {
            const overrides = getRemoteHostLocalOverridesStore().get(host.id);
            update((current) => current.serverId !== serverId ? current : { ...current, sshDraft: {
                ...buildSshCredentialsDraftFromRemoteHostConfig({ sshTarget: host.ssh.target, sshPort: host.ssh.port ?? null,
                    sshAuth: host.ssh.authMode, identityFilePath: overrides?.identityFilePath ?? '',
                    sshConfigFilePath: overrides?.sshConfigFilePath ?? '', identityPrivateKey: '', password: '' }), savedHostId: host.id,
                savedHostExpectedRevision: hostCatalog && !hostCatalog.stale && hostCatalog.catalog.status === 'ready' && hostCatalog.catalog.cleanup !== 'pending'
                    ? hostCatalog.catalog.revision : undefined,
            } });
        } })),
        ...configuredHosts.map((host) => ({ id: host.id, title: host.alias, subtitle: host.hostname, apply: () => update((current) => ({
            ...current, sshDraft: { ...applyConfiguredSshHostSuggestionToDraft(current.sshDraft, host), savedHostId: null },
        })) })),
    ], [configuredHosts, hostCatalog, savedHosts, serverId, update]);
    const chosen = paths.find((candidate) => candidate.id === draft.path) ?? null;
    const choosePath = React.useCallback((id: MachineAddPathId) => {
        if (!paths.some((candidate) => candidate.id === id) || hasRunningTask()) return;
        const current = readMachineAddFlowDraft();
        if (current.path === id) return;
        discardMachineAddFlowDraft();
        update({ ...readMachineAddFlowDraft(), serverId, path: id, os: current.os, sshDraft: current.sshDraft });
    }, [paths, serverId, update]);
    const startWatching = React.useCallback(() => {
        const current = readMachineAddFlowDraft();
        if (current.path && current.serverId && paths.some((candidate) => candidate.id === current.path && candidate.runs === 'command')) beginMachineAddWatch(current.serverId, current.path);
    }, [paths]);
    const startThisComputer = React.useCallback(() => {
        if (chosen?.id !== 'thisComputer' || chosen.runs !== 'task' || chosen.connectedMachineId || !profile || !isActiveHome) return;
        const expectedScope = storage.getState().settingsScope;
        void startMachineAddTask('thisComputer', runner, async (isCurrent) => {
            if (!await confirmThisComputerAccountMove(preflight.thisComputerConnection)) return null;
            if (!isCurrent() || (expectedScope && !areAccountSettingsScopesEqual(storage.getState().settingsScope, expectedScope))) return null;
            beginMachineAddWatch(serverId, 'thisComputer');
            return localTask.start(buildLocalMachineSetupSystemTaskSpec({ activeRelayUrl: profile.serverUrl, activeWebappUrl: resolveWebappUrlFromServerUrl(profile.serverUrl),
                activeLocalRelayUrl: preflight.activeLocalRelayUrl, activeServerIdentityId: profile.serverIdentityId, installService: true, startService: true, verifyService: true,
                // Guarded above to the active Home, so the app's signed-in account is its account there.
                activeAccountId: storage.getState().profile?.id ?? null,
            }));
        });
    }, [isActiveHome, chosen, localTask.start, preflight.activeLocalRelayUrl, preflight.thisComputerConnection, profile, runner, serverId]);
    const startSsh = React.useCallback(() => {
        if (chosen?.id !== 'ssh' || chosen.runs !== 'task' || !profile || !isActiveHome || !isSshCredentialsDraftReady(draft.sshDraft)
            || !sshActions.ready || hasRunningTask() || sshActions.approval.approvalPending) return;
        const submitted = draft.sshDraft;
        const expectedHostRevision = hostCatalog && !hostCatalog.stale && hostCatalog.catalog.status === 'ready' && hostCatalog.catalog.cleanup !== 'pending'
            ? hostCatalog.catalog.revision : null;
        if (submitted.savedHostId && expectedHostRevision === null) { recordSshError(new Error('remote_host_catalog_unavailable')); return; }
        const input = submitted.savedHostId ? { serverId, savedHostId: submitted.savedHostId, expectedHostRevision }
            : { serverId, host: submitted.host, username: submitted.username,
                ...(submitted.port.trim() ? { port: Number(submitted.port) } : {}), authMode: submitted.authMode, identityFilePath: submitted.identityFilePath };
        const originHandle = readMachineAddFlowDraft().sshTask;
        void sshActions.execute('machines.add.ssh.start', input).then(result => {
            // Admission failures belong to their originating draft, not a task accepted meanwhile.
            if (!result.ok && result.errorCode !== 'cancelled' && readMachineAddFlowDraft().sshTask === originHandle
                && readMachineAddFlowDraft().sshDraft === submitted) recordSshError(new Error(result.error));
        }).catch(recordSshError);
    }, [isActiveHome, chosen, draft.sshDraft, hostCatalog, profile, recordSshError, serverId, sshActions.execute, sshActions.ready, sshActions.approval.approvalPending]);

    const thisComputer: MachineAddThisComputer = !isActiveHome ? { kind: 'needsAuth' }
        : preflight.checking ? { kind: 'checking' }
        : preflight.serverMismatch ? { kind: 'onAnotherHome', otherHomeName: preflight.thisComputerConnection?.daemonHomeLabel ?? null }
        : preflight.needsAuth || preflight.accountMismatch ? { kind: 'needsAuth' }
        : preflight.pairingRequired ? { kind: 'pairingRequired' }
        : { kind: 'ready', machineName: resolveLocalDeviceLabel({ deviceName: Device.deviceName, platform: Platform.OS }) ?? t('machineAdd.newMachine'), platformLabel: formatOSPlatform(Device.osName ?? detectedOs ?? Platform.OS) };
    const snapshot = draft.path === 'ssh' ? sshSnapshot : localTask.activeTaskSnapshot;
    const handle = draft.path === 'ssh' ? draft.sshTask : draft.thisComputerTask;
    const localPrompt = resolveThisComputerSetupPrompt(readLatestSystemTaskPrompt(localTask.activeTaskSnapshot));
    const steps: readonly MachineAddStep[] = React.useMemo(() => {
        if (draft.path === 'ssh') {
            const items = buildRemoteSshChecklistItems({ mode: 'remoteMachine' });
            const execution = mapRemoteSshTaskToChecklistExecution({ snapshot, items, selectedIds: items.map((item) => item.id), errorTitle: t('machineAdd.failed') });
            return items.map((item): MachineAddStep => ({ id: item.id, label: item.title, elapsedMs: null, state: execution[item.id]?.status === 'error' ? 'failed' : execution[item.id]?.status === 'running' ? 'running' : execution[item.id]?.status === 'done' ? 'done' : 'pending' }));
        }
        const items = buildThisComputerSetupStageModel({ preflight, prompt: localPrompt });
        const execution = mapThisComputerSetupExecutionToStages(snapshot, items.flatMap((item) => item.children?.map((child) => child.id) ?? []));
        return items.map((item): MachineAddStep => ({ id: item.id, label: item.title, elapsedMs: null, state: execution[item.id]?.status === 'error' ? 'failed' : execution[item.id]?.status === 'running' ? 'running' : execution[item.id]?.status === 'done' ? 'done' : 'pending' }));
    }, [draft.path, localPrompt, preflight, snapshot]);
    const taskError = snapshot?.result && !snapshot.result.ok ? snapshot.result.error : null;
    const failure = taskError || handle?.startError ? { title: t('machineAdd.failed'),
        body: taskError ? resolveSystemTaskFailureMessage(taskError) ?? t('settings.systemTaskStartFailed') : handle?.startError ?? t('settings.systemTaskStartFailed'), details: null,
    } : null;
    const run = handle ? { kind: draft.path === 'ssh' ? 'ssh' as const : 'thisComputer' as const, running: handle.starting || Boolean(snapshot && !snapshot.result), steps, failure, prompt: draft.path === 'ssh' ? sshPrompt : localPrompt } : null;
    const commands = React.useMemo(() => chosen?.runs === 'command' && profile ? Object.fromEntries(
        MACHINE_ADD_COMMAND_OS.map((os) => [os, buildMachineAddCommand({ os, descriptor, profileSource: profile.source ?? null, fallbackHomeUrl: profile.serverUrl,
            ...(chosen.id === 'ssh' ? { kind: 'sshMachine' as const, sshDraft: draft.sshDraft } : { kind: 'joinHome' as const }),
        })]),
    ) as Record<MachineAddCommandOs, string> : null, [chosen, descriptor, draft.sshDraft, profile]);
    const arrived = progress.machine ? { machineId: progress.machine.id, name: getMachineDisplayName(progress.machine),
        facts: [formatOSPlatform(progress.machine.metadata?.platform), progress.machine.metadata?.arch].filter(Boolean).join(' · '),
    } : null;
    const respondSsh = React.useCallback((answer: z.infer<typeof MachineAddSshAnswerSchema>) => {
        if (!isActiveHome) return;
        const handle = readMachineAddFlowDraft().sshTask;
        if (!handle?.taskId || sshActions.approval.approvalPending) return;
        void sshActions.execute('machines.add.ssh.respond', { taskId: handle.taskId, answer }).then(result => {
            if (!result.ok) recordSshError(new Error(result.error));
        }).catch(recordSshError);
    }, [isActiveHome, recordSshError, sshActions.execute, sshActions.approval.approvalPending]);
    const cancel = React.useCallback(async () => {
        if (readMachineAddFlowDraft().path !== 'ssh') { cancelMachineAddFlowTasks(); return true; }
        if (sshActions.approval.approvalPending) return false;
        return cancelMachineAddSshThroughActions(sshActions.execute);
    }, [sshActions.execute, sshActions.approval.approvalPending]);
    const discard = React.useCallback(() => sshActions.approval.approvalPending ? Promise.resolve(false)
        : discardMachineAddThroughActions(sshActions.execute), [sshActions.execute, sshActions.approval.approvalPending]);
    const continueSshPrompt = React.useCallback(() => {
        if (!sshPrompt) return;
        switch (sshPrompt.kind) {
            case 'ssh.password': respondSsh({ kind: sshPrompt.kind }); break;
            case 'ssh.trustHost': case 'ssh.replaceHostKey': respondSsh({ kind: sshPrompt.kind, trusted: true }); break;
            case 'auth.approveRemoteProvisioning': respondSsh({ kind: sshPrompt.kind, approved: true }); break;
            case 'daemon.replaceRemoteBackgroundServices': respondSsh({ kind: sshPrompt.kind, replaceExistingServices: true }); break;
            case 'releaseChannel.switchDefaultForSetup': respondSsh({ kind: sshPrompt.kind, switchDefaultReleaseChannel: true }); break;
        }
    }, [respondSsh, sshPrompt]);
    return {
        serverId, homeName: resolveHomeDisplayName(profile) ?? t('settingsAccount.thisHomeTitle'), paths, path: draft.path,
        choosePath, os: draft.os, detectedOs, setOs: (os: MachineAddCommandOs) => update((current) => ({ ...current, os })), commands,
        ssh: { draft: draft.sshDraft, setDraft, ready: isSshCredentialsDraftReady(draft.sshDraft) && sshActions.ready,
            hostError: taskError && ['connection-failed', 'network-captive-portal'].includes(taskError.code) ? t('machineAdd.cannotReachHost') : null,
            suggestions, supportedAuthModes: getMachineAddSshSupportedAuthModes(runner),
            privateKeyMaterial: draft.sshDraft.privateKeyMaterial ?? '', setPrivateKeyMaterial: (value: string) => update((current) => ({ ...current, sshDraft: { ...current.sshDraft, privateKeyMaterial: value, savedHostId: null } })),
        },
        thisComputer, run, approval: sshActions.approval,
        watch: { status: draft.startedAtMs === null ? 'idle' as const : arrived ? 'arrived' as const : 'watching' as const, startedAtMs: draft.startedAtMs, notSeeing: draft.startedAtMs !== null && !arrived && notSeeing },
        arrived, draftRow: progress.row, startThisComputer,
        resolveOnAnotherHome: (choice: 'move' | 'keep') => choice === 'move' ? startThisComputer() : choosePath('anotherComputer'),
        startSsh, startWatching, retry: () => {
            if (hasRunningTask()) return;
            update((current) => ({ ...current, baseline: null, startedAtMs: null }));
            if (chosen?.runs === 'command') startWatching(); else if (draft.path === 'ssh') startSsh(); else startThisComputer();
        },
        cancel, discard,
        addAnother: async () => {
            if (!await discard()) return;
            update((current) => ({ ...current, serverId, os: detectedOs ?? current.os, path: resolveMachineAddInitialPath(paths, undefined, true),
                sshDraft: createDefaultSshCredentialsDraft(runner.mode === 'native' ? 'password' : 'agent'),
            }));
        },
        continueSshPrompt, declineSshPrompt: () => {
            if (sshPrompt?.kind === 'daemon.replaceRemoteBackgroundServices') respondSsh({ kind: sshPrompt.kind, replaceExistingServices: false });
            else if (sshPrompt?.kind === 'releaseChannel.switchDefaultForSetup') respondSsh({ kind: sshPrompt.kind, switchDefaultReleaseChannel: false });
            else cancel();
        },
    };
}
