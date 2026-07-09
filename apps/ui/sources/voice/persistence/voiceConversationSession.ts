import {
    buildSystemSessionMetadataV1,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';
import { type AgentId } from '@happier-dev/agents';

import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { isAgentId } from '@/agents/registry/registryCore';
import { listPreferredMachineIds } from '@/components/settings/pickers/resolvePreferredMachineId';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveMachineExactSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineExactSpawnReadiness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createSpawnAttemptKey } from '@/sync/domains/session/spawn/spawnAttemptKey';
import { storage } from '@/sync/domains/state/storage';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { machineSpawnNewSession } from '@/sync/ops/machines';
import { readReplacementAwareMachineRpcTarget } from '@/sync/ops/machineRpcTarget';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { publishDisplayTitleMetadataMutation } from '@/sync/state/displayTitlePublish';
import { sync } from '@/sync/sync';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

import {
    matchesVoiceConversationScope,
    writeVoiceConversationScopeMetadata,
    type VoiceConversationScopeMetadata,
} from './voiceConversationScopeMetadata';
import { persistVoiceAutoTargetMachineId, readVoiceAutoTargetMachineId } from './voiceAutoTargetMachineSettings';
import {
    findPreferredVoiceConversationSystemSession,
    findReusableVoiceConversationRuntimeSessionId,
    findVoiceConversationSessionId,
    isVoiceConversationSystemSessionMetadata,
    listVoiceConversationSystemSessions,
    resolveVoiceConversationSessionMetadataFromState,
    VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY,
    VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';

export {
    findReusableVoiceConversationRuntimeSessionId,
    findVoiceConversationSessionId,
    isVoiceConversationSystemSessionMetadata,
    VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';

const VOICE_HOME_SPAWN_TARGET_WAIT_TIMEOUT_MS = 5_000;
const VOICE_HOME_SPAWN_TARGET_WAIT_INTERVAL_MS = 100;

function buildVoiceConversationSystemSessionMetadata() {
    return buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
}

function joinFsPath(base: string, child: string): string {
    const trimmedBase = String(base ?? '').trim().replace(/\/+$/g, '');
    const trimmedChild = String(child ?? '').trim().replace(/^\/+/g, '');
    if (!trimmedBase) return trimmedChild;
    if (!trimmedChild) return trimmedBase;
    return `${trimmedBase}/${trimmedChild}`;
}

function resolveVoiceHomeDirectory(state: any, machineId: string): string | null {
    const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
    const subdir = normalizeNonEmptyString(agentCfg?.voiceHomeSubdirName) ?? 'voice-agent';
    const machine = resolveMachineForActiveServerFromState(state, machineId);
    if (machine && machine.active === false) return null;
    const happyHomeDir = normalizeNonEmptyString(machine?.metadata?.happyHomeDir);
    if (happyHomeDir) return joinFsPath(happyHomeDir, subdir);

    for (const recent of state?.settings?.recentMachinePaths ?? []) {
        if (normalizeNonEmptyString(recent?.machineId) !== machineId) continue;
        const recentDirectory = normalizeNonEmptyString(recent?.path);
        if (recentDirectory) return recentDirectory;
    }

    for (const session of Object.values(state?.sessions ?? {}) as any[]) {
        const resolvedTarget = typeof session?.id === 'string' ? readMachineTargetForSession(session.id) : null;
        if (normalizeNonEmptyString(resolvedTarget?.machineId) !== machineId) continue;
        const sessionDirectory = normalizeNonEmptyString(resolvedTarget?.basePath);
        if (sessionDirectory) return sessionDirectory;
    }

    return null;
}

function resolveReplacementAwareVoiceMachineId(machineId: string | null | undefined): string | null {
    return readReplacementAwareMachineRpcTarget(machineId)?.machineId ?? null;
}

function resolveRecentVoiceDirectoryForMachine(state: any, machineId: string | null | undefined): string | null {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    if (!normalizedMachineId) return null;
    for (const recent of state?.settings?.recentMachinePaths ?? []) {
        if (normalizeNonEmptyString(recent?.machineId) !== normalizedMachineId) continue;
        const recentDirectory = normalizeNonEmptyString(recent?.path);
        if (recentDirectory) return recentDirectory;
    }
    return null;
}

function resolveRecentVoiceDirectoryForRouteMachine(state: any, routeMachineId: string | null | undefined): string | null {
    const normalizedRouteMachineId = normalizeNonEmptyString(routeMachineId);
    if (!normalizedRouteMachineId) return null;
    for (const recent of state?.settings?.recentMachinePaths ?? []) {
        const recentMachineId = normalizeNonEmptyString(recent?.machineId);
        if (resolveReplacementAwareVoiceMachineId(recentMachineId) !== normalizedRouteMachineId) continue;
        const recentDirectory = normalizeNonEmptyString(recent?.path);
        if (recentDirectory) return recentDirectory;
    }
    return null;
}

function resolveSpawnTarget(state: any): { machineId: string; directory: string } | null {
    const sessionsObj = state?.sessions ?? {};
    const voiceTarget = useVoiceTargetStore.getState();
    const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
        .map((value) => normalizeNonEmptyString(value))
        .filter(Boolean) as string[];

    for (const sessionId of candidates) {
        const resolvedTarget = readMachineTargetForSession(sessionId);
        const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
        const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
        if (machineId && directory) return { machineId, directory };
    }

    const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
    const recentMachineId = normalizeNonEmptyString(recent?.machineId);
    const recentDirectory = normalizeNonEmptyString(recent?.path);
    const recentRouteMachineId = resolveReplacementAwareVoiceMachineId(recentMachineId);
    if (recentRouteMachineId && recentDirectory) return { machineId: recentRouteMachineId, directory: recentDirectory };

    for (const session of Object.values(sessionsObj) as any[]) {
        const resolvedTarget = typeof session?.id === 'string' ? readMachineTargetForSession(session.id) : null;
        const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
        const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
        if (machineId && directory) return { machineId, directory };
    }

    return null;
}

function resolveVoiceHomeSpawnTarget(state: any): { machineId: string; directory: string } | null {
    const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
    const fixedMachineId = (normalizeNonEmptyString(agentCfg?.machineTargetMode) ?? 'auto') === 'fixed'
        ? normalizeNonEmptyString(agentCfg?.machineTargetId)
        : null;
    if (fixedMachineId) {
        const fixedRouteMachineId = resolveReplacementAwareVoiceMachineId(fixedMachineId);
        const fixedDirectory = fixedRouteMachineId
            ? resolveVoiceHomeDirectory(state, fixedRouteMachineId) ?? resolveRecentVoiceDirectoryForMachine(state, fixedMachineId)
            : null;
        if (fixedRouteMachineId && fixedDirectory) return { machineId: fixedRouteMachineId, directory: fixedDirectory };
    }

    const isKnownInactiveMachine = (machineId: string): boolean => {
        const machine =
            resolveMachineForActiveServerFromState(state, machineId)
            ?? state?.machines?.[machineId]
            ?? null;
        return machine?.active === false;
    };

    const stickyAutoMachineId = readVoiceAutoTargetMachineId(state);
    if (stickyAutoMachineId) {
        const stickyRouteMachineId = resolveReplacementAwareVoiceMachineId(stickyAutoMachineId);
        const stickyMachine =
            resolveMachineForActiveServerFromState(state, stickyRouteMachineId ?? stickyAutoMachineId)
            ?? state?.machines?.[stickyRouteMachineId ?? stickyAutoMachineId]
            ?? null;
        const stickyDirectory = stickyRouteMachineId
            ? resolveVoiceHomeDirectory(state, stickyRouteMachineId) ?? resolveRecentVoiceDirectoryForMachine(state, stickyAutoMachineId)
            : null;
        if (stickyRouteMachineId && stickyDirectory && stickyMachine?.active !== false) {
            return { machineId: stickyRouteMachineId, directory: stickyDirectory };
        }
    }

    const candidateMachineIds: Array<string | null | undefined> = [
        resolveSpawnTarget(state)?.machineId,
        ...(
            Array.isArray(state?.settings?.recentMachinePaths)
                ? state.settings.recentMachinePaths.map((entry: any) => normalizeNonEmptyString(entry?.machineId))
                : []
        ),
        ...resolveVisibleMachinesForActiveServerFromState(state)
            .filter((machine) => machine.active === true)
            .map((machine) => normalizeNonEmptyString(machine.id)),
        ...listPreferredMachineIds({
            machines: resolveVisibleMachinesForActiveServerFromState(state),
            recentMachinePaths: Array.isArray(state?.settings?.recentMachinePaths) ? state.settings.recentMachinePaths : [],
        }),
        ...resolveVisibleMachinesForActiveServerFromState(state).map((machine) => normalizeNonEmptyString(machine.id)),
    ];
    const seenMachineIds = new Set<string>();

    for (const candidateMachineId of candidateMachineIds) {
        const originMachineId = normalizeNonEmptyString(candidateMachineId);
        const machineId = resolveReplacementAwareVoiceMachineId(originMachineId);
        if (!machineId) continue;
        if (seenMachineIds.has(machineId)) continue;
        seenMachineIds.add(machineId);
        if (isKnownInactiveMachine(machineId)) continue;
        const directory =
            resolveVoiceHomeDirectory(state, machineId)
            ?? resolveRecentVoiceDirectoryForMachine(state, originMachineId)
            ?? resolveRecentVoiceDirectoryForRouteMachine(state, machineId);
        if (directory) {
            return { machineId, directory };
        }
    }

    return null;
}

export function resolveVoiceHomeDaemonMachineId(state: any = storage.getState()): string | null {
    return resolveVoiceHomeSpawnTarget(state)?.machineId ?? null;
}

async function resolveVoiceConversationBackendTarget(state: any, machineId: string): Promise<BackendTargetRefV2> {
    const settings = state?.settings ?? {};
    const agentCfg = settings?.voice?.adapters?.local_conversation?.agent ?? {};
    const agentSource = normalizeNonEmptyString(agentCfg?.agentSource) ?? 'session';
    const requestedAgentId = normalizeNonEmptyString(agentCfg?.agentId);

    if (agentSource === 'agent' && isAgentId(requestedAgentId)) {
        return { kind: 'backend', backendId: requestedAgentId as AgentId };
    }

    const daemonMergedProjectionInputs = await loadDaemonMergedProjectionInputs({
        machineId,
        serverId: getActiveServerSnapshot().serverId,
    });
    return resolvePreferredBackendTargetFromProjection({
        lastUsedAgent: settings.lastUsedAgent,
        lastUsedBackendTarget: settings.lastUsedBackendTarget,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
        daemonMergedProjectionInputs,
    });
}

async function waitForVoiceHomeSpawnTarget(timeoutMs: number): Promise<{ machineId: string; directory: string } | null> {
    const startedAt = Date.now();
    let target = resolveVoiceHomeSpawnTarget(storage.getState());
    while (!target && (Date.now() - startedAt) < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, VOICE_HOME_SPAWN_TARGET_WAIT_INTERVAL_MS));
        target = resolveVoiceHomeSpawnTarget(storage.getState());
    }
    return target;
}

function toVoiceConversationSpawnError(spawned: unknown): Error {
    const errorCode = normalizeNonEmptyString((spawned as any)?.errorCode);
    const errorMessage = normalizeNonEmptyString((spawned as any)?.errorMessage);
    return Object.assign(
        new Error(errorMessage ?? 'voice_conversation_spawn_failed'),
        { code: errorCode ?? 'VOICE_CONVERSATION_SPAWN_FAILED' },
    );
}

function resolveTargetMachineForSpawn(state: any, machineId: string): any {
    return resolveMachineForActiveServerFromState(state, machineId)
        ?? state?.machines?.[machineId]
        ?? null;
}

function assertTargetMachineReadyForSpawn(machineId: string): void {
    const state = storage.getState();
    const machine = resolveTargetMachineForSpawn(state, machineId);
    if (resolveMachineExactSpawnReadiness(machine, machineId).status === 'ready') return;
    throw Object.assign(
        new Error('Target machine daemon is offline. Start or reconnect the daemon before starting local voice.'),
        { code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' },
    );
}

async function waitForSessionMetadata(sessionId: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const metadata = resolveSessionListPreferredSessionMetadataFromState(storage.getState() as any, sessionId);
        if (metadata) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('voice_conversation_session_not_ready');
}

async function resolveSessionRootTarget(sessionId: string): Promise<Readonly<{ machineId: string; directory: string }> | null> {
    const readTarget = () => {
        const resolvedTarget = readMachineTargetForSession(sessionId);
        const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
        const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
        return machineId && directory ? { machineId, directory } : null;
    };

    const existingTarget = readTarget();
    if (existingTarget) return existingTarget;

    await Promise.resolve(sync.ensureSessionVisibleForMessageRoute(sessionId)).catch(() => {});
    return readTarget();
}

let ensurePromise: Promise<string> | null = null;

async function touchVoiceConversationSessionWithScope(
    sessionId: string,
    scope: VoiceConversationScopeMetadata,
): Promise<void> {
    await publishDisplayTitleMetadataMutation({
        sessionId,
        title: 'Voice conversation (system)',
        updateSessionMetadataWithRetry: (targetSessionId, updater) =>
            sync.patchSessionMetadataWithRetry(targetSessionId, updater),
        resolveTitle: (metadata: Metadata) =>
            typeof metadata?.summary?.text === 'string'
                ? metadata.summary.text
                : 'Voice conversation (system)',
        transformAfterTitle: (metadata: Metadata) => {
            const systemMetadata = {
                ...metadata,
                ...buildVoiceConversationSystemSessionMetadata(),
            };
            return writeVoiceConversationScopeMetadata(systemMetadata, scope);
        },
    });
}

function resolveConversationRetentionLimit(state: any): number {
    const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
    const policy = agentCfg?.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single';
    if (policy === 'single') return 1;
    const raw = Number(agentCfg?.maxWarmRoots ?? 3);
    return Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.floor(raw))) : 3;
}

async function retireVoiceConversationSession(sessionId: string): Promise<void> {
    await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
        ...metadata,
        ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY, hidden: true }),
        voiceAgentRunV1: null,
    }));
}

async function applyVoiceConversationRetentionPolicy(params: Readonly<{ keepSessionId: string }>): Promise<void> {
    const keepSessionId = normalizeNonEmptyString(params.keepSessionId);
    if (!keepSessionId) return;

    const state: any = storage.getState();
    const limit = resolveConversationRetentionLimit(state);
    if (!Number.isFinite(limit) || limit <= 0) return;

    const sessions = listVoiceConversationSystemSessions(state)
        .filter((candidate) => candidate.sessionId !== keepSessionId)
        .map((candidate) => ({ id: candidate.sessionId, updatedAt: candidate.updatedAt }));

    if (limit === 1) {
        await Promise.all(sessions.map((session) => retireVoiceConversationSession(session.id).catch(() => {})));
        return;
    }

    sessions.sort((left, right) => (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id));
    const keepCount = Math.max(0, limit - 1);
    const toRetire = sessions.slice(keepCount);
    await Promise.all(toRetire.map((session) => retireVoiceConversationSession(session.id).catch(() => {})));
}

async function retireLegacyVoiceConversationSessions(params: Readonly<{
    machineId: string;
    directory: string;
}>): Promise<void> {
    const machineId = normalizeNonEmptyString(params.machineId);
    const directory = normalizeNonEmptyString(params.directory);
    if (!machineId || !directory) return;

    const state: any = storage.getState();
    const toRetire = listVoiceConversationSystemSessions(state)
        .filter((candidate) =>
            candidate.legacyLinked
            && normalizeNonEmptyString((candidate.metadata as any)?.machineId) === machineId
            && normalizeNonEmptyString((candidate.metadata as any)?.path) === directory,
        )
        .map((candidate) => candidate.sessionId);

    await Promise.all(toRetire.map((sessionId) => retireVoiceConversationSession(sessionId).catch(() => {})));
}

export async function ensureVoiceConversationSessionForVoiceHome(): Promise<string> {
    const target = await waitForVoiceHomeSpawnTarget(VOICE_HOME_SPAWN_TARGET_WAIT_TIMEOUT_MS);
    if (!target) {
        throw Object.assign(new Error('voice_conversation_spawn_target_missing'), { code: 'VOICE_CONVERSATION_TARGET_MISSING' });
    }

    assertTargetMachineReadyForSpawn(target.machineId);
    await retireLegacyVoiceConversationSessions(target).catch(() => {});
    const state: any = storage.getState();

    const bestExisting = findPreferredVoiceConversationSystemSession(
        state,
        (candidate) =>
            !candidate.legacyLinked
            && candidate.reusable
            && normalizeNonEmptyString((candidate.metadata as any)?.machineId) === target.machineId
            && normalizeNonEmptyString((candidate.metadata as any)?.path) === target.directory
            && matchesVoiceConversationScope(candidate.metadata ?? null, { kind: 'voice_home' }),
    );

    if (bestExisting) {
        persistVoiceAutoTargetMachineId(target.machineId);
        await touchVoiceConversationSessionWithScope(bestExisting.sessionId, { kind: 'voice_home' }).catch(() => {});
        await applyVoiceConversationRetentionPolicy({ keepSessionId: bestExisting.sessionId }).catch(() => {});
        return bestExisting.sessionId;
    }

    const backendTarget = await resolveVoiceConversationBackendTarget(state, target.machineId);
    const serverId = getActiveServerSnapshot().serverId;
    const spawned = await machineSpawnNewSession({
        machineId: target.machineId,
        directory: target.directory,
        spawnAttemptKey: createSpawnAttemptKey('voice.conversation.home', {
            machineId: target.machineId,
            directory: target.directory,
            backendTarget,
            serverId,
            scope: { kind: 'voice_home' },
        }),
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
        backendTarget,
        serverId,
    });

    if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
        throw toVoiceConversationSpawnError(spawned);
    }

    await sync.refreshSessions();
    await waitForSessionMetadata(spawned.sessionId, 15_000);
    persistVoiceAutoTargetMachineId(target.machineId);
    await touchVoiceConversationSessionWithScope(spawned.sessionId, { kind: 'voice_home' }).catch(() => {});
    await applyVoiceConversationRetentionPolicy({ keepSessionId: spawned.sessionId }).catch(() => {});
    return spawned.sessionId;
}

export async function ensureVoiceConversationSessionId(): Promise<string> {
    if (ensurePromise) return await ensurePromise;

    ensurePromise = (async () => {
        try {
            return await ensureVoiceConversationSessionForVoiceHome();
        } finally {
            ensurePromise = null;
        }
    })();

    return await ensurePromise;
}

export async function ensureVoiceConversationSessionForSessionRoot(params: Readonly<{ sessionId: string }>): Promise<string> {
    const sessionId = normalizeNonEmptyString(params.sessionId);
    if (!sessionId) throw new Error('voice_conversation_session_target_missing');

    const target = await resolveSessionRootTarget(sessionId);
    const machineId = target?.machineId ?? null;
    const directory = target?.directory ?? null;
    if (!machineId || !directory) throw new Error('voice_conversation_session_target_missing');
    assertTargetMachineReadyForSpawn(machineId);

    await retireLegacyVoiceConversationSessions({ machineId, directory }).catch(() => {});
    const state: any = storage.getState();

    const reusableSessionId = findVoiceConversationSessionId(state);
    if (reusableSessionId) {
        const reusableMetadata = resolveVoiceConversationSessionMetadataFromState(state, reusableSessionId) as any;
        if (
            isVoiceConversationSystemSessionMetadata(reusableMetadata)
            && normalizeNonEmptyString(reusableMetadata?.machineId) === machineId
            && normalizeNonEmptyString(reusableMetadata?.path) === directory
            && matchesVoiceConversationScope(reusableMetadata ?? null, { kind: 'session_root', sessionRootId: sessionId })
        ) {
            await touchVoiceConversationSessionWithScope(reusableSessionId, { kind: 'session_root', sessionRootId: sessionId }).catch(() => {});
            await applyVoiceConversationRetentionPolicy({ keepSessionId: reusableSessionId }).catch(() => {});
            return reusableSessionId;
        }
    }

    const bestExisting = findPreferredVoiceConversationSystemSession(
        state,
        (candidate) =>
            !candidate.legacyLinked
            && candidate.reusable
            && normalizeNonEmptyString((candidate.metadata as any)?.machineId) === machineId
            && normalizeNonEmptyString((candidate.metadata as any)?.path) === directory
            && matchesVoiceConversationScope(candidate.metadata ?? null, { kind: 'session_root', sessionRootId: sessionId }),
    );

    if (bestExisting) {
        await touchVoiceConversationSessionWithScope(bestExisting.sessionId, { kind: 'session_root', sessionRootId: sessionId }).catch(() => {});
        await applyVoiceConversationRetentionPolicy({ keepSessionId: bestExisting.sessionId }).catch(() => {});
        return bestExisting.sessionId;
    }

    const backendTarget = await resolveVoiceConversationBackendTarget(state, machineId);
    const serverId = getActiveServerSnapshot().serverId;
    const spawned = await machineSpawnNewSession({
        machineId,
        directory,
        spawnAttemptKey: createSpawnAttemptKey('voice.conversation.session-root', {
            machineId,
            directory,
            backendTarget,
            serverId,
            scope: { kind: 'session_root', sessionRootId: sessionId },
        }),
        transcriptStorage: 'persisted',
        backendTarget,
        serverId,
    });

    if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
        throw toVoiceConversationSpawnError(spawned);
    }

    await sync.refreshSessions();
    await waitForSessionMetadata(spawned.sessionId, 15_000);
    await touchVoiceConversationSessionWithScope(spawned.sessionId, { kind: 'session_root', sessionRootId: sessionId }).catch(() => {});
    await applyVoiceConversationRetentionPolicy({ keepSessionId: spawned.sessionId }).catch(() => {});

    return spawned.sessionId;
}
