import type { HandoffSurfaceV1 } from '@happier-dev/agents';
import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

import type { SessionHandoffContribution } from './agentRuntimeContribution';

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFunction<TFunction extends (...args: never[]) => unknown>(
    value: unknown,
): TFunction | null {
    return typeof value === 'function' ? value as TFunction : null;
}

export function readSessionHandoffContribution(value: unknown): SessionHandoffContribution | null {
    if (!isRecord(value)) return null;
    const surface = readFunction<NonNullable<SessionHandoffContribution['surface']>>(value.surface);
    const resolveReplayChildLaunch = readFunction<
        NonNullable<SessionHandoffContribution['resolveReplayChildLaunch']>
    >(value.resolveReplayChildLaunch);
    const agentBundleRecords = isRecord(value.agentBundleRecords) ? value.agentBundleRecords : null;
    const extract = readFunction<
        NonNullable<NonNullable<SessionHandoffContribution['agentBundleRecords']>['extract']>
    >(agentBundleRecords?.extract);
    const runtimeLocalMetadata = isRecord(value.runtimeLocalMetadata) ? value.runtimeLocalMetadata : null;
    const buildRuntimeLocalMetadata = readFunction<
        NonNullable<NonNullable<SessionHandoffContribution['runtimeLocalMetadata']>['build']>
    >(runtimeLocalMetadata?.build);
    if (!surface && !resolveReplayChildLaunch && !extract && !buildRuntimeLocalMetadata) return null;
    return {
        ...(surface ? { surface } : {}),
        ...(resolveReplayChildLaunch ? { resolveReplayChildLaunch } : {}),
        ...(extract ? { agentBundleRecords: { extract } } : {}),
        ...(buildRuntimeLocalMetadata
            ? { runtimeLocalMetadata: { build: buildRuntimeLocalMetadata } }
            : {}),
    };
}

export function resolveSessionHandoffSurface(
    contribution: SessionHandoffContribution | null,
    createExec: (workspaceRoot: string) => PluginExecService,
): HandoffSurfaceV1 | null {
    const createSurface = contribution?.surface;
    if (!createSurface) return null;

    const resolveSurface = (workspaceRoot: string): HandoffSurfaceV1 | null => {
        const surface = createSurface({ exec: createExec(workspaceRoot) });
        return surface
            && typeof surface.exportBundle === 'function'
            && typeof surface.importBundle === 'function'
            ? surface
            : null;
    };
    const initialSurface = resolveSurface(process.cwd());
    if (!initialSurface) return null;

    return Object.freeze({
        ...(initialSurface.evaluateAvailability
            ? { evaluateAvailability: initialSurface.evaluateAvailability }
            : {}),
        async exportBundle(request) {
            const surface = resolveSurface(request.directory);
            return surface
                ? await surface.exportBundle(request)
                : {
                    ok: false,
                    code: 'handoff_failed',
                    message: 'Agent handoff export surface became unavailable',
                };
        },
        async importBundle(request) {
            const surface = resolveSurface(request.targetDirectory);
            return surface
                ? await surface.importBundle(request)
                : {
                    ok: false,
                    code: 'handoff_failed',
                    message: 'Agent handoff import surface became unavailable',
                };
        },
    });
}
