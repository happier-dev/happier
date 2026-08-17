import type {
    PluginSessionResourceTargetV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginSurfaceTargetKind } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

/**
 * Phase 1.2 — the canonical surface-target → resource-scope resolver.
 *
 * Replaces the three hardcoded `resourceScope: []` at the host/embedded/RN/
 * hosted-web mounts. A surface declares a `target` (`session`/`project`/`app`/
 * `browser`/`services`, from `surfaceTargets.ts`); this owner
 * derives BOTH the `targetKind` and the `resourceScope` — the set of resource
 * targets the surface is permitted to `requestSessionResource`/`subscribeResource`
 * against. The same scope is used for ALL render modes (embedded/RN/hostedWeb/
 * native host) per §13.5.7 — scope is a property of the surface target, not the
 * renderer.
 */

type UnknownRecord = Readonly<Record<string, unknown>>;

/**
 * Why a descriptor has no resolvable surface target. There is one reason because
 * the host can do only one thing with either shape: a descriptor that names no
 * `kind`, and one that names a `kind` this host does not implement, have both
 * failed to DECLARE a target this host can bind — a different failure from the
 * declared-but-unbindable identity reasons in `pluginSurfaceContext.ts`, and one
 * the surface-placement projection normalizer (`projection.ts`, which already
 * drops any entry whose `target` is not a record) should make unreachable.
 */
export type PluginSurfaceTargetUndeclaredReason = 'surface_target_undeclared';

export type PluginSurfaceResourceScopeResolution =
    | Readonly<{
        declared: true;
        targetKind: PluginSurfaceTargetKind;
        resourceScope: readonly PluginSessionResourceTargetV1[];
    }>
    | Readonly<{ declared: false; reason: PluginSurfaceTargetUndeclaredReason }>;

/**
 * Closure-bound to the target vocabulary: the record below must name every member
 * of `PluginSurfaceTargetKind` (itself derived from the protocol schema), so a kind
 * added to the manifest contract fails to compile here rather than falling into a
 * silent default.
 */
const SURFACE_TARGET_KINDS: ReadonlySet<PluginSurfaceTargetKind> = new Set(
    Object.keys({
        session: true,
        project: true,
        app: true,
        browser: true,
        services: true,
    } satisfies Record<PluginSurfaceTargetKind, true>) as readonly PluginSurfaceTargetKind[],
);

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

function readPath(target: UnknownRecord, key: string): string | undefined {
    const value = target[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Derive the canonical resource targets reachable from a surface target. Path
 * fields declared on the surface target (e.g. `sessionIdPath`, `workspaceRefIdPath`)
 * are forwarded onto the corresponding resource target's `idPath` so the host can
 * resolve the concrete id from the surface data context at request time.
 */
function deriveResourceScope(
    targetKind: PluginSurfaceTargetKind,
    target: UnknownRecord,
): readonly PluginSessionResourceTargetV1[] {
    switch (targetKind) {
        case 'session': {
            const idPath = readPath(target, 'sessionIdPath');
            return Object.freeze([
                idPath ? { kind: 'session', idPath } : { kind: 'session' },
            ]);
        }
        case 'project': {
            // A project surface reaches both its workspace ref and (optionally) its
            // owning session context.
            const scope: PluginSessionResourceTargetV1[] = [];
            const workspaceIdPath = readPath(target, 'workspaceRefIdPath');
            if (workspaceIdPath) {
                scope.push({ kind: 'workspace', idPath: workspaceIdPath });
            }
            return Object.freeze(scope);
        }
        case 'services': {
            const idPath = readPath(target, 'sessionIdPath');
            const scope: PluginSessionResourceTargetV1[] = [
                idPath ? { kind: 'session', idPath } : { kind: 'session' },
            ];
            // Services surfaces inspect local services/access endpoints.
            return Object.freeze(scope);
        }
        case 'browser':
        case 'app':
            // App + browser surfaces have no derivable session-resource scope from
            // the surface target alone (browser scope is the browser-view, handled
            // by the browser host-action scope; app surfaces are global).
            return Object.freeze([]);
    }
}

/**
 * Resolve the `{ targetKind, resourceScope }` a surface descriptor's declared
 * `target` allows.
 *
 * A missing or unrecognized `kind` resolves to `declared: false` — it is NOT read
 * as `app`. `app` is a real, reachable public target: reporting it for a descriptor
 * that never declared it would make a surface the host cannot place look exactly
 * like a genuine global app surface, which is the same untruth §3.2 r0.9 removed
 * from the identity-binding layer that consumes this value. The host withholds
 * admission instead (see `PluginSurfaceHost`), and no resource scope is ever
 * derived from an undeclared target.
 */
export function resolveResourceScope(
    surfaceTarget: unknown,
): PluginSurfaceResourceScopeResolution {
    const target = asRecord(surfaceTarget);
    const rawKind = target && typeof target.kind === 'string' ? target.kind : null;
    if (!target || !rawKind || !SURFACE_TARGET_KINDS.has(rawKind as PluginSurfaceTargetKind)) {
        return Object.freeze({ declared: false as const, reason: 'surface_target_undeclared' as const });
    }
    const targetKind = rawKind as PluginSurfaceTargetKind;
    return Object.freeze({
        declared: true as const,
        targetKind,
        resourceScope: deriveResourceScope(targetKind, target),
    });
}
