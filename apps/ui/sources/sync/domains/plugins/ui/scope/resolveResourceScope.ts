import type {
    PluginSessionResourceTargetV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginSurfaceTargetKind } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

/**
 * Phase 1.2 — the canonical surface-target → resource-scope resolver.
 *
 * Replaces the three hardcoded `resourceScope: []` at the host/embedded/RN/
 * hosted-web mounts. A surface declares a `target` (`session`/`workspace`/
 * `project`/`app`/`browser`/`services`, from `surfaceTargets.ts`); this owner
 * derives BOTH the `targetKind` and the `resourceScope` — the set of resource
 * targets the surface is permitted to `requestSessionResource`/`subscribeResource`
 * against. The same scope is used for ALL render modes (embedded/RN/hostedWeb/
 * native host) per §13.5.7 — scope is a property of the surface target, not the
 * renderer.
 */

type UnknownRecord = Readonly<Record<string, unknown>>;

export type PluginSurfaceResourceScopeResolution = Readonly<{
    targetKind: PluginSurfaceTargetKind;
    resourceScope: readonly PluginSessionResourceTargetV1[];
}>;

const SURFACE_TARGET_KINDS: ReadonlySet<PluginSurfaceTargetKind> = new Set<PluginSurfaceTargetKind>([
    'session',
    'workspace',
    'project',
    'app',
    'browser',
    'services',
]);

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
        case 'workspace': {
            const idPath = readPath(target, 'workspaceRefIdPath');
            return idPath ? Object.freeze([{ kind: 'workspace', idPath }]) : Object.freeze([]);
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
        default:
            // App + browser surfaces have no derivable session-resource scope from
            // the surface target alone (browser scope is the browser-view, handled
            // by the browser host-action scope; app surfaces are global).
            return Object.freeze([]);
    }
}

/**
 * Resolve the `{ targetKind, resourceScope }` for a surface descriptor's declared
 * `target`. Fails closed to an `app`-scoped, empty-resource-scope resolution for
 * a missing/unknown target (the safe default — no session-resource reach).
 */
export function resolveResourceScope(
    surfaceTarget: unknown,
): PluginSurfaceResourceScopeResolution {
    const target = asRecord(surfaceTarget);
    const rawKind = target && typeof target.kind === 'string' ? target.kind : null;
    const targetKind: PluginSurfaceTargetKind =
        rawKind && SURFACE_TARGET_KINDS.has(rawKind as PluginSurfaceTargetKind)
            ? (rawKind as PluginSurfaceTargetKind)
            : 'app';
    if (!target || targetKind === 'app') {
        return Object.freeze({ targetKind, resourceScope: Object.freeze([]) });
    }
    return Object.freeze({
        targetKind,
        resourceScope: deriveResourceScope(targetKind, target),
    });
}
