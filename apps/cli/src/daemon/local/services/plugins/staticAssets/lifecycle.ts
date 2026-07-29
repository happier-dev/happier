import { resolveHostedWebAssetRuntime, type HostedWebAssetRuntimeResolutionCode } from '@/plugins/install/ui/hostedWebAssets';
import type { PluginHostedWebSecurityPolicyV1 } from '@happier-dev/protocol/plugins/ui';

import {
    startHostedWebStaticAssetServer,
    type HostedWebStaticAssetServerHandle,
    type HostedWebStaticAssetServerVerifyResult,
    type StartHostedWebStaticAssetServerInput,
} from './server';

export type HostedWebStaticAssetLifecycleContribution = Readonly<{
    pluginId: string;
    contributionId: string;
    sessionId: string;
    machineId: string;
    title: string;
    installedRoot: string;
    runtimeMode: unknown;
    artifactManifest: unknown;
    manifestContributionId?: string;
    artifact?: unknown;
    routeMode?: 'hostOrigin' | 'pathFallback';
    security: PluginHostedWebSecurityPolicyV1;
    sourceMaps?: StartHostedWebStaticAssetServerInput['sourceMaps'];
}>;

export type HostedWebStaticAssetLifecycleDiagnosticCode =
    | HostedWebAssetRuntimeResolutionCode
    | 'duplicate_static_asset_preview_identity'
    | 'static_asset_server_start_failed'
    | 'static_asset_server_stop_failed';

export type HostedWebStaticAssetLifecycleDiagnostic = Readonly<{
    severity: 'warning' | 'error';
    code: HostedWebStaticAssetLifecycleDiagnosticCode;
    pluginId: string;
    contributionId: string;
    diagnostics: readonly string[];
}>;

export type HostedWebStaticAssetLifecycleActive = Readonly<{
    key: string;
    pluginId: string;
    contributionId: string;
    sessionId: string;
    machineId: string;
    digest: string;
    baseUrl: string;
    previewId: string;
}>;

export type HostedWebStaticAssetLifecycleSyncResult = Readonly<{
    active: readonly HostedWebStaticAssetLifecycleActive[];
    diagnostics: readonly HostedWebStaticAssetLifecycleDiagnostic[];
}>;

export type HostedWebStaticAssetLifecycle = Readonly<{
    sync(contributions: readonly HostedWebStaticAssetLifecycleContribution[]): Promise<HostedWebStaticAssetLifecycleSyncResult>;
    snapshot(): HostedWebStaticAssetLifecycleSyncResult;
    stop(): Promise<void>;
}>;

type ActiveServer = Readonly<{
    key: string;
    fingerprint: string;
    contribution: HostedWebStaticAssetLifecycleContribution;
    digest: string;
    handle: HostedWebStaticAssetServerHandle;
}>;

type ResolvedDesiredServer = Readonly<{
    key: string;
    fingerprint: string;
    contribution: HostedWebStaticAssetLifecycleContribution;
    serverInput: Omit<StartHostedWebStaticAssetServerInput, 'verifyArtifact' | 'registerPreview' | 'unregisterPreview'>;
    digest: string;
}>;

function normalizeIdentityPart(value: string): string {
    return value.trim();
}

function identityKey(input: HostedWebStaticAssetLifecycleContribution): string {
    return [
        normalizeIdentityPart(input.pluginId),
        normalizeIdentityPart(input.contributionId),
        normalizeIdentityPart(input.sessionId),
        normalizeIdentityPart(input.machineId),
    ].join('\0');
}

function sortStrings(values: Iterable<string>): readonly string[] {
    return Object.freeze([...values].sort((a, b) => a.localeCompare(b)));
}

function sourceMapFingerprint(
    sourceMaps: StartHostedWebStaticAssetServerInput['sourceMaps'] | undefined,
): unknown {
    if (!sourceMaps) {
        return null;
    }
    return {
        enabled: sourceMaps.enabled,
        allowedDigests: sourceMaps.allowedDigests
            ? sortStrings(sourceMaps.allowedDigests)
            : [],
    };
}

function contributionFingerprint(input: Readonly<{
    contribution: HostedWebStaticAssetLifecycleContribution;
    assetRootId: string;
    entryPath: string;
    files: readonly string[];
    digest: string;
    routeMode: 'hostOrigin' | 'pathFallback';
    security: PluginHostedWebSecurityPolicyV1;
}>): string {
    return JSON.stringify({
        pluginId: input.contribution.pluginId,
        contributionId: input.contribution.contributionId,
        sessionId: input.contribution.sessionId,
        machineId: input.contribution.machineId,
        title: input.contribution.title,
        installedRoot: input.contribution.installedRoot,
        assetRootId: input.assetRootId,
        entryPath: input.entryPath,
        files: sortStrings(input.files),
        digest: input.digest,
        routeMode: input.routeMode,
        security: input.security,
        sourceMaps: sourceMapFingerprint(input.contribution.sourceMaps),
    });
}

function diagnostic(input: Readonly<{
    contribution: HostedWebStaticAssetLifecycleContribution;
    code: HostedWebStaticAssetLifecycleDiagnosticCode;
    diagnostics?: readonly string[];
    severity?: 'warning' | 'error';
}>): HostedWebStaticAssetLifecycleDiagnostic {
    return Object.freeze({
        severity: input.severity ?? 'error',
        code: input.code,
        pluginId: input.contribution.pluginId,
        contributionId: input.contribution.contributionId,
        diagnostics: Object.freeze([...(input.diagnostics ?? [input.code])]),
    });
}

function toActive(server: ActiveServer): HostedWebStaticAssetLifecycleActive {
    return Object.freeze({
        key: server.key,
        pluginId: server.contribution.pluginId,
        contributionId: server.contribution.contributionId,
        sessionId: server.contribution.sessionId,
        machineId: server.contribution.machineId,
        digest: server.digest,
        baseUrl: server.handle.baseUrl,
        previewId: server.handle.previewResource.previewId,
    });
}

function snapshot(
    activeByKey: ReadonlyMap<string, ActiveServer>,
    diagnostics: readonly HostedWebStaticAssetLifecycleDiagnostic[],
): HostedWebStaticAssetLifecycleSyncResult {
    return Object.freeze({
        active: Object.freeze([...activeByKey.values()]
            .map(toActive)
            .sort((a, b) => a.key.localeCompare(b.key))),
        diagnostics: Object.freeze([...diagnostics]),
    });
}

export type HostedWebStaticAssetLifecycleOptions = Readonly<{
    verifyArtifact: StartHostedWebStaticAssetServerInput['verifyArtifact'];
    registerPreview: NonNullable<StartHostedWebStaticAssetServerInput['registerPreview']>;
    unregisterPreview: NonNullable<StartHostedWebStaticAssetServerInput['unregisterPreview']>;
    startServer?: (
        input: StartHostedWebStaticAssetServerInput,
    ) => Promise<HostedWebStaticAssetServerHandle>;
}>;

export function createHostedWebStaticAssetLifecycle(
    input: HostedWebStaticAssetLifecycleOptions,
): HostedWebStaticAssetLifecycle {
    const activeByKey = new Map<string, ActiveServer>();
    let lastDiagnostics: readonly HostedWebStaticAssetLifecycleDiagnostic[] = Object.freeze([]);
    let stopPromise: Promise<void> | null = null;
    const startServer = input.startServer ?? startHostedWebStaticAssetServer;

    const resolveDesired = (
        contributions: readonly HostedWebStaticAssetLifecycleContribution[],
    ): Readonly<{
        desired: readonly ResolvedDesiredServer[];
        diagnostics: readonly HostedWebStaticAssetLifecycleDiagnostic[];
    }> => {
        const desired: ResolvedDesiredServer[] = [];
        const diagnostics: HostedWebStaticAssetLifecycleDiagnostic[] = [];
        const seenKeys = new Set<string>();

        for (const contribution of contributions) {
            const key = identityKey(contribution);
            const runtime = resolveHostedWebAssetRuntime({
                pluginId: contribution.pluginId,
                contributionId: contribution.contributionId,
                manifestContributionId: contribution.manifestContributionId,
                runtimeMode: contribution.runtimeMode,
                manifest: contribution.artifactManifest,
                artifact: contribution.artifact,
            });
            if (!runtime.ok) {
                diagnostics.push(diagnostic({
                    contribution,
                    code: runtime.code,
                    diagnostics: runtime.diagnostics,
                }));
                continue;
            }
            if (seenKeys.has(key)) {
                diagnostics.push(diagnostic({
                    contribution,
                    code: 'duplicate_static_asset_preview_identity',
                }));
                continue;
            }
            seenKeys.add(key);

            const routeMode = contribution.routeMode ?? 'pathFallback';
            const fingerprint = contributionFingerprint({
                contribution,
                assetRootId: runtime.assetRootId,
                entryPath: runtime.entryPath,
                files: runtime.files,
                digest: runtime.digest,
                routeMode,
                security: contribution.security,
            });
            desired.push(Object.freeze({
                key,
                fingerprint,
                contribution,
                digest: runtime.digest,
                serverInput: Object.freeze({
                    installedRoot: contribution.installedRoot,
                    assetRootId: runtime.assetRootId,
                    entryPath: runtime.entryPath,
                    files: runtime.files,
                    digest: runtime.digest,
                    routeMode,
                    security: contribution.security,
                    sourceMaps: contribution.sourceMaps ?? { enabled: false },
                    preview: Object.freeze({
                        pluginId: contribution.pluginId,
                        contributionId: contribution.contributionId,
                        sessionId: contribution.sessionId,
                        machineId: contribution.machineId,
                        title: contribution.title,
                    }),
                }),
            }));
        }

        return Object.freeze({
            desired: Object.freeze(desired),
            diagnostics: Object.freeze(diagnostics),
        });
    };

    const stopActive = async (
        active: ActiveServer,
        diagnostics: HostedWebStaticAssetLifecycleDiagnostic[],
    ): Promise<void> => {
        try {
            await active.handle.stop();
        } catch {
            diagnostics.push(diagnostic({
                contribution: active.contribution,
                code: 'static_asset_server_stop_failed',
            }));
        }
    };

    const sync = async (
        contributions: readonly HostedWebStaticAssetLifecycleContribution[],
    ): Promise<HostedWebStaticAssetLifecycleSyncResult> => {
        stopPromise = null;
        const resolved = resolveDesired(contributions);
        const diagnostics: HostedWebStaticAssetLifecycleDiagnostic[] = [...resolved.diagnostics];
        const desiredByKey = new Map(resolved.desired.map((desired) => [desired.key, desired]));

        for (const [key, active] of activeByKey) {
            const desired = desiredByKey.get(key);
            if (!desired || desired.fingerprint !== active.fingerprint) {
                activeByKey.delete(key);
                await stopActive(active, diagnostics);
            }
        }

        for (const desired of resolved.desired) {
            const active = activeByKey.get(desired.key);
            if (active && active.fingerprint === desired.fingerprint) {
                continue;
            }
            try {
                const handle = await startServer({
                    ...desired.serverInput,
                    verifyArtifact: input.verifyArtifact,
                    registerPreview: input.registerPreview,
                    unregisterPreview: input.unregisterPreview,
                });
                activeByKey.set(desired.key, Object.freeze({
                    key: desired.key,
                    fingerprint: desired.fingerprint,
                    contribution: desired.contribution,
                    digest: desired.digest,
                    handle,
                }));
            } catch {
                diagnostics.push(diagnostic({
                    contribution: desired.contribution,
                    code: 'static_asset_server_start_failed',
                }));
            }
        }

        lastDiagnostics = Object.freeze(diagnostics);
        return snapshot(activeByKey, lastDiagnostics);
    };

    const stopAll = async (): Promise<void> => {
        const diagnostics: HostedWebStaticAssetLifecycleDiagnostic[] = [];
        const active = [...activeByKey.values()];
        activeByKey.clear();
        for (const server of active) {
            await stopActive(server, diagnostics);
        }
        lastDiagnostics = Object.freeze(diagnostics);
    };

    return Object.freeze({
        sync,
        snapshot: () => snapshot(activeByKey, lastDiagnostics),
        stop: async () => {
            stopPromise ??= stopAll();
            await stopPromise;
        },
    });
}

export function verifyHostedWebStaticAssetArtifactWithResult(input: Readonly<{
    verifier: StartHostedWebStaticAssetServerInput['verifyArtifact'];
    files: readonly Readonly<{
        relativePath: string;
        bytes: Uint8Array;
    }>[];
    digest: string;
}>): HostedWebStaticAssetServerVerifyResult | Promise<HostedWebStaticAssetServerVerifyResult> {
    return input.verifier({
        files: input.files,
        digest: input.digest,
    });
}
