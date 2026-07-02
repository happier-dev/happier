import {
    SessionSkillCatalogListResponseV1Schema,
    SessionVendorPluginCatalogListResponseV1Schema,
    type SessionSkillCatalogListResponseV1,
    type SessionVendorPluginCatalogListResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { storage } from '@/sync/domains/state/storage';
import { MetadataSchema } from '@/sync/domains/state/storageTypes';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { readMachineControlTargetForSession } from './sessionMachineTarget';

export type SessionSuggestionCatalogRequest = Readonly<{
    vendorPlugins?: boolean;
    skills?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSessionCwd(sessionId: string): string | undefined {
    const path = storage.getState().sessions[sessionId]?.metadata?.path;
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
    if (value.unsupported === true) return true;
    if (key === 'sessionVendorPluginCatalogV1') {
        return Array.isArray(value.vendorPlugins) || Array.isArray(value.plugins) || Array.isArray(value.items);
    }
    return Array.isArray(value.skills) || Array.isArray(value.items);
}

async function listVendorPluginCatalog(
    sessionId: string,
    cwd: string | undefined,
): Promise<SessionVendorPluginCatalogListResponseV1 | undefined> {
    try {
        const response = isInactiveSession(sessionId)
            ? await listInactiveVendorPluginCatalog(sessionId, cwd)
            : await sessionRpcWithServerScope<unknown, { cwd?: string }>({
                sessionId,
                serverId: resolvePreferredServerIdForSessionId(sessionId),
                method: SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST,
                payload: cwd ? { cwd } : {},
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
): Promise<SessionSkillCatalogListResponseV1 | undefined> {
    try {
        const response = isInactiveSession(sessionId)
            ? await listInactiveSkillCatalog(sessionId, cwd)
            : await sessionRpcWithServerScope<unknown, { cwd?: string }>({
                sessionId,
                serverId: resolvePreferredServerIdForSessionId(sessionId),
                method: SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST,
                payload: cwd ? { cwd } : {},
            });
        const parsed = SessionSkillCatalogListResponseV1Schema.safeParse(response);
        if (parsed.success) return parsed.data;
    } catch {
        return undefined;
    }
    return undefined;
}

async function listInactiveVendorPluginCatalog(sessionId: string, cwd: string | undefined): Promise<unknown> {
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) return undefined;
    return await machineRpcWithServerScope<unknown, { sessionId: string; cwd?: string }>({
        machineId: target.machineId,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
        method: RPC_METHODS.DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST,
        payload: { sessionId, ...(cwd ? { cwd } : {}) },
    });
}

async function listInactiveSkillCatalog(sessionId: string, cwd: string | undefined): Promise<unknown> {
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) return undefined;
    return await machineRpcWithServerScope<unknown, { sessionId: string; cwd?: string }>({
        machineId: target.machineId,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
        method: RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST,
        payload: { sessionId, ...(cwd ? { cwd } : {}) },
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
    const metadata = MetadataSchema.parse({
        ...(session.metadata ?? {}),
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
            metadata,
        },
    ]);
}

export async function ensureSessionSuggestionCatalogs(
    sessionId: string,
    request: SessionSuggestionCatalogRequest,
): Promise<void> {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    const shouldLoadVendorPlugins = request.vendorPlugins === true
        && !hasCatalogSnapshot(metadata, 'sessionVendorPluginCatalogV1');
    const shouldLoadSkills = request.skills === true
        && !hasCatalogSnapshot(metadata, 'sessionSkillCatalogV1');

    if (!shouldLoadVendorPlugins && !shouldLoadSkills) return;

    const cwd = readSessionCwd(sessionId);
    const [vendorPluginCatalog, skillCatalog] = await Promise.all([
        shouldLoadVendorPlugins ? listVendorPluginCatalog(sessionId, cwd) : Promise.resolve(undefined),
        shouldLoadSkills ? listSkillCatalog(sessionId, cwd) : Promise.resolve(undefined),
    ]);

    applyCatalogSnapshots(sessionId, {
        ...(vendorPluginCatalog ? { vendorPluginCatalog } : {}),
        ...(skillCatalog ? { skillCatalog } : {}),
    });
}
