import * as React from 'react';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';

import { t } from '@/text';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById, getServerProfilesGeneration, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { readRemoteHosts } from '@/sync/domains/remoteHosts/remoteHostModel';
import { getRemoteHostLocalOverridesStore } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { resolveRemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import { buildSshCredentialsDraftFromRemoteHostConfig, resolveRemoteHostBootstrapRelayUrls } from '@/components/settings/remoteHosts/remoteHostOutcomeActions';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { confirmThisComputerAccountMove } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import { useThisComputerSetupPreflight } from '@/components/onboarding/checklists/setupThisComputer/useThisComputerSetupPreflight';
import { resolveRemoteSshBootstrapFormState } from '@/components/onboarding/checklists/remoteSsh/resolveRemoteSshBootstrapFormState';
import { persistRemoteHostAfterRemoteSshCompletion } from '@/components/onboarding/checklists/remoteSsh/persistRemoteHostAfterRemoteSshCompletion';
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
import { useRemoteSshBootstrapTask, type RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
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
import type { MachineAddPathId } from './machineAddPaths';
import { useMachineAddPaths } from './useMachineAddPaths';
import { buildMachineAddCommand, detectClientCommandOs, MACHINE_ADD_COMMAND_OS, type MachineAddCommandOs } from './machineAddCommand';
import { cancelMachineAddFlowTasks, discardMachineAddFlowDraft, readMachineAddFlowDraft, updateMachineAddFlowDraft, useMachineAddFlowDraft, useMachineAddFlowDraftSelector, type MachineAddTaskHandle } from './machineAddFlowStore';
import { beginMachineAddWatch, startMachineAddTask, hasRunningMachineAddTask as hasRunningTask } from './machineAddTaskLifetime';

export type MachineAddDraftRow = Readonly<{ title: string; entityTitle: string | null; status: string | null; tone: 'waiting' | 'running' | 'failed' | 'arrived' }>;
export type MachineAddStep = Readonly<{ id: string; label: string; state: 'done' | 'running' | 'pending' | 'failed'; elapsedMs: number | null }>;
export type MachineAddThisComputer =
    | Readonly<{ kind: 'checking' }>
    | Readonly<{ kind: 'ready'; machineName: string; platformLabel: string }>
    | Readonly<{ kind: 'onAnotherHome'; otherHomeName: string | null }>
    | Readonly<{ kind: 'needsAuth' | 'pairingRequired' }>;

type TaskKind = 'thisComputer' | 'ssh';
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

function makeDraftRow(path: MachineAddPathId | null, host: string, handle: MachineAddTaskHandle | null, snapshot: SystemTaskRunState | null, arrived: boolean): MachineAddDraftRow | null {
    if (path === null) return null;
    const entityTitle = path === 'ssh' ? host.trim() || null : null;
    const title = entityTitle ?? t('machineAdd.newMachine');
    if (arrived) return { title, entityTitle, status: t('machineAdd.connected'), tone: 'arrived' };
    if (handle?.startError || (snapshot?.result && !snapshot.result.ok)) return { title, entityTitle, status: snapshot?.status === 'canceled' ? t('machineAdd.cancelled') : t('machineAdd.failed'), tone: 'failed' };
    if (handle?.starting || (snapshot && !snapshot.result)) return { title, entityTitle, status: snapshot?.currentStepId ? resolveSystemTaskStepLabel(snapshot.currentStepId) : t('machineAdd.waiting'), tone: 'running' };
    return { title, entityTitle, status: t('machineAdd.waiting'), tone: 'waiting' };
}

/** Rail/title projections never mount preflight, task starters, discovery or prompt modals. */
function useMachineAddProgress() {
    const selected = useMachineAddFlowDraftSelector(useShallow((current) => ({
        serverId: current.serverId, path: current.path, host: current.path === 'ssh' ? current.sshDraft.host : '',
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
    const row = React.useMemo(() => makeDraftRow(selected.path, selected.host, selected.handle, snapshot, machine !== null), [selected.path, selected.host, selected.handle, snapshot, machine]);
    return { selected, profile, snapshot, machine, row };
}

export function useMachineAddDraftRow(): MachineAddDraftRow | null { return useMachineAddProgress().row; }
export function discardMachineAdd(): void { discardMachineAddFlowDraft(); }

export function useMachineAddFlow(options: Readonly<{ serverId?: string; initialPath?: MachineAddPathId; runner?: SystemTaskRunner }> = {}) {
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
            path: paths.find((candidate) => candidate.id === options.initialPath)?.id ?? paths[0]!.id, os: detectedOs ?? current.os,
            sshDraft: runner.mode === 'native' && !current.sshDraft.host ? createDefaultSshCredentialsDraft('password') : current.sshDraft,
        });
    }, [detectedOs, options.initialPath, paths, runner.mode, serverId, update]);
    const descriptor = React.useMemo(() => profile ? buildHomeConnectionDescriptorForProfile(profile) : null, [profile]);
    const homeTarget = React.useMemo(() => descriptor && profile ? resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
        profile: { id: profile.id, serverUrl: profile.serverUrl, webappUrl: resolveWebappUrlFromServerUrl(profile.serverUrl) },
    }) : undefined, [descriptor, profile]);
    const relay = isActiveHome ? resolveRemoteHostBootstrapRelayUrls(active) : null;
    const localTask = useThisComputerSetupTask({ runner, taskId: draft.thisComputerTask?.taskId ?? null,
        onTaskIdChange: (id) => replaceTaskId('thisComputer', draft.thisComputerTask?.taskId ?? null, id),
        ...(profile ? { authRequestApproval: { expectedRelayUrl: profile.serverUrl, serverId } } : {}),
    });
    const sshTask = useRemoteSshBootstrapTask({ runner, taskId: draft.sshTask?.taskId ?? null,
        onTaskIdChange: (id) => replaceTaskId('ssh', draft.sshTask?.taskId ?? null, id), relayUrl: relay?.relayUrl ?? profile?.serverUrl ?? '',
        webappUrl: relay?.webappUrl ?? (profile ? resolveWebappUrlFromServerUrl(profile.serverUrl) : undefined), publicRelayUrl: relay?.publicRelayUrl ?? undefined, homeTarget,
    });
    const remoteHostsRaw = useSetting('remoteHostsV1');
    const managementEnabled = useFeatureEnabled('remoteHosts.management');
    const secretMaterialEnabled = useFeatureEnabled('remoteHosts.secretMaterial');
    const savedHosts = React.useMemo(() => managementEnabled && isActiveHome ? readRemoteHosts(remoteHostsRaw) : [], [isActiveHome, managementEnabled, remoteHostsRaw]);
    const configured = useConfiguredSshHostSuggestions({ runner, enabled: runner.mode === 'tauri' && draft.path === 'ssh' });
    const configuredHosts = React.useMemo(() => filterConfiguredSshHostSuggestions({ suggestions: configured.suggestions, remoteHosts: savedHosts }), [configured.suggestions, savedHosts]);
    const recordSshError = React.useCallback((error: unknown) => update((current) => current.serverId !== serverId || current.path !== 'ssh' ? current : ({ ...current, sshTask: {
        ...(current.sshTask ?? { runner, taskId: null, starting: false }), startError: error instanceof Error ? error.message : t('settings.systemTaskStartFailed'),
    } })), [runner, serverId, update]);
    const setDraft = React.useCallback((next: SshCredentialsDraft) => update((current) => ({ ...current, sshDraft: { ...next,
        privateKeyMaterial: next.authMode === 'keyfile' ? current.sshDraft.privateKeyMaterial : undefined,
        savedHostId: ['host', 'username', 'port', 'authMode', 'identityFilePath'].every((key) => next[key as keyof SshCredentialsDraft] === current.sshDraft[key as keyof SshCredentialsDraft]) ? current.sshDraft.savedHostId : null,
    } })), [update]);
    const suggestions = React.useMemo(() => [
        ...savedHosts.map((host) => ({ id: host.id, title: host.name, subtitle: host.ssh.target, apply: () => {
            const selectedDraft = readMachineAddFlowDraft().sshDraft;
            const expectedScope = storage.getState().settingsScope;
            void Promise.resolve().then(() => resolveRemoteHostEffectiveSshConfig({ remoteHost: host, localOverrides: getRemoteHostLocalOverridesStore().get(host.id), secretMaterialAllowed: secretMaterialEnabled,
                decryptSecretValue: (secret) => getSyncSingleton().decryptSecretValue(secret),
            })).then((resolved) => {
                if (!resolved.ok) throw new Error(resolved.error.message);
                if (!areAccountSettingsScopesEqual(storage.getState().settingsScope, expectedScope)) return;
                update((current) => current.sshDraft !== selectedDraft || current.serverId !== serverId ? current : { ...current, sshDraft: {
                    ...buildSshCredentialsDraftFromRemoteHostConfig(resolved.value), privateKeyMaterial: resolved.value.identityPrivateKey, savedHostId: host.id,
                } });
            }).catch((error: unknown) => {
                if (readMachineAddFlowDraft().sshDraft === selectedDraft && areAccountSettingsScopesEqual(storage.getState().settingsScope, expectedScope)) recordSshError(error);
            });
        } })),
        ...configuredHosts.map((host) => ({ id: host.id, title: host.alias, subtitle: host.hostname, apply: () => update((current) => ({
            ...current, sshDraft: { ...applyConfiguredSshHostSuggestionToDraft(current.sshDraft, host), savedHostId: null },
        })) })),
    ], [configuredHosts, recordSshError, savedHosts, secretMaterialEnabled, serverId, update]);
    const resolveSshForm = React.useCallback((): Promise<RemoteSshBootstrapFormState> => {
        const sshDraft = readMachineAddFlowDraft().sshDraft;
        const saved = savedHosts.find((host) => host.id === sshDraft.savedHostId) ?? null;
        return resolveRemoteSshBootstrapFormState({ draft: sshDraft, usingSavedHost: saved !== null, selectedSavedHost: saved,
            privateKeyMaterialDraft: sshDraft.privateKeyMaterial ?? '', saveSecretMaterial: false, installRelayRuntime: false,
            remoteHostsSecretMaterialEnabled: secretMaterialEnabled, decryptSecretValue: (secret) => getSyncSingleton().decryptSecretValue(secret),
        });
    }, [savedHosts, secretMaterialEnabled]);
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
        if (chosen?.id !== 'ssh' || chosen.runs !== 'task' || !profile || !isActiveHome || !isSshCredentialsDraftReady(draft.sshDraft)) return;
        const submitted = draft.sshDraft;
        const expectedScope = storage.getState().settingsScope;
        const observeCompletion = (taskId: string) => {
            let unsubscribe: (() => void) | null = null;
            const finish = () => {
                const result = runner.getSnapshot(taskId)?.result;
                if (!result) return;
                unsubscribe?.();
                unsubscribe = null;
                if (!result.ok || !areAccountSettingsScopesEqual(storage.getState().settingsScope, expectedScope)) return;
                const data: unknown = result.data;
                const machineId = data && typeof data === 'object' && !Array.isArray(data) && 'machineId' in data && typeof data.machineId === 'string' ? data.machineId : null;
                // Persistence is the existing best-effort owner; a machine's arrival is independent.
                void persistRemoteHostAfterRemoteSshCompletion({ managementEnabled, secretMaterialEnabled, remoteHostsRaw: storage.getState().settings.remoteHostsV1,
                    selectedSavedRemoteHostId: submitted.savedHostId ?? '__new__', newHostSentinelId: '__new__',
                    runContext: { selectedSavedRemoteHostId: submitted.savedHostId ?? '__new__', saveHost: true, saveSecretMaterial: false },
                    draft: submitted, privateKeyMaterialDraft: submitted.privateKeyMaterial ?? '', completion: { machineId, relayRuntimeUrl: null },
                }).catch(() => {});
            };
            unsubscribe = runner.subscribe(taskId, finish);
            finish();
            return () => { unsubscribe?.(); unsubscribe = null; };
        };
        void startMachineAddTask('ssh', runner, async (isCurrent) => {
            const form = await resolveSshForm();
            if (!isCurrent() || !areAccountSettingsScopesEqual(storage.getState().settingsScope, expectedScope)) return null;
            beginMachineAddWatch(serverId, 'ssh');
            return sshTask.start(form);
        }, observeCompletion);
    }, [isActiveHome, chosen, draft.sshDraft, managementEnabled, profile, resolveSshForm, runner, secretMaterialEnabled, serverId, sshTask.start]);

    const thisComputer: MachineAddThisComputer = !isActiveHome ? { kind: 'needsAuth' }
        : preflight.checking ? { kind: 'checking' }
        : preflight.serverMismatch ? { kind: 'onAnotherHome', otherHomeName: preflight.thisComputerConnection?.daemonHomeLabel ?? null }
        : preflight.needsAuth || preflight.accountMismatch ? { kind: 'needsAuth' }
        : preflight.pairingRequired ? { kind: 'pairingRequired' }
        : { kind: 'ready', machineName: resolveLocalDeviceLabel({ deviceName: Device.deviceName, platform: Platform.OS }) ?? t('machineAdd.newMachine'), platformLabel: formatOSPlatform(Device.osName ?? detectedOs ?? Platform.OS) };
    const snapshot = draft.path === 'ssh' ? sshTask.activeTaskSnapshot : localTask.activeTaskSnapshot;
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
    const run = handle ? { kind: draft.path === 'ssh' ? 'ssh' as const : 'thisComputer' as const, running: handle.starting || Boolean(snapshot && !snapshot.result), steps, failure, prompt: draft.path === 'ssh' ? sshTask.prompt : localPrompt } : null;
    const commands = React.useMemo(() => chosen?.runs === 'command' && profile ? Object.fromEntries(
        MACHINE_ADD_COMMAND_OS.map((os) => [os, buildMachineAddCommand({ os, descriptor, profileSource: profile.source ?? null, fallbackHomeUrl: profile.serverUrl,
            ...(chosen.id === 'ssh' ? { kind: 'sshMachine' as const, sshDraft: draft.sshDraft } : { kind: 'joinHome' as const }),
        })]),
    ) as Record<MachineAddCommandOs, string> : null, [chosen, descriptor, draft.sshDraft, profile]);
    const arrived = progress.machine ? { machineId: progress.machine.id, name: getMachineDisplayName(progress.machine),
        facts: [formatOSPlatform(progress.machine.metadata?.platform), progress.machine.metadata?.arch].filter(Boolean).join(' · '),
    } : null;
    const continueSshPrompt = React.useCallback(() => {
        if (!isActiveHome) return;
        const handle = readMachineAddFlowDraft().sshTask;
        if (!handle?.taskId || !sshTask.prompt) return;
        const expectedScope = storage.getState().settingsScope;
        void startMachineAddTask('ssh', handle.runner, async (isCurrent) => {
            const form = await resolveSshForm();
            if (!isCurrent() || !areAccountSettingsScopesEqual(storage.getState().settingsScope, expectedScope)) return null;
            if (sshTask.prompt?.kind === 'ssh.password') {
                await sshTask.answerPasswordPrompt(form);
                return handle.taskId;
            }
            return sshTask.continueAfterPrompt(form);
        }, handle.observeCompletion, handle);
    }, [isActiveHome, resolveSshForm, sshTask.answerPasswordPrompt, sshTask.continueAfterPrompt, sshTask.prompt]);
    return {
        serverId, homeName: resolveHomeDisplayName(profile) ?? t('settingsAccount.thisHomeTitle'), paths, path: draft.path,
        choosePath, os: draft.os, detectedOs, setOs: (os: MachineAddCommandOs) => update((current) => ({ ...current, os })), commands,
        ssh: { draft: draft.sshDraft, setDraft, ready: isSshCredentialsDraftReady(draft.sshDraft),
            hostError: taskError && ['connection-failed', 'network-captive-portal'].includes(taskError.code) ? t('machineAdd.cannotReachHost') : null,
            suggestions, supportedAuthModes: runner.mode === 'native' ? ['keyfile', 'password'] as const : ['agent', 'keyfile', 'password'] as const,
            privateKeyMaterial: draft.sshDraft.privateKeyMaterial ?? '', setPrivateKeyMaterial: (value: string) => update((current) => ({ ...current, sshDraft: { ...current.sshDraft, privateKeyMaterial: value, savedHostId: null } })),
        },
        thisComputer, run,
        watch: { status: draft.startedAtMs === null ? 'idle' as const : arrived ? 'arrived' as const : 'watching' as const, startedAtMs: draft.startedAtMs, notSeeing: draft.startedAtMs !== null && !arrived && notSeeing },
        arrived, draftRow: progress.row, startThisComputer,
        resolveOnAnotherHome: (choice: 'move' | 'keep') => choice === 'move' ? startThisComputer() : choosePath('anotherComputer'),
        startSsh, startWatching, retry: () => {
            if (hasRunningTask()) return;
            update((current) => ({ ...current, baseline: null, startedAtMs: null }));
            sshTask.resetPromptResolution();
            if (chosen?.runs === 'command') startWatching(); else if (draft.path === 'ssh') startSsh(); else startThisComputer();
        },
        cancel: cancelMachineAddFlowTasks, discard: discardMachineAdd,
        addAnother: () => {
            discardMachineAdd();
            update((current) => ({ ...current, serverId, os: detectedOs ?? current.os, path: paths.find((candidate) => !candidate.connectedMachineId)?.id ?? null,
                sshDraft: createDefaultSshCredentialsDraft(runner.mode === 'native' ? 'password' : 'agent'),
            }));
        },
        continueSshPrompt, declineSshPrompt: () => {
            if (sshTask.prompt?.kind === 'daemon.replaceRemoteBackgroundServices' || sshTask.prompt?.kind === 'releaseChannel.switchDefaultForSetup') void sshTask.declinePrompt().catch(recordSshError);
            else cancelMachineAddFlowTasks();
        },
    };
}
