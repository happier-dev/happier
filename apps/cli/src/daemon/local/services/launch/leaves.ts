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

/**
 * Launcher leaf actions (LSV-1): `openPreview` (safe "open in browser"), `registerPreview`
 * (persist a loopback launcher target as a private preview), and `history.clear` (dismiss the
 * launcher feed history). These are the previously surfaced-but-unbacked launcher leaves; each
 * now resolves through a real daemon owner rather than `local_services_runtime_action_unbacked`.
 */

const INVENTORY_TARGET_PREFIX = 'inventory:';
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
    clear(): number;
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
        clear() {
            const active = [...recents].filter((id) => !dismissed.has(id));
            for (const id of active) dismissed.add(id);
            recents.clear();
            return active.length;
        },
    };
}

export type LocalServiceLauncherLeafRoutes = Readonly<{
    openPreview(
        request: DaemonLocalServiceLauncherLeafRequestV1,
    ): Promise<DaemonLocalServiceLauncherOpenPreviewResponseV1>;
    registerPreview(
        request: DaemonLocalServiceLauncherLeafRequestV1,
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
    previewRoutes: Pick<LocalServicePreviewRoutes, 'openOrCreate'>;
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
        const snapshot = await input.feed.getSnapshot(
            request.sessionId ? { sessionId: request.sessionId } : undefined,
        );
        const target = findTarget(snapshot, request.targetId);
        if (!target) return { ok: false, reasonCode: 'launcher_target_unknown' };
        if (target.machineId !== input.machineId) return { ok: false, reasonCode: 'wrong_machine' };
        return { ok: true, target };
    }

    return {
        async openPreview(request) {
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

        async registerPreview(request) {
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
            if (target.id.startsWith(PREVIEW_TARGET_PREFIX)) {
                return {
                    protocolVersion: 1,
                    status: 'existing',
                    targetId: target.id,
                    previewId: target.id.slice(PREVIEW_TARGET_PREFIX.length),
                    ...(target.browserTarget ? { browserTarget: target.browserTarget } : {}),
                };
            }
            // A detected loopback inventory entry → register through the canonical preview owner.
            if (target.id.startsWith(INVENTORY_TARGET_PREFIX)) {
                const inventoryEntryId = target.id.slice(INVENTORY_TARGET_PREFIX.length);
                const result = await input.previewRoutes.openOrCreate({
                    machineId: input.machineId,
                    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
                    inventoryEntryId,
                });
                if (!result.ok) {
                    return {
                        protocolVersion: 1,
                        status: 'unavailable',
                        targetId: target.id,
                        reasonCode: result.reasonCode,
                    };
                }
                return {
                    protocolVersion: 1,
                    status: result.response.status === 'existing' ? 'existing' : 'registered',
                    targetId: target.id,
                    previewId: result.response.preview.previewId,
                    ...(result.response.preview.resource.browserTarget
                        ? { browserTarget: result.response.preview.resource.browserTarget }
                        : {}),
                };
            }
            return {
                protocolVersion: 1,
                status: 'unavailable',
                targetId: target.id,
                reasonCode: 'preview_target_unregisterable',
            };
        },

        async clearHistory(request) {
            const cleared = request.machineId === input.machineId ? input.history.clear() : 0;
            const snapshot = await input.feed.getSnapshot(
                request.sessionId ? { sessionId: request.sessionId } : undefined,
            );
            return { protocolVersion: 1, cleared, snapshot };
        },
    };
}
