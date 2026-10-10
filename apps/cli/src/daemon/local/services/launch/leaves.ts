import type {
    DaemonLocalServiceLauncherHistoryClearResponseV1,
    DaemonLocalServiceLauncherLeafRequestV1,
    DaemonLocalServiceLauncherOpenPreviewResponseV1,
    DaemonLocalServiceLauncherRegisterPreviewResponseV1,
    LocalServiceLaunchTargetV1,
    LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol';

import type { LocalServiceLauncherFeed } from './feed';
import type { LocalServicePreviewRoutes } from '../preview/routes';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { DaemonLocalServicePreviewOpenOrCreateRequestV1Schema } from '@happier-dev/protocol/local/services/preview/v1';

/**
 * Launcher leaf actions (LSV-1): `openPreview` (safe "open in browser"), `registerPreview`
 * (persist a loopback launcher target as a private preview), and `history.clear` (dismiss the
 * launcher feed history). These are the previously surfaced-but-unbacked launcher leaves; each
 * now resolves through a real daemon owner rather than `local_services_runtime_action_unbacked`.
 */

const PREVIEW_TARGET_PREFIX = 'preview:';

/**
 * Launcher feed history (recents) store. Records launch-target ids the launcher has surfaced as
 * recents and supports clearing them; the feed consults {@link isDismissed} so cleared entries
 * stop reappearing. Kept in-memory and daemon-owned so there is a single history owner.
 */
export type LocalServiceLauncherHistoryStore = Readonly<{
    record(targetId: string): void;
    list(): readonly string[];
    isDismissed(targetId: string): boolean;
    dismiss(targetId: string): void;
    clear(targetIds?: readonly string[]): number;
}>;

export function createLocalServiceLauncherHistoryStore(): LocalServiceLauncherHistoryStore {
    const recents = new Set<string>();
    const dismissed = new Set<string>();
    return {
        record(targetId) {
            recents.add(targetId);
            dismissed.delete(targetId);
        },
        list() {
            return [...recents].filter((id) => !dismissed.has(id));
        },
        isDismissed(targetId) {
            return dismissed.has(targetId);
        },
        dismiss(targetId) {
            dismissed.add(targetId);
            recents.delete(targetId);
        },
        clear(targetIds) {
            const selected = targetIds ? new Set(targetIds) : undefined;
            const active = [...recents].filter((id) => !dismissed.has(id) && (!selected || selected.has(id)));
            for (const id of active) { dismissed.add(id); recents.delete(id); }
            return active.length;
        },
    };
}

export type LocalServiceLauncherLeafRoutes = Readonly<{
    openPreview(
        request: DaemonLocalServiceLauncherLeafRequestV1,
        context?: RpcHandlerContext,
    ): Promise<DaemonLocalServiceLauncherOpenPreviewResponseV1>;
    registerPreview(
        request: DaemonLocalServiceLauncherLeafRequestV1,
        signal?: AbortSignal,
        context?: RpcHandlerContext,
    ): Promise<DaemonLocalServiceLauncherRegisterPreviewResponseV1>;
    clearHistory(
        request: DaemonLocalServiceLauncherLeafRequestV1,
    ): Promise<DaemonLocalServiceLauncherHistoryClearResponseV1>;
}>;

function findTarget(
    snapshot: LocalServiceLauncherSnapshotV1,
    targetId: string,
): LocalServiceLaunchTargetV1 | undefined {
    return snapshot.targets.find((candidate) => candidate.id === targetId);
}

export function createLocalServiceLauncherLeafRoutes(input: Readonly<{
    machineId: string;
    feed: Pick<LocalServiceLauncherFeed, 'getSnapshot'>;
    previewRoutes: Pick<LocalServicePreviewRoutes, 'openOrCreate'> & Partial<Pick<LocalServicePreviewRoutes, 'getSnapshot'>>;
    history: LocalServiceLauncherHistoryStore;
}>): LocalServiceLauncherLeafRoutes {
    async function resolveTarget(
        request: DaemonLocalServiceLauncherLeafRequestV1,
    ): Promise<Readonly<
        | { ok: true; target: LocalServiceLaunchTargetV1 }
        | { ok: false; reasonCode: string }
    >> {
        if (!request.targetId) return { ok: false, reasonCode: 'launcher_target_required' };
        if (request.machineId !== input.machineId) return { ok: false, reasonCode: 'wrong_machine' };
        const snapshot = await input.feed.getSnapshot(request);
        const target = findTarget(snapshot, request.targetId);
        if (!target) return { ok: false, reasonCode: 'launcher_target_unknown' };
        if (target.machineId !== input.machineId) return { ok: false, reasonCode: 'wrong_machine' };
        return { ok: true, target };
    }

    return {
        async openPreview(request, context) {
            if (context?.machineAdmission || context?.authorization || context?.transportRequestId) {
                if (!input.previewRoutes.getSnapshot) throw new Error('requester_credentials_unavailable');
                await input.previewRoutes.getSnapshot(context);
            }
            const resolved = await resolveTarget(request);
            if (!resolved.ok) {
                return {
                    protocolVersion: 1,
                    status: 'unavailable',
                    targetId: request.targetId ?? '',
                    reasonCode: resolved.reasonCode,
                };
            }
            const { target } = resolved;
            if (target.state === 'unavailable') {
                return {
                    protocolVersion: 1,
                    status: 'unavailable',
                    targetId: target.id,
                    reasonCode: target.unavailableReason ?? 'launcher_target_unavailable',
                };
            }
            if (target.sourceClass?.kind === 'managed_service') {
                const opened = await registerTargetPreview(target, request, context?.signal, context);
                if (opened.status === 'unavailable' || !opened.browserTarget) return {
                    protocolVersion: 1, status: 'unavailable', targetId: target.id,
                    reasonCode: opened.status === 'unavailable' ? opened.reasonCode : 'launcher_target_no_browser_view',
                };
                input.history.record(target.id);
                return { protocolVersion: 1, status: 'opened', targetId: target.id, browserTarget: opened.browserTarget };
            }
            if (!target.browserTarget) {
                return {
                    protocolVersion: 1,
                    status: 'unavailable',
                    targetId: target.id,
                    reasonCode: 'launcher_target_no_browser_view',
                };
            }
            input.history.record(target.id);
            return {
                protocolVersion: 1,
                status: 'opened',
                targetId: target.id,
                browserTarget: target.browserTarget,
            };
        },

        async registerPreview(request, signal, context) {
            if (context?.machineAdmission || context?.authorization || context?.transportRequestId) {
                if (!input.previewRoutes.getSnapshot) throw new Error('requester_credentials_unavailable');
                await input.previewRoutes.getSnapshot(context);
            }
            signal?.throwIfAborted();
            const resolved = await resolveTarget(request);
            if (!resolved.ok) {
                return {
                    protocolVersion: 1,
                    status: 'unavailable',
                    targetId: request.targetId ?? '',
                    reasonCode: resolved.reasonCode,
                };
            }
            const { target } = resolved;
            // Already a registered preview target → idempotent existing.
            if (target.source === 'registered_preview' && target.id.startsWith(PREVIEW_TARGET_PREFIX)) {
                return {
                    protocolVersion: 1,
                    status: 'existing',
                    targetId: target.id,
                    previewId: target.id.slice(PREVIEW_TARGET_PREFIX.length),
                    ...(target.browserTarget ? { browserTarget: target.browserTarget } : {}),
                };
            }
            return registerTargetPreview(target, request, signal, context);
        },

        async clearHistory(request) {
            let cleared = 0;
            if (request.machineId === input.machineId && (request.scope !== 'workspace' || request.workspaceRoot || request.sessionId)) {
                const scoped = request.scope !== 'machine' && Boolean(request.workspaceRoot || request.sessionId);
                const before = scoped || request.targetId ? await input.feed.getSnapshot({ ...request,
                    ...(scoped ? { requireWorkspaceScope: true as const } : {}),
                }) : undefined;
                cleared = input.history.clear(before?.targets.filter(target => !request.targetId || target.id === request.targetId).map(target => target.id));
            }
            const snapshot = await input.feed.getSnapshot(request);
            return { protocolVersion: 1, cleared, snapshot };
        },
    };

    async function registerTargetPreview(target: LocalServiceLaunchTargetV1, request: DaemonLocalServiceLauncherLeafRequestV1,
        signal?: AbortSignal, context?: RpcHandlerContext): Promise<DaemonLocalServiceLauncherRegisterPreviewResponseV1> {
        const source = target.sourceClass;
        const parsed = DaemonLocalServicePreviewOpenOrCreateRequestV1Schema.safeParse(source?.kind === 'managed_service'
            ? { machineId: input.machineId, serviceTarget: { kind: 'managed_service', machineId: target.machineId,
                managedServiceId: source.managedServiceId, workspaceId: target.workspaceId, declaration: target.declaration, cwd: target.cwd } }
            : source?.kind === 'inventory_entry' ? { machineId: input.machineId,
                ...(request.sessionId ? { sessionId: request.sessionId } : {}), inventoryEntryId: source.inventoryEntryId } : null);
        if (!parsed.success) return { protocolVersion: 1, status: 'unavailable', targetId: target.id, reasonCode: 'preview_target_unregisterable' };
        const result = await input.previewRoutes.openOrCreate(parsed.data, signal, context);
        if (!result.ok) return { protocolVersion: 1, status: 'unavailable', targetId: target.id, reasonCode: result.reasonCode };
        return { protocolVersion: 1, status: result.response.status === 'existing' ? 'existing' : 'registered', targetId: target.id,
            previewId: result.response.preview.previewId,
            ...(result.response.preview.resource.browserTarget ? { browserTarget: result.response.preview.resource.browserTarget } : {}) };
    }
}
