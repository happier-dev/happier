import { machineCapabilitiesInvoke } from './capabilities';
import { PreflightSessionCatalogsV1Schema, type PreflightSessionCatalogsV1, SessionSkillCatalogListResponseV1Schema, SessionVendorPluginCatalogListResponseV1Schema, type SessionSkillCatalogListResponseV1, type SessionVendorPluginCatalogListResponseV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { storage } from '@/sync/domains/state/storage';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type MachineSessionCatalogProbeParams = Readonly<{
    machineId: string;
    serverId: string;
    accountId?: string | null;
    agentId: string;
    backendTarget: BackendTargetRefV2;
    capabilityParams: Readonly<Record<string, unknown>>;
}>;

/** An unsupported older daemon has no native pre-session catalog; transport failures retry. */
export async function probeMachineSessionCatalogs(
    params: MachineSessionCatalogProbeParams,
): Promise<PreflightSessionCatalogsV1 | null> {
    const result = await machineCapabilitiesInvoke(params.machineId, {
        id: `cli.${params.agentId}`,
        method: 'probeCatalogs',
        params: { ...params.capabilityParams, backendTarget: params.backendTarget },
    }, {
        serverId: params.serverId,
        accountId: params.accountId,
        ...(typeof params.capabilityParams.timeoutMs === 'number' ? { timeoutMs: params.capabilityParams.timeoutMs } : {}),
    });
    if (!result.supported) {
        if (result.reason === 'not-supported') return null;
        throw new Error('Pre-session catalog transport unavailable');
    }
    if (!result.response.ok) {
        if (result.response.error.code === 'unsupported-method') return null;
        throw new Error(`Pre-session catalog discovery failed (${result.response.error.code ?? 'unknown'})`);
    }
    const parsed = PreflightSessionCatalogsV1Schema.safeParse(result.response.result);
    if (!parsed.success) throw new Error('Invalid pre-session catalog response');
    return parsed.data;
}

export type SessionSuggestionCatalogRequest = Readonly<{
    vendorPlugins?: boolean;
    skills?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSessionCwd(sessionId: string): string | undefined {
    const session = storage.getState().sessions[sessionId];
    const path = session ? readSessionOwnerMetadataView(session)?.path : null;
    return typeof path === 'string' && path.trim().length > 0 ? path.trim() : undefined;
}

function isInactiveSession(sessionId: string): boolean {
    return storage.getState().sessions[sessionId]?.active === false;
}

function hasCatalogSnapshot(metadata: unknown, key: 'sessionVendorPluginCatalogV1' | 'sessionSkillCatalogV1'): boolean {
    if (!isRecord(metadata)) return false;
    const value = metadata[key];
    if (Array.isArray(value)) return true;
    if (!isRecord(value)) return false;
    // A failed observation remains visible, but is not a successful snapshot.
    if (typeof value.diagnostic === 'string') return false;
    if (value.unsupported === true) return true;
    if (key === 'sessionVendorPluginCatalogV1') {
        return Array.isArray(value.vendorPlugins) || Array.isArray(value.plugins) || Array.isArray(value.items);
    }
    return Array.isArray(value.skills) || Array.isArray(value.items);
}

async function listVendorPluginCatalog(
    sessionId: string,
    cwd: string | undefined,
    signal: AbortSignal | undefined,
): Promise<SessionVendorPluginCatalogListResponseV1 | undefined> {
    try {
        const response = isInactiveSession(sessionId)
            ? await listInactiveVendorPluginCatalog(sessionId, signal)
            : await sessionRpcWithServerScope<unknown, { cwd?: string }>({
                sessionId,
                serverId: resolvePreferredServerIdForSessionId(sessionId),
                method: SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST,
                payload: cwd ? { cwd } : {},
                signal,
            });
        const parsed = SessionVendorPluginCatalogListResponseV1Schema.safeParse(response);
        if (parsed.success) return parsed.data;
    } catch {
        return undefined;
    }
    return undefined;
}

async function listSkillCatalog(
    sessionId: string,
    cwd: string | undefined,
    signal: AbortSignal | undefined,
): Promise<SessionSkillCatalogListResponseV1 | undefined> {
    try {
        const response = isInactiveSession(sessionId)
            ? await listInactiveSkillCatalog(sessionId, signal)
            : await sessionRpcWithServerScope<unknown, { cwd?: string }>({
                sessionId,
                serverId: resolvePreferredServerIdForSessionId(sessionId),
                method: SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST,
                payload: cwd ? { cwd } : {},
                signal,
            });
        if (isRecord(response) && response.ok === false) {
            return SessionSkillCatalogListResponseV1Schema.parse({ skills: [], diagnostic: typeof response.errorCode === 'string'
                ? response.errorCode : 'session_skill_catalog_unavailable' });
        }
        const parsed = SessionSkillCatalogListResponseV1Schema.safeParse(response);
        if (parsed.success) return parsed.data;
        return SessionSkillCatalogListResponseV1Schema.parse({ skills: [], diagnostic: 'invalid_session_skill_catalog_response' });
    } catch (error: unknown) {
        if (signal?.aborted) return undefined;
        return SessionSkillCatalogListResponseV1Schema.parse({ skills: [], diagnostic: readRpcErrorCode(error) ?? 'session_skill_catalog_unavailable' });
    }
}

async function listInactiveVendorPluginCatalog(sessionId: string, signal: AbortSignal | undefined): Promise<unknown> {
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) return undefined;
    return await machineRpcWithServerScope<unknown, { sessionId: string; cwd?: string }>({
        machineId: target.machineId,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
        method: RPC_METHODS.DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST,
        payload: { sessionId, cwd: target.basePath },
        signal,
    });
}

async function listInactiveSkillCatalog(sessionId: string, signal: AbortSignal | undefined): Promise<unknown> {
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) return undefined;
    return await machineRpcWithServerScope<unknown, { sessionId: string; cwd?: string }>({
        machineId: target.machineId,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
        method: RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST,
        payload: { sessionId, cwd: target.basePath },
        signal,
    });
}

function applyCatalogSnapshots(
    sessionId: string,
    snapshots: Readonly<{
        vendorPluginCatalog?: SessionVendorPluginCatalogListResponseV1;
        skillCatalog?: SessionSkillCatalogListResponseV1;
    }>,
): void {
    if (!snapshots.vendorPluginCatalog && !snapshots.skillCatalog) return;
    const session = storage.getState().sessions[sessionId];
    if (!session) return;
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (metadataLayoutVersion < 0) return;
    const metadata = MetadataSchema.parse({
        ...(readSessionOwnerMetadataView(session) ?? {}),
        ...(snapshots.vendorPluginCatalog
            ? { sessionVendorPluginCatalogV1: snapshots.vendorPluginCatalog }
            : {}),
        ...(snapshots.skillCatalog
            ? { sessionSkillCatalogV1: snapshots.skillCatalog }
            : {}),
    });
    storage.getState().applySessions([
        {
            ...session,
            ...(metadataLayoutVersion === 1
                ? { ownerMetadataView: metadata }
                : { metadata }),
        },
    ], 'projection');
}

const catalogReads = createScopedResolutionSingleFlight<void>();

function readSessionCatalogTargetKey(sessionId: string): string {
    const inactive = isInactiveSession(sessionId);
    const machine = inactive ? readMachineControlTargetForSession(sessionId) : null;
    return JSON.stringify([resolvePreferredServerIdForSessionId(sessionId), sessionId,
        inactive, readSessionCwd(sessionId), machine?.machineId, machine?.basePath]);
}

export async function ensureSessionSuggestionCatalogs(
    sessionId: string,
    request: SessionSuggestionCatalogRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<void> {
    if (options?.signal?.aborted) return;
    const session = storage.getState().sessions[sessionId];
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    const shouldLoadVendorPlugins = request.vendorPlugins === true
        && !hasCatalogSnapshot(metadata, 'sessionVendorPluginCatalogV1');
    const shouldLoadSkills = request.skills === true
        && !hasCatalogSnapshot(metadata, 'sessionSkillCatalogV1');

    if (!shouldLoadVendorPlugins && !shouldLoadSkills) return;

    const targetKey = readSessionCatalogTargetKey(sessionId);
    const activeAccount = captureActiveServerAccountScopeLifetime();
    const serverId = resolvePreferredServerIdForSessionId(sessionId);
    const account = activeAccount && (!serverId || areServerProfileIdentifiersEquivalent(serverId, activeAccount.scope.serverId))
        ? activeAccount : null;
    const load = async (signal?: AbortSignal) => {
        if (signal?.aborted || account?.isCurrent() === false || readSessionCatalogTargetKey(sessionId) !== targetKey) return;
        const cwd = readSessionCwd(sessionId);
        const [vendorPluginCatalog, skillCatalog] = await Promise.all([
            shouldLoadVendorPlugins ? listVendorPluginCatalog(sessionId, cwd, signal) : Promise.resolve(undefined),
            shouldLoadSkills ? listSkillCatalog(sessionId, cwd, signal) : Promise.resolve(undefined),
        ]);
        if (signal?.aborted || account?.isCurrent() === false || readSessionCatalogTargetKey(sessionId) !== targetKey) return;
        const current = storage.getState().sessions[sessionId];
        const currentMetadata = current ? readSessionOwnerMetadataView(current) : null;
        applyCatalogSnapshots(sessionId, {
            ...(vendorPluginCatalog && !hasCatalogSnapshot(currentMetadata, 'sessionVendorPluginCatalogV1') ? { vendorPluginCatalog } : {}),
            ...(skillCatalog && !hasCatalogSnapshot(currentMetadata, 'sessionSkillCatalogV1') ? { skillCatalog } : {}),
        });
    };
    try {
        // Only the existing admitted Account lifetime can share a request. Other
        // Homes keep the same reader without borrowing the focused Account's scope.
        if (account) await catalogReads.run(JSON.stringify([targetKey, shouldLoadVendorPlugins, shouldLoadSkills]),
            load, { scope: account, signal: options?.signal });
        else await load(options?.signal);
    } catch (error) {
        if (!options?.signal?.aborted) throw error;
    }
}
