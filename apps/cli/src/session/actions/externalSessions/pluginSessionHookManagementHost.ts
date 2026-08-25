import { createHash } from 'node:crypto';

import {
    PluginSessionHookInstallPreviewV1Schema,
    PluginSessionHookInstallResponseV1Schema,
    PluginSessionHookToggleResponseV1Schema,
    PluginSessionHookUninstallResponseV1Schema,
    PluginDiagnosticDataV1Schema,
    type PluginContributionIdentityV1,
    type PluginDiagnosticDataV1,
    type PluginSessionHookInstallInputV1,
    type PluginSessionHookInstallPreviewV1,
    type PluginSessionHookInstallResponseV1,
    type PluginSessionHookInstallationMutationInputV1,
    type PluginSessionHookInstallationStatusV1,
    type PluginSessionHookStatusInputV1,
    type PluginSessionHookStatusResponseV1,
    type PluginSessionHookToggleResponseV1,
    type PluginSessionHookUninstallResponseV1,
} from '@happier-dev/protocol';
import {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
} from '@happier-dev/plugin-sdk/sessions/external';

import { detectCliSnapshotOnDaemonPath } from '@/capabilities/snapshots/cliSnapshot';
import { configuration } from '@/configuration';
import {
    revokeQualifiedExternalSessionHookDurableCredential,
    type QualifiedExternalSessionHookListener,
} from '@/plugins/runtime/hooks/session/qualifiedExternalSessionHookTransport';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';

import {
    applyExternalSessionHookInstallationAction,
    readExternalSessionHookInstallationConfigSnapshot,
    readExternalSessionHookInstallationInventoryPage,
    readExternalSessionHookInstallationRecord,
    resolveExternalSessionHookInstallationRecordPath,
    resolveExternalSessionHookPhysicalTargetPath,
    type ExternalSessionHookInstallationActionErrorCode,
    type ExternalSessionHookInstallationConfigSnapshot,
    type ExternalSessionHookInstallationInventoryRecord,
    type ExternalSessionHookInstallationRecord,
} from './hookInstallationConfiguration';
import type {
    PluginSessionHookManagementHost,
} from './pluginSessionHookManagementActionExecutor';
import {
    projectPluginSessionHookStatusInventory,
} from './pluginSessionHookStatusInventory';

type RuntimeRegistryLease = Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    release(): Promise<void>;
}>;

export type PluginSessionHookManagementHostDependencies = Readonly<{
    acquireRuntimeRegistryLease(): Promise<RuntimeRegistryLease>;
    detectCliSnapshot: typeof detectCliSnapshotOnDaemonPath;
    readInventoryPage: typeof readExternalSessionHookInstallationInventoryPage;
    readInstallationRecord: typeof readExternalSessionHookInstallationRecord;
    readConfigSnapshot:
        typeof readExternalSessionHookInstallationConfigSnapshot;
    applyInstallationAction: typeof applyExternalSessionHookInstallationAction;
}>;

export type PluginSessionHookManagementDaemonHost =
    PluginSessionHookManagementHost & Readonly<{
        hydrate(options?: Readonly<{
            reason: 'bootstrap' | 'plugin_reload';
        }>): Promise<void>;
        dispose(): Promise<void>;
    }>;

const defaultDependencies: PluginSessionHookManagementHostDependencies = {
    acquireRuntimeRegistryLease:
        async () => await acquireAuthoritativePluginRuntimeRegistryLease(),
    detectCliSnapshot: detectCliSnapshotOnDaemonPath,
    readInventoryPage: readExternalSessionHookInstallationInventoryPage,
    readInstallationRecord: readExternalSessionHookInstallationRecord,
    readConfigSnapshot: readExternalSessionHookInstallationConfigSnapshot,
    applyInstallationAction: applyExternalSessionHookInstallationAction,
};

type CurrentExternalSessionsRuntime = Readonly<{
    agentId: string;
    agent: PluginContributionIdentityV1;
    lease: AgentRuntimeRegistrationLease & Required<Pick<
        AgentRuntimeRegistrationLease,
        'externalSessions' | 'retirementSignal'
    >>;
}>;

type CurrentRuntime = CurrentExternalSessionsRuntime & Readonly<{
    lease: CurrentExternalSessionsRuntime['lease'] & Required<Pick<
        AgentRuntimeRegistrationLease,
        'externalSessionHooks'
    >>;
}>;

function hasExternalSessionHooks(
    current: CurrentExternalSessionsRuntime,
): current is CurrentRuntime {
    return current.lease.externalSessionHooks !== undefined;
}

type ResolvedInstallation = Readonly<{
    current: CurrentRuntime;
    hostInstallationId: string;
    installationIdentity: string;
    executableIdentity: string;
    selectedVariant: NonNullable<
        CurrentRuntime['lease']['externalSessionHooks']
    >['installationVariants'][number];
    /**
     * The physical files this installation owns. Durable custody records the
     * same identity, so preview, record matching, custody projection and
     * readiness all compare like with like.
     */
    targets: readonly Readonly<{ targetId: string; absolutePath: string }>[];
    /**
     * The paths the Agent declared, kept only so the configuration owner can
     * re-resolve them at its compare-and-swap fence.
     */
    declaredTargets: readonly Readonly<{
        targetId: string;
        absolutePath: string;
    }>[];
    readiness: Readonly<{ kind: 'ready' }> | Readonly<{
        kind: 'needs_attention';
        diagnostic: PluginDiagnosticDataV1;
    }>;
}>;

type Resolution =
    | Readonly<{ ok: true; value: ResolvedInstallation }>
    | Readonly<{
        ok: false;
        reason:
            | 'agent_unavailable'
            | 'version_unsupported'
            | 'installation_unsupported'
            | 'operation_failed';
        diagnostic?: PluginDiagnosticDataV1;
    }>;

function digest(prefix: string, values: readonly string[]): string {
    return `${prefix}:${createHash('sha256')
        .update(JSON.stringify(values))
        .digest('hex')}`;
}

function hostInstallationId(
    machineId: string,
    agent: PluginContributionIdentityV1,
): string {
    return digest('hook-installation-v1', [
        machineId,
        agent.pluginId,
        agent.localId,
    ]);
}

function agentKey(agent: PluginContributionIdentityV1): string {
    return JSON.stringify([agent.pluginId, agent.localId]);
}

function findCurrentExternalSessionsRuntime(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    agent: PluginContributionIdentityV1,
): CurrentExternalSessionsRuntime | null {
    const definitions = [...registry.contributes.agentDefinitionsById.values()]
        .filter((candidate) => (
            candidate.identity?.pluginId === agent.pluginId
            && candidate.identity.localId === agent.localId
        ));
    if (definitions.length !== 1) return null;
    const definition = definitions[0]!;
    const lease = registry.agentRuntimesByAgentId.get(definition.id);
    if (
        !lease
        || lease.pluginId !== agent.pluginId
        || lease.agentId !== definition.id
        || !lease.externalSessions
        || !lease.retirementSignal
        || lease.retirementSignal.aborted
        || !lease.isCurrent()
    ) {
        return null;
    }
    return {
        agentId: definition.id,
        agent,
        lease: lease as CurrentExternalSessionsRuntime['lease'],
    };
}

function findCurrentRuntime(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    agent: PluginContributionIdentityV1,
): CurrentRuntime | null {
    const current = findCurrentExternalSessionsRuntime(registry, agent);
    return current && hasExternalSessionHooks(current) ? current : null;
}

/**
 * Every Agent the current catalog declares as an External Sessions participant.
 *
 * Passive inventory owes a row to an installed Agent that simply has not run
 * yet, and it must produce that row without starting the plugin, so membership
 * is decided by the manifest-declared `surfaces.externalSession` projection —
 * the same activation-free catalog fact the Browse surface resolves sources
 * from — rather than by the presence of an already-activated runtime lease.
 */
function listCatalogExternalSessionsAgents(
    registry: ResolvedExecutablePluginRuntimeRegistry,
): readonly PluginContributionIdentityV1[] {
    const byKey = new Map<string, PluginContributionIdentityV1>();
    for (
        const definition of registry.contributes.agentDefinitionsById.values()
    ) {
        const identity = definition.identity;
        if (
            !identity
            || !definition.richDefinition?.definition.surfaces?.externalSession
        ) {
            continue;
        }
        byKey.set(agentKey(identity), identity);
    }
    return [...byKey.values()];
}

function listCurrentExternalSessionsRuntimes(
    registry: ResolvedExecutablePluginRuntimeRegistry,
): readonly CurrentExternalSessionsRuntime[] {
    return [...registry.contributes.agentDefinitionsById.values()]
        .flatMap((definition) => {
            const identity = definition.identity;
            return identity
                ? findCurrentExternalSessionsRuntime(registry, identity)
                : null;
        })
        .filter(
            (value): value is CurrentExternalSessionsRuntime => value !== null,
        );
}

function projectCustodiedEntries(
    record: ExternalSessionHookInstallationRecord,
    variant: CurrentRuntime['lease']['externalSessionHooks'][
        'installationVariants'
    ][number],
) {
    if (
        record.variantId !== variant.variantId
        || record.targets.length !== variant.targets.length
        || record.ownedEntries.length !== variant.events.length
    ) {
        return null;
    }
    const targets = variant.targets.map((target) => {
        const recordedTarget = record.targets.find(
            (candidate) => candidate.targetId === target.targetId,
        );
        if (
            !recordedTarget
            || recordedTarget.collectionId !== target.collectionId
        ) {
            return null;
        }
        const entries = variant.events
            .filter((event) => event.targetId === target.targetId)
            .map((event) => {
                const matches = record.ownedEntries.filter((owned) => (
                    owned.targetId === target.targetId
                    && owned.collectionId === target.collectionId
                    && owned.eventId === event.eventId
                    && owned.nativeEventName === event.nativeEventName
                    && owned.occurrenceCount === 1
                ));
                if (matches.length !== 1) return null;
                return {
                    eventId: event.eventId,
                    nativeEventName: event.nativeEventName,
                    entryIndex: matches[0]!.entryIndex,
                    entry: matches[0]!.entry,
                };
            });
        if (entries.some((entry) => entry === null)) return null;
        return {
            targetId: target.targetId,
            absolutePath: recordedTarget.absolutePath,
            entries,
        };
    });
    if (targets.some((target) => target === null)) return null;

    const strictEntries = PluginSessionHookInstallPreviewV1Schema.safeParse({
        previewId: `hook-install-preview:v1:${'0'.repeat(64)}`,
        targets: targets.map((target) => ({
            targetId: target!.targetId,
            absolutePath: target!.absolutePath,
            changes: target!.entries.map((entry) => ({
                kind: 'append_json_array_entry',
                collectionId: variant.targets.find(
                    (candidate) => candidate.targetId === target!.targetId,
                )!.collectionId,
                eventId: entry!.eventId,
                nativeEventName: entry!.nativeEventName,
                entry: entry!.entry,
            })),
        })),
    });
    if (!strictEntries.success) return null;
    return {
        variantId: variant.variantId,
        targets: strictEntries.data.targets.map((target, targetIndex) => ({
            targetId: target.targetId,
            absolutePath: target.absolutePath,
            entries: target.changes.map((change, changeIndex) => {
                const projected =
                    targets[targetIndex]!.entries[changeIndex]!;
                return {
                    eventId: change.eventId,
                    nativeEventName: change.nativeEventName,
                    entryIndex: projected!.entryIndex,
                    entry: change.entry,
                };
            }),
        })),
    };
}

async function projectCurrentCustody(input: Readonly<{
    record: ExternalSessionHookInstallationRecord;
    variant: NonNullable<
        CurrentRuntime['lease']['externalSessionHooks']
    >['installationVariants'][number];
    dependencies: PluginSessionHookManagementHostDependencies;
}>) {
    const custody = projectCustodiedEntries(input.record, input.variant);
    if (!custody) return null;
    let config: Awaited<ReturnType<
        PluginSessionHookManagementHostDependencies['readConfigSnapshot']
    >>;
    try {
        config = await input.dependencies.readConfigSnapshot({
            selectedVariant: input.variant,
            targets: input.record.targets.map((target) => ({
                targetId: target.targetId,
                absolutePath: target.absolutePath,
            })),
        });
    } catch {
        return null;
    }
    if (
        !config.ok
        || config.snapshot.targets.length !== input.record.targets.length
    ) {
        return null;
    }
    const currentByTargetId = new Map(
        config.snapshot.targets.map((target) => [target.targetId, target]),
    );
    if (
        currentByTargetId.size !== input.record.targets.length
        || input.record.targets.some((recorded) => {
            const current = currentByTargetId.get(recorded.targetId);
            return (
                !current
                || !canonicalAbsolutePathsEqual(
                    current.absolutePath,
                    recorded.absolutePath,
                )
                || current.collectionId !== recorded.collectionId
                || current.inputIdentity !== recorded.inputIdentity
            );
        })
    ) {
        return null;
    }
    return custody;
}

/**
 * Shell dialects whose serialized hook command each platform can actually
 * execute.
 *
 * A plugin declares the shell its Agent runs a hook entry through and the host
 * serializes the command for exactly that shell. A variant selected for a
 * platform whose shells cannot run its dialect would install an entry that can
 * never fire while status reported a ready installation, so resolution refuses
 * it instead. Keyed by dialect id rather than the SDK union so a newly declared
 * dialect must be added here deliberately.
 */
const EXECUTABLE_SHELL_DIALECTS_BY_PLATFORM: Readonly<Record<
    'darwin' | 'linux' | 'win32',
    ReadonlySet<string>
>> = {
    darwin: new Set(['posix']),
    linux: new Set(['posix']),
    win32: new Set(['windows_cmd', 'powershell_encoded']),
};

function variantRunsOnPlatform(
    variant: NonNullable<
        CurrentRuntime['lease']['externalSessionHooks']
    >['installationVariants'][number],
    platform: 'darwin' | 'linux' | 'win32',
): boolean {
    const executable = EXECUTABLE_SHELL_DIALECTS_BY_PLATFORM[platform];
    return variant.events.every(
        (event) => executable.has(event.command.shellDialect),
    );
}

function resolveStructurallyCompatibleVariant(
    current: CurrentRuntime,
    record: ExternalSessionHookInstallationRecord,
) {
    const variant =
        current.lease.externalSessionHooks.installationVariants.find(
            (candidate) => candidate.variantId === record.variantId,
        );
    return variant && projectCustodiedEntries(record, variant)
        ? variant
        : null;
}

async function resolveInstallation(
    input: Readonly<{
        machineId: string;
        current: CurrentRuntime;
        dependencies: PluginSessionHookManagementHostDependencies;
        custodyRecord?: ExternalSessionHookInstallationRecord;
        signal?: AbortSignal;
    }>,
): Promise<Resolution> {
    const custodyVariant = input.custodyRecord
        ? input.current.lease.externalSessionHooks.installationVariants.find(
            (candidate) =>
                candidate.variantId === input.custodyRecord!.variantId,
        )
        : undefined;
    const snapshot = await input.dependencies.detectCliSnapshot({
        requestedCliNames: [input.current.agentId],
        bypassCache: true,
    });
    const executable = snapshot.clis[input.current.agentId];
    if (
        !executable?.available
        || !executable.resolvedPath
        || !executable.version
    ) {
        return { ok: false, reason: 'agent_unavailable' };
    }
    const executableIdentity = digest('agent-executable-v1', [
        executable.resolvedPath,
        executable.version,
    ]);
    const installationIdentity = digest('agent-installation-v1', [
        input.machineId,
        input.current.agent.pluginId,
        input.current.agent.localId,
        executableIdentity,
    ]);
    const signal = input.signal ?? new AbortController().signal;
    const platform = process.platform;
    if (
        platform !== 'darwin'
        && platform !== 'linux'
        && platform !== 'win32'
    ) {
        return { ok: false, reason: 'installation_unsupported' };
    }
    const custody = input.custodyRecord && custodyVariant
        ? await projectCurrentCustody({
            record: input.custodyRecord,
            variant: custodyVariant,
            dependencies: input.dependencies,
        })
        : undefined;
    if (input.custodyRecord && !custody) {
        return {
            ok: false,
            reason: 'operation_failed',
            diagnostic: {
                code: 'hook_installation_reconciliation_required',
                severity: 'error',
            },
        };
    }
    const request = {
        installation: {
            installationIdentity,
            executableIdentity,
            installedVersion: executable.version,
            platform,
            architecture: process.arch,
        },
        ...(custody ? { custody } : {}),
        signal,
        deadlineAtMs: Date.now()
            + AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks
                .resolveInstallation.deadlineMs,
        maxSerializedBytes:
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks
                .resolveInstallation.maxEnvelopeUtf8Bytes,
    };
    if (
        !input.current.lease.isCurrent()
        || input.current.lease.retirementSignal.aborted
        || signal.aborted
    ) {
        return { ok: false, reason: 'operation_failed' };
    }
    const result = await input.current.lease.externalSessionHooks
        .resolveInstallation(request);
    if (
        !input.current.lease.isCurrent()
        || input.current.lease.retirementSignal.aborted
        || signal.aborted
    ) {
        return { ok: false, reason: 'operation_failed' };
    }
    if (!result.ok) return { ok: false, reason: 'operation_failed' };
    const resolved = result.value;
    if (resolved.kind === 'unsupported') {
        return { ok: false, reason: resolved.reason };
    }
    const selectedVariant =
        input.current.lease.externalSessionHooks.installationVariants
            .find((variant) => variant.variantId === resolved.variantId);
    if (!selectedVariant) {
        return { ok: false, reason: 'operation_failed' };
    }
    if (!variantRunsOnPlatform(selectedVariant, platform)) {
        return { ok: false, reason: 'installation_unsupported' };
    }
    // An unresolvable target (a symlink loop, an unreadable ancestor) keeps the
    // declared path here so this resolution still has one comparable identity.
    // It cannot install to it: the configuration owner re-resolves the declared
    // path itself and refuses the whole action as `invalid_target_path`, and a
    // record written from a resolvable path simply stops matching.
    const physicalTargets = await Promise.all(
        resolved.targets.map(async (target) => ({
            targetId: target.targetId,
            absolutePath:
                await resolveExternalSessionHookPhysicalTargetPath(
                    target.absolutePath,
                ) ?? target.absolutePath,
        })),
    );
    return {
        ok: true,
        value: {
            current: input.current,
            hostInstallationId: hostInstallationId(
                input.machineId,
                input.current.agent,
            ),
            installationIdentity,
            executableIdentity,
            selectedVariant,
            targets: physicalTargets,
            declaredTargets: resolved.targets,
            readiness: resolved.readiness.kind === 'ready'
                ? resolved.readiness
                : {
                    kind: 'needs_attention',
                    diagnostic: PluginDiagnosticDataV1Schema.parse(
                        resolved.readiness.diagnostic,
                    ),
                },
        },
    };
}

function attention(
    code: string,
    installationId?: string,
): PluginSessionHookInstallationStatusV1 {
    return {
        state: 'needs_attention',
        ...(installationId ? { installationId } : {}),
        diagnostic: { code, severity: 'error' },
    };
}

function statusFromRecord(
    record: ExternalSessionHookInstallationInventoryRecord,
): PluginSessionHookInstallationStatusV1 {
    if (record.state === 'active') {
        return {
            state: 'installed_enabled',
            installationId: record.installationId,
        };
    }
    if (record.state === 'disabled') {
        return {
            state: 'installed_disabled',
            installationId: record.installationId,
        };
    }
    return attention(
        'hook_installation_reconciliation_required',
        record.installationId,
    );
}

function failure(
    code:
        | 'agent_unavailable'
        | 'installation_unsupported'
        | 'version_unsupported'
        | 'invalid_config'
        | 'concurrent_edit'
        | 'listener_unavailable'
        | 'installation_replaced'
        | 'operation_failed',
    retryable: boolean,
) {
    return { ok: false as const, diagnostic: { code, retryable } };
}

function mapActionError(
    code: ExternalSessionHookInstallationActionErrorCode,
) {
    if (code === 'invalid_config' || code === 'invalid_target_path') {
        return failure('invalid_config', false);
    }
    if (
        code === 'concurrent_edit'
        || code === 'post_write_verification_failed'
        || code === 'reconciliation_required'
    ) {
        return failure('concurrent_edit', true);
    }
    if (
        code === 'generation_mismatch'
        || code === 'installation_record_mismatch'
    ) {
        return failure('installation_replaced', false);
    }
    return failure('operation_failed', code === 'write_failed');
}

function recordPath(input: Readonly<{
    activeServerDir: string;
    agent: PluginContributionIdentityV1;
    installationId: string;
}>): string {
    return resolveExternalSessionHookInstallationRecordPath({
        activeServerDir: input.activeServerDir,
        qualifiedAgent: input.agent,
        hostInstallationId: input.installationId,
    });
}

function ownedEventIds(
    record: ExternalSessionHookInstallationRecord,
): readonly string[] {
    return [...new Set(record.ownedEntries.map((entry) => entry.eventId))];
}

function hasEnabledIngressPrincipals(
    listener: QualifiedExternalSessionHookListener,
    record: ExternalSessionHookInstallationRecord,
): boolean {
    return ownedEventIds(record).every((eventId) => (
        listener.readCredentialState({
            qualifiedContributionId: record.qualifiedAgent,
            hostInstallationId: record.hostInstallationId,
            installationPrincipalRef: record.ingressPrincipalRef,
            eventId,
        }).state === 'enabled'
    ));
}

function recordMatchesResolution(
    record: ExternalSessionHookInstallationRecord,
    resolution: ResolvedInstallation,
): boolean {
    const resolvedTargets = new Map(
        resolution.targets.map((entry) => [
            entry.targetId,
            entry.absolutePath,
        ]),
    );
    return record.hostInstallationId === resolution.hostInstallationId
        && record.variantId === resolution.selectedVariant.variantId
        && record.installationIdentity === resolution.installationIdentity
        && record.executableIdentity === resolution.executableIdentity
        && record.targets.length === resolvedTargets.size
        && record.targets.every((entry) => {
            const targetPath = resolvedTargets.get(entry.targetId);
            return targetPath !== undefined
                && canonicalAbsolutePathsEqual(targetPath, entry.absolutePath);
        });
}

type InstallPreviewPlan =
    | Readonly<{
        ok: true;
        preview: PluginSessionHookInstallPreviewV1;
        configSnapshot: ExternalSessionHookInstallationConfigSnapshot;
    }>
    | Readonly<{
        ok: false;
        code: 'invalid_config' | 'operation_failed';
    }>;

async function planInstallPreview(input: Readonly<{
    resolution: ResolvedInstallation;
    listener: QualifiedExternalSessionHookListener;
    dependencies: PluginSessionHookManagementHostDependencies;
}>): Promise<InstallPreviewPlan> {
    const config = await input.dependencies.readConfigSnapshot({
        selectedVariant: input.resolution.selectedVariant,
        targets: input.resolution.targets,
    });
    if (!config.ok) {
        return {
            ok: false,
            code: config.code === 'invalid_config'
                ? 'invalid_config'
                : 'operation_failed',
        };
    }
    try {
        const targets = config.snapshot.targets.map((target) => ({
            targetId: target.targetId,
            absolutePath: target.absolutePath,
            changes: input.resolution.selectedVariant.events
                .filter((event) => event.targetId === target.targetId)
                .map((event) => ({
                    kind: 'append_json_array_entry' as const,
                    collectionId: target.collectionId,
                    eventId: event.eventId,
                    nativeEventName: event.nativeEventName,
                    entry: input.listener.buildOwnedEntryPreview({
                        qualifiedContributionId:
                            input.resolution.current.agent,
                        hostInstallationId:
                            input.resolution.hostInstallationId,
                        event,
                    }),
                })),
        }));
        const previewId = digest('hook-install-preview:v1', [
            JSON.stringify({ targets }),
            input.resolution.current.lease.generation,
            input.resolution.installationIdentity,
            input.resolution.executableIdentity,
            JSON.stringify(config.snapshot.targets.map((target) => [
                target.targetId,
                target.inputIdentity,
            ])),
        ]);
        return {
            ok: true,
            preview: PluginSessionHookInstallPreviewV1Schema.parse({
                previewId,
                targets,
            }),
            configSnapshot: config.snapshot,
        };
    } catch {
        return { ok: false, code: 'operation_failed' };
    }
}

export function createPluginSessionHookManagementHost(input: Readonly<{
    machineId: string;
    listener: Promise<QualifiedExternalSessionHookListener>;
    activeServerDir?: string;
    isFeatureEnabled?: () => boolean;
    dependencies?: Partial<PluginSessionHookManagementHostDependencies>;
}>): PluginSessionHookManagementDaemonHost {
    const activeServerDir = input.activeServerDir ?? configuration.activeServerDir;
    const dependencies: PluginSessionHookManagementHostDependencies = {
        ...defaultDependencies,
        ...input.dependencies,
    };
    let hydration: Promise<void> | null = null;
    let hydrationRequested = false;
    let hydrationReasonRequested:
        | 'bootstrap'
        | 'plugin_reload'
        | null = null;
    let disposed = false;
    const featureEnabled = input.isFeatureEnabled ?? (() => true);
    const lifecycleController = new AbortController();
    let activeOperationCount = 0;
    let resolveOperationsDrained: (() => void) | null = null;

    const admitOperation = (): (() => void) | null => {
        if (disposed || lifecycleController.signal.aborted) return null;
        activeOperationCount += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            activeOperationCount -= 1;
            if (activeOperationCount === 0) {
                resolveOperationsDrained?.();
                resolveOperationsDrained = null;
            }
        };
    };

    const awaitOperationsDrained = async (): Promise<void> => {
        if (activeOperationCount === 0) return;
        await new Promise<void>((resolve) => {
            resolveOperationsDrained = resolve;
        });
    };

    const operationIsCurrent = (
        current?: CurrentRuntime,
        signal?: AbortSignal,
    ): boolean => (
        !disposed
        && !lifecycleController.signal.aborted
        && !signal?.aborted
        && featureEnabled()
        && (
            !current
            || (
                current.lease.isCurrent()
                && !current.lease.retirementSignal.aborted
            )
        )
    );
    const operationSignal = (signal?: AbortSignal): AbortSignal => (
        signal
            ? AbortSignal.any([lifecycleController.signal, signal])
            : lifecycleController.signal
    );
    const mutationTails = new Map<string, Promise<void>>();
    const mutationKey = (
        agent: PluginContributionIdentityV1,
        installationId: string,
    ): string => JSON.stringify([
        input.machineId,
        agent.pluginId,
        agent.localId,
        installationId,
    ]);
    const withMutationLock = async <T>(
        key: string,
        operation: () => Promise<T>,
    ): Promise<T> => {
        const prior = mutationTails.get(key) ?? Promise.resolve();
        let releaseTurn!: () => void;
        const turn = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });
        const tail = prior.catch(() => undefined).then(async () => await turn);
        mutationTails.set(key, tail);
        await prior.catch(() => undefined);
        try {
            return await operation();
        } finally {
            releaseTurn();
            if (mutationTails.get(key) === tail) {
                mutationTails.delete(key);
            }
        }
    };

    const loadRecord = async (
        mutation: PluginSessionHookInstallationMutationInputV1,
    ): Promise<ExternalSessionHookInstallationRecord | null> => {
        const record = await dependencies.readInstallationRecord(recordPath({
            activeServerDir,
            agent: mutation.agent,
            installationId: mutation.installationId,
        }));
        return record
            && record.machineId === input.machineId
            && record.qualifiedAgent.pluginId === mutation.agent.pluginId
            && record.qualifiedAgent.localId === mutation.agent.localId
            && record.hostInstallationId === mutation.installationId
            ? record
            : null;
    };

    const host: PluginSessionHookManagementDaemonHost = {
        async dispose(): Promise<void> {
            disposed = true;
            hydrationRequested = false;
            lifecycleController.abort();
            await hydration?.catch(() => undefined);
            await awaitOperationsDrained();
        },

        async hydrate(options): Promise<void> {
            if (disposed || !featureEnabled()) return;
            const requestedReason = options?.reason ?? 'bootstrap';
            if (hydration) {
                hydrationRequested = true;
                if (requestedReason === 'plugin_reload') {
                    hydrationReasonRequested = 'plugin_reload';
                }
                return await hydration;
            }
            hydrationReasonRequested = requestedReason;
            hydration = (async () => {
                do {
                    hydrationRequested = false;
                    const hydrationReason =
                        hydrationReasonRequested ?? 'bootstrap';
                    hydrationReasonRequested = null;
                    const listener = await input.listener;
                    if (disposed || !featureEnabled()) return;
                    const registryLease =
                        await dependencies.acquireRuntimeRegistryLease();
                    try {
                        if (disposed || !featureEnabled()) return;
                        let cursor: string | undefined;
                        const seenCursors = new Set<string>();
                        while (true) {
                        const page = await dependencies.readInventoryPage({
                            activeServerDir,
                            ...(cursor ? { cursor } : {}),
                            limit: 50,
                        });
                        if (!page.ok) {
                            throw new Error(
                                `Session-hook inventory hydration failed: ${page.code}`,
                            );
                        }
                        if (disposed || !featureEnabled()) return;
                        for (const inventory of page.records) {
                            if (disposed || !featureEnabled()) return;
                            if (inventory.machineId !== input.machineId) {
                                continue;
                            }
                            if (inventory.state !== 'active') continue;
                            // Restoring, rotating and enabling ingress is a
                            // credential effect on one installation, so it
                            // takes the same per-installation lock every
                            // lifecycle action takes. The record is read after
                            // the lock is held and the credentials stay
                            // admitted under it, so a Disable or Uninstall
                            // either runs first — and is then observed — or
                            // waits until hydration has finished.
                            const outcome = await withMutationLock(
                                mutationKey(
                                    inventory.qualifiedAgent,
                                    inventory.installationId,
                                ),
                                async (): Promise<'next' | 'stop'> => {
                                if (disposed || !featureEnabled()) return 'stop';
                                const current = findCurrentRuntime(
                                    registryLease.registry,
                                    inventory.qualifiedAgent,
                                );
                                if (!current) return 'next';
                                const record =
                                    await dependencies.readInstallationRecord(
                                        recordPath({
                                            activeServerDir,
                                            agent: inventory.qualifiedAgent,
                                            installationId:
                                                inventory.installationId,
                                        }),
                                    );
                                if (disposed || !featureEnabled()) return 'stop';
                                if (!record) return 'next';
                                if (
                                    record.state !== 'active'
                                    || record.hostInstallationId
                                        !== inventory.installationId
                                ) {
                                    return 'next';
                                }
                                const variant = resolveStructurallyCompatibleVariant(
                                    current,
                                    record,
                                );
                                if (!variant) return 'next';
                                const restored: Awaited<ReturnType<
                                    QualifiedExternalSessionHookListener[
                                        'restoreCredential'
                                    ]
                                >>[] = [];
                                let hydrationFailed = false;
                                for (const event of variant.events) {
                                    const result =
                                        await listener.restoreCredential({
                                            machineId: input.machineId,
                                            agentId: current.agentId,
                                            qualifiedContributionId:
                                                current.agent,
                                            hostInstallationId:
                                                record.hostInstallationId,
                                            installationPrincipalRef:
                                                record.ingressPrincipalRef,
                                            installationIdentity:
                                                record.installationIdentity,
                                            variantId: record.variantId,
                                            eventId: event.eventId,
                                            pluginGeneration:
                                                current.lease.generation,
                                            retirementSignal:
                                                current.lease.retirementSignal,
                                        });
                                    restored.push(result);
                                    if (result.state === 'unavailable') {
                                        hydrationFailed = true;
                                        break;
                                    }
                                    if (disposed || !featureEnabled()) {
                                        listener.disable(
                                            result.credential.eventPrincipalRef,
                                        );
                                        return 'stop';
                                    }
                                }
                                const credentials = restored.flatMap((result) =>
                                    result.state === 'restored'
                                        ? [result.credential]
                                        : []);
                                if (
                                    hydrationFailed
                                    || credentials.length
                                        !== variant.events.length
                                ) {
                                    for (const credential of credentials) {
                                        listener.disable(
                                            credential.eventPrincipalRef,
                                        );
                                    }
                                    return 'next';
                                }
                                let admittedCredentials = credentials;
                                if (hydrationReason === 'plugin_reload') {
                                    const rotated: typeof credentials = [];
                                    try {
                                        for (const event of variant.events) {
                                            rotated.push(
                                                await listener.rotateCredential({
                                                    machineId: input.machineId,
                                                    agentId: current.agentId,
                                                    qualifiedContributionId:
                                                        current.agent,
                                                    hostInstallationId:
                                                        record.hostInstallationId,
                                                    installationPrincipalRef:
                                                        record.ingressPrincipalRef,
                                                    installationIdentity:
                                                        record.installationIdentity,
                                                    variantId: record.variantId,
                                                    eventId: event.eventId,
                                                    pluginGeneration:
                                                        current.lease.generation,
                                                    retirementSignal:
                                                        current.lease
                                                            .retirementSignal,
                                                }),
                                            );
                                        }
                                        admittedCredentials = rotated;
                                    } catch {
                                        for (const credential of [
                                            ...credentials,
                                            ...rotated,
                                        ]) {
                                            listener.disable(
                                                credential.eventPrincipalRef,
                                            );
                                        }
                                        await dependencies.applyInstallationAction({
                                            action: 'disable',
                                            activeServerDir,
                                            machineId: input.machineId,
                                            qualifiedAgent: current.agent,
                                            hostInstallationId:
                                                record.hostInstallationId,
                                            installationIdentity:
                                                record.installationIdentity,
                                            executableIdentity:
                                                record.executableIdentity,
                                            ingressPrincipalRef:
                                                record.ingressPrincipalRef,
                                        }).catch(() => undefined);
                                        await Promise.allSettled(
                                            ownedEventIds(record).map(
                                                async (eventId) =>
                                                    await listener.revokeDurableCredential({
                                                        qualifiedContributionId:
                                                            current.agent,
                                                        hostInstallationId:
                                                            record.hostInstallationId,
                                                        installationPrincipalRef:
                                                            record.ingressPrincipalRef,
                                                        eventId,
                                                    }),
                                            ),
                                        );
                                        return 'next';
                                    }
                                }
                                for (const credential of admittedCredentials) {
                                    if (
                                        !disposed
                                        && featureEnabled()
                                    ) {
                                        listener.enable(
                                            credential.eventPrincipalRef,
                                        );
                                    } else {
                                        listener.disable(
                                            credential.eventPrincipalRef,
                                        );
                                    }
                                }
                                return 'next';
                                },
                            );
                            if (outcome === 'stop') return;
                        }
                        const next = page.nextCursor;
                        if (!next) break;
                        if (seenCursors.has(next)) {
                            throw new Error(
                                'Session-hook inventory hydration cursor did not advance',
                            );
                        }
                        seenCursors.add(next);
                        cursor = next;
                    }
                    } finally {
                        await registryLease.release().catch(() => undefined);
                    }
                } while (
                    hydrationRequested
                    && !disposed
                    && featureEnabled()
                );
            })().finally(() => {
                hydration = null;
            });
            return await hydration;
        },

        async status(
            target: PluginSessionHookStatusInputV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ):
        Promise<PluginSessionHookStatusResponseV1> {
            const releaseOperation = admitOperation();
            if (!releaseOperation || !featureEnabled() || options?.signal?.aborted) {
                return failure('operation_failed', false);
            }
            const registryLease = await dependencies
                .acquireRuntimeRegistryLease()
                .catch(() => null);
            if (!registryLease) {
                releaseOperation();
                return failure('operation_failed', true);
            }
            try {
                const listener = await input.listener.catch(() => null);
                const listenerAvailable = listener !== null;
                if (target.intent === 'passive_inventory') {
                    const current =
                        listCurrentExternalSessionsRuntimes(
                            registryLease.registry,
                        );
                    return await projectPluginSessionHookStatusInventory(
                        target,
                        {
                            listCurrentAgents: () =>
                                listCatalogExternalSessionsAgents(
                                    registryLease.registry,
                                ),
                            readCustodyPage: async (request) =>
                                await dependencies.readInventoryPage({
                                    activeServerDir,
                                    ...(request.qualifiedAgent
                                        ? {
                                            qualifiedAgent:
                                                request.qualifiedAgent,
                                        }
                                        : {}),
                                    ...(request.cursor
                                        ? { cursor: request.cursor }
                                        : {}),
                                    limit: request.limit,
                                }),
                            resolveCurrentStatus:
                                async ({ agent, custody }) => {
                                    const runtime = current.find(
                                        (entry) => (
                                            entry.agent.pluginId
                                                === agent.pluginId
                                            && entry.agent.localId
                                                === agent.localId
                                        ),
                                    );
                                    if (!runtime) {
                                        // Catalog-current but not activated:
                                        // durable custody is still the whole
                                        // truth, and without it nothing is
                                        // installed for this Agent on this
                                        // machine. Reporting anything worse
                                        // would invent a failure that passive
                                        // facts cannot support, and resolving
                                        // hook support would require starting
                                        // the plugin.
                                        return custody
                                            ? {
                                                state: 'unavailable',
                                                installationId:
                                                    custody.installationId,
                                            }
                                            : { state: 'not_installed' };
                                    }
                                    if (!hasExternalSessionHooks(runtime)) {
                                        return custody
                                            ? {
                                                state: 'unavailable',
                                                installationId:
                                                    custody.installationId,
                                            }
                                            : {
                                                state: 'unsupported',
                                                reason:
                                                    'installation_unsupported',
                                            };
                                    }
                                    const fullRecord = custody
                                        ? await dependencies
                                            .readInstallationRecord(
                                                recordPath({
                                                    activeServerDir,
                                                    agent,
                                                    installationId:
                                                        custody.installationId,
                                                }),
                                            )
                                        : null;
                                    if (
                                        custody
                                        && (
                                            !fullRecord
                                            || fullRecord.machineId
                                                !== input.machineId
                                            || fullRecord.qualifiedAgent
                                                .pluginId !== agent.pluginId
                                            || fullRecord.qualifiedAgent
                                                .localId !== agent.localId
                                            || fullRecord.hostInstallationId
                                                !== custody.installationId
                                        )
                                    ) {
                                        return attention(
                                            'hook_installation_replacement_detected',
                                            custody.installationId,
                                        );
                                    }
                                    if (
                                        fullRecord
                                        && !resolveStructurallyCompatibleVariant(
                                            runtime,
                                            fullRecord,
                                        )
                                    ) {
                                        return attention(
                                            'hook_installation_replacement_detected',
                                            fullRecord.hostInstallationId,
                                        );
                                    }
                                    if (
                                        custody?.state === 'active'
                                        && (
                                            !listener
                                            || !fullRecord
                                            || !hasEnabledIngressPrincipals(
                                                listener,
                                                fullRecord,
                                            )
                                        )
                                    ) {
                                        return attention(
                                            'listener_unavailable',
                                            custody.installationId,
                                        );
                                    }
                                    return custody
                                        ? statusFromRecord(custody)
                                        : { state: 'not_installed' };
                                },
                        },
                    );
                }

                const pointSuccess = (
                    status: PluginSessionHookInstallationStatusV1,
                ): PluginSessionHookStatusResponseV1 => ({
                    ok: true,
                    rows: [{ agent: target.agent, status }],
                    nextCursor: null,
                    diagnostics: [],
                });
                const scanForCustody = async (): Promise<
                    'absent' | 'present' | 'failed'
                > => {
                    let cursor: string | undefined;
                    const seenCursors = new Set<string>();
                    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
                        const page = await dependencies.readInventoryPage({
                            activeServerDir,
                            qualifiedAgent: target.agent,
                            ...(cursor ? { cursor } : {}),
                            limit: 50,
                        }).catch(() => null);
                        if (
                            !page
                            || !page.ok
                            || page.diagnostics.length > 0
                        ) {
                            return 'failed';
                        }
                        if (page.records.some((record) => (
                            record.machineId === input.machineId
                            && record.qualifiedAgent.pluginId
                                === target.agent.pluginId
                            && record.qualifiedAgent.localId
                                === target.agent.localId
                        ))) {
                            return 'present';
                        }
                        if (!page.nextCursor) return 'absent';
                        if (seenCursors.has(page.nextCursor)) return 'failed';
                        seenCursors.add(page.nextCursor);
                        cursor = page.nextCursor;
                    }
                    return 'failed';
                };
                const readSelectedRecord = async (): Promise<
                    ExternalSessionHookInstallationRecord | null
                > => {
                    if (target.intent !== 'installation_recheck') {
                        return null;
                    }
                    const record = await dependencies.readInstallationRecord(
                        recordPath({
                            activeServerDir,
                            agent: target.agent,
                            installationId: target.installationId,
                        }),
                    ).catch(() => null);
                    return record
                        && record.machineId === input.machineId
                        && record.qualifiedAgent.pluginId
                            === target.agent.pluginId
                        && record.qualifiedAgent.localId
                            === target.agent.localId
                        && record.hostInstallationId
                            === target.installationId
                        && (
                            record.state === 'active'
                            || record.state === 'disabled'
                        )
                        ? record
                        : null;
                };
                const sameSelectedRecordFact = (
                    left: ExternalSessionHookInstallationRecord,
                    right: ExternalSessionHookInstallationRecord,
                ): boolean => (
                    left.schemaVersion === right.schemaVersion
                    && left.revision === right.revision
                    && left.updatedAtMs === right.updatedAtMs
                    && left.state === right.state
                    && left.ingressPrincipalRef
                        === right.ingressPrincipalRef
                    && left.installationIdentity
                        === right.installationIdentity
                    && left.executableIdentity
                        === right.executableIdentity
                    && left.variantId === right.variantId
                    && left.targets.length === right.targets.length
                    && left.targets.every((target, index) => {
                        const candidate = right.targets[index];
                        return candidate?.targetId === target.targetId
                            && candidate.absolutePath
                                === target.absolutePath
                            && candidate.collectionId
                                === target.collectionId
                            && candidate.inputIdentity
                                === target.inputIdentity;
                    })
                    && left.ownedEntries.length
                        === right.ownedEntries.length
                    && left.ownedEntries.every((entry, index) => {
                        const candidate = right.ownedEntries[index];
                        return candidate?.targetId === entry.targetId
                            && candidate.collectionId
                                === entry.collectionId
                            && candidate.eventId === entry.eventId
                            && candidate.nativeEventName
                                === entry.nativeEventName
                            && candidate.entryIdentity
                                === entry.entryIdentity
                            && candidate.entryIndex === entry.entryIndex
                            && candidate.occurrenceCount
                                === entry.occurrenceCount
                            && candidate.identicalEntriesBefore
                                === entry.identicalEntriesBefore
                            && JSON.stringify(candidate.entry)
                                === JSON.stringify(entry.entry);
                    })
                );

                let fullRecord: ExternalSessionHookInstallationRecord | null =
                    null;
                if (target.intent === 'installation_recheck') {
                    fullRecord = await readSelectedRecord();
                    if (!fullRecord) {
                        return failure('installation_replaced', false);
                    }
                    if (
                        fullRecord.state === 'active'
                        && (
                            !listener
                            || !hasEnabledIngressPrincipals(
                                listener,
                                fullRecord,
                            )
                        )
                    ) {
                        return pointSuccess(attention(
                            'listener_unavailable',
                            target.installationId,
                        ));
                    }
                } else {
                    const custody = await scanForCustody();
                    if (custody === 'present') {
                        return failure('concurrent_edit', true);
                    }
                    if (custody === 'failed') {
                        return failure('operation_failed', true);
                    }
                }

                const definitions = [
                    ...registryLease.registry.contributes
                        .agentDefinitionsById.values(),
                ].filter((candidate) => (
                    candidate.identity?.pluginId
                        === target.agent.pluginId
                    && candidate.identity.localId
                        === target.agent.localId
                ));
                if (definitions.length !== 1) {
                    return failure('agent_unavailable', false);
                }
                const definition = definitions[0]!;
                const currentExternalSessionsRuntime =
                    findCurrentExternalSessionsRuntime(
                        registryLease.registry,
                        target.agent,
                    );
                let runtime = currentExternalSessionsRuntime
                    && hasExternalSessionHooks(
                        currentExternalSessionsRuntime,
                    )
                    ? currentExternalSessionsRuntime
                    : null;
                if (
                    currentExternalSessionsRuntime
                    && !runtime
                ) {
                    return failure('installation_unsupported', false);
                }
                if (
                    registryLease.registry.agentRuntimesByAgentId.has(
                        definition.id,
                    )
                    && !runtime
                ) {
                    return failure('operation_failed', false);
                }
                if (!runtime) {
                    try {
                        await registryLease.registry
                            .activateContributionsOnDemand([{
                                pluginId: target.agent.pluginId,
                                family: 'agents',
                                localId: target.agent.localId,
                            }]);
                    } catch {
                        return failure('operation_failed', true);
                    }
                    const activatedExternalSessionsRuntime =
                        findCurrentExternalSessionsRuntime(
                            registryLease.registry,
                            target.agent,
                        );
                    if (
                        activatedExternalSessionsRuntime
                        && !hasExternalSessionHooks(
                            activatedExternalSessionsRuntime,
                        )
                    ) {
                        return failure('installation_unsupported', false);
                    }
                    runtime = activatedExternalSessionsRuntime;
                }
                if (!runtime) {
                    return failure('agent_unavailable', true);
                }
                if (
                    fullRecord
                    && !resolveStructurallyCompatibleVariant(
                        runtime,
                        fullRecord,
                    )
                ) {
                    return failure('installation_replaced', false);
                }
                if (target.intent === 'install_preview') {
                    const custody = await scanForCustody();
                    if (custody === 'present') {
                        return failure('concurrent_edit', true);
                    }
                    if (custody === 'failed') {
                        return failure('operation_failed', true);
                    }
                }
                if (!listener) {
                    return failure('listener_unavailable', true);
                }
                if (target.intent === 'installation_recheck') {
                    const currentRecord = await readSelectedRecord();
                    if (
                        !fullRecord
                        || !currentRecord
                        || !sameSelectedRecordFact(
                            fullRecord,
                            currentRecord,
                        )
                    ) {
                        return failure('installation_replaced', false);
                    }
                    fullRecord = currentRecord;
                    if (!resolveStructurallyCompatibleVariant(
                        runtime,
                        fullRecord,
                    )) {
                        return failure('installation_replaced', false);
                    }
                }

                const resolved = await resolveInstallation({
                    machineId: input.machineId,
                    current: runtime,
                    dependencies,
                    ...(fullRecord ? { custodyRecord: fullRecord } : {}),
                    signal: operationSignal(options?.signal),
                }).catch((): Resolution => ({
                    ok: false,
                    reason: 'operation_failed',
                }));
                if (target.intent === 'install_preview') {
                    const currentCustody = await scanForCustody();
                    if (currentCustody === 'present') {
                        return failure('concurrent_edit', true);
                    }
                    if (currentCustody === 'failed') {
                        return failure('operation_failed', true);
                    }
                } else {
                    const currentRecord = await readSelectedRecord();
                    if (
                        !fullRecord
                        || !currentRecord
                        || !sameSelectedRecordFact(
                            fullRecord,
                            currentRecord,
                        )
                    ) {
                        return failure('installation_replaced', false);
                    }
                    fullRecord = currentRecord;
                }
                if (!resolved.ok) {
                    if (target.intent === 'install_preview') {
                        return failure(
                            resolved.reason === 'operation_failed'
                                ? 'operation_failed'
                                : resolved.reason,
                            resolved.reason === 'operation_failed',
                        );
                    }
                    return pointSuccess(
                        resolved.diagnostic
                            ? {
                                state: 'needs_attention',
                                installationId: target.installationId,
                                diagnostic: resolved.diagnostic,
                            }
                            : attention(
                                resolved.reason,
                                target.installationId,
                        ),
                    );
                }
                if (
                    fullRecord
                    && !recordMatchesResolution(
                        fullRecord,
                        resolved.value,
                    )
                ) {
                    return failure('installation_replaced', false);
                }
                if (
                    resolved.value.readiness.kind
                    === 'needs_attention'
                ) {
                    if (target.intent === 'install_preview') {
                        return failure(
                            resolved.value.readiness.diagnostic.code
                                === 'invalid_config'
                                ? 'invalid_config'
                                : 'installation_unsupported',
                            false,
                        );
                    }
                    return pointSuccess({
                        state: 'needs_attention',
                        installationId: target.installationId,
                        diagnostic:
                            resolved.value.readiness.diagnostic,
                    });
                }
                if (target.intent === 'installation_recheck') {
                    if (!fullRecord) {
                        return failure('installation_replaced', false);
                    }
                    if (
                        fullRecord.state === 'active'
                        && !listenerAvailable
                    ) {
                        return pointSuccess(attention(
                            'listener_unavailable',
                            target.installationId,
                        ));
                    }
                    return pointSuccess(statusFromRecord({
                        machineId: fullRecord.machineId,
                        qualifiedAgent: fullRecord.qualifiedAgent,
                        installationId: fullRecord.hostInstallationId,
                        variantId: fullRecord.variantId,
                        state: fullRecord.state,
                        updatedAtMs: fullRecord.updatedAtMs,
                        revision: fullRecord.revision,
                    }));
                }
                const preview = await planInstallPreview({
                    resolution: resolved.value,
                    listener,
                    dependencies,
                });
                if (!preview.ok) {
                    return failure(
                        preview.code === 'operation_failed'
                            ? 'operation_failed'
                            : preview.code,
                        preview.code === 'operation_failed',
                    );
                }
                const finalCustody = await scanForCustody();
                if (finalCustody === 'present') {
                    return failure('concurrent_edit', true);
                }
                if (finalCustody === 'failed') {
                    return failure('operation_failed', true);
                }
                return pointSuccess({
                        state: 'not_installed',
                        installPreview: preview.preview,
                    });
            } finally {
                await registryLease?.release().catch(() => undefined);
                releaseOperation();
            }
        },

        async install(
            target: PluginSessionHookInstallInputV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ):
        Promise<PluginSessionHookInstallResponseV1> {
            const releaseOperation = admitOperation();
            if (!releaseOperation || !featureEnabled() || options?.signal?.aborted) {
                return failure('operation_failed', false);
            }
            const registryLease = await dependencies
                .acquireRuntimeRegistryLease()
                .catch(() => null);
            if (!registryLease) {
                releaseOperation();
                return failure('agent_unavailable', true);
            }
            try {
                const definitions = [
                    ...registryLease.registry.contributes
                        .agentDefinitionsById.values(),
                ].filter((candidate) => (
                    candidate.identity?.pluginId === target.agent.pluginId
                    && candidate.identity.localId === target.agent.localId
                ));
                if (definitions.length !== 1) {
                    return failure('agent_unavailable', false);
                }
                await registryLease.registry.activateContributionsOnDemand([{
                    pluginId: target.agent.pluginId,
                    family: 'agents',
                    localId: target.agent.localId,
                }]);
                const current = findCurrentRuntime(
                    registryLease.registry,
                    target.agent,
                );
                if (!current) return failure('agent_unavailable', true);
                const resolution = await resolveInstallation({
                    machineId: input.machineId,
                    current,
                    dependencies,
                    signal: operationSignal(options?.signal),
                });
                if (!resolution.ok) {
                    return failure(
                        resolution.reason === 'operation_failed'
                            ? 'operation_failed'
                            : resolution.reason,
                        resolution.reason === 'operation_failed',
                    );
                }
                if (resolution.value.readiness.kind === 'needs_attention') {
                    return failure('installation_unsupported', false);
                }
                // Receipt recognition comes before the preview is recomputed.
                // A preview digests the agent configuration's current bytes,
                // and an accepted install has already appended its owned
                // entries to those bytes, so an exact replay can never
                // reproduce the preview id it was admitted with. The durable
                // record is the receipt; the replacement and concurrent-edit
                // checks below still run, against the identities the accepted
                // install recorded.
                const existingRecord =
                    await dependencies.readInstallationRecord(recordPath({
                        activeServerDir,
                        agent: current.agent,
                        installationId:
                            resolution.value.hostInstallationId,
                    }));
                if (existingRecord) {
                    // Admission validated the preview before this queued
                    // operation; a replay may observe the accepted record.
                    if (
                        existingRecord.machineId !== input.machineId
                        || existingRecord.qualifiedAgent.pluginId
                            !== current.agent.pluginId
                        || existingRecord.qualifiedAgent.localId
                            !== current.agent.localId
                        || !recordMatchesResolution(
                            existingRecord,
                            resolution.value,
                        )
                    ) {
                        return failure('installation_replaced', false);
                    }
                    const existingVariant =
                        resolveStructurallyCompatibleVariant(
                            current,
                            existingRecord,
                        );
                    if (
                        !existingVariant
                        || !await projectCurrentCustody({
                            record: existingRecord,
                            variant: existingVariant,
                            dependencies,
                        })
                    ) {
                        return failure('concurrent_edit', true);
                    }
                    return PluginSessionHookInstallResponseV1Schema.parse({
                        ok: true,
                        status: statusFromRecord({
                            machineId: existingRecord.machineId,
                            qualifiedAgent:
                                existingRecord.qualifiedAgent,
                            installationId:
                                existingRecord.hostInstallationId,
                            variantId: existingRecord.variantId,
                            state: existingRecord.state,
                            updatedAtMs: existingRecord.updatedAtMs,
                            revision: existingRecord.revision,
                        }),
                    });
                }
                const listener = await input.listener.catch(() => null);
                if (!listener) return failure('listener_unavailable', true);
                const preview = await planInstallPreview({
                    resolution: resolution.value,
                    listener,
                    dependencies,
                });
                if (!preview.ok) {
                    return failure(
                        preview.code,
                        preview.code === 'operation_failed',
                    );
                }
                if (preview.preview.previewId !== target.expectedPreviewId) {
                    return failure('concurrent_edit', true);
                }
                const credentials: Awaited<ReturnType<
                    QualifiedExternalSessionHookListener[
                        'createOrReuseCredential'
                    ]
                >>[] = [];
                let installationPrincipalRef: string | undefined;
                let durable = false;
                try {
                    for (const event of resolution.value.selectedVariant.events) {
                        const credential = await listener
                            .createOrReuseCredential({
                                machineId: input.machineId,
                                agentId: current.agentId,
                                qualifiedContributionId: current.agent,
                                hostInstallationId:
                                    resolution.value.hostInstallationId,
                                installationIdentity:
                                    resolution.value.installationIdentity,
                                variantId:
                                    resolution.value.selectedVariant.variantId,
                                eventId: event.eventId,
                                pluginGeneration: current.lease.generation,
                                retirementSignal:
                                    current.lease.retirementSignal,
                                ...(installationPrincipalRef
                                    ? { installationPrincipalRef }
                                    : {}),
                            });
                        installationPrincipalRef =
                            credential.installationPrincipalRef;
                        credentials.push(credential);
                        listener.disable(credential.eventPrincipalRef);
                        if (!operationIsCurrent(current, options?.signal)) {
                            throw new Error(
                                'Session-hook management host disposed',
                            );
                        }
                    }
                    const credentialByEventId = new Map(
                        credentials.map((credential) => [
                            credential.eventId,
                            credential,
                        ]),
                    );
                    const applied =
                        await dependencies.applyInstallationAction({
                            action: 'install',
                            activeServerDir,
                            machineId: input.machineId,
                            qualifiedAgent: current.agent,
                            hostInstallationId:
                                resolution.value.hostInstallationId,
                            installationIdentity:
                                resolution.value.installationIdentity,
                            executableIdentity:
                                resolution.value.executableIdentity,
                            ingressPrincipalRef:
                                installationPrincipalRef!,
                            selectedVariant:
                                resolution.value.selectedVariant,
                            targets: resolution.value.declaredTargets,
                            expectedInputIdentities:
                                preview.configSnapshot.targets.map(
                                    (configTarget) => ({
                                        targetId: configTarget.targetId,
                                        inputIdentity:
                                            configTarget.inputIdentity,
                                    }),
                                ),
                            generation: {
                                expected: current.lease.generation,
                                current: current.lease.generation,
                            },
                            isCurrent: () => (
                                operationIsCurrent(current, options?.signal)
                            ),
                            materializeOwnedEntry: ({ event }) => {
                                const credential =
                                    credentialByEventId.get(event.eventId);
                                if (!credential) {
                                    throw new Error(
                                        'Missing qualified hook credential',
                                    );
                                }
                                return listener.buildOwnedEntry({
                                    credential,
                                    event,
                                });
                            },
                        });
                    if (!applied.ok) {
                        for (const credential of credentials) {
                            await listener.revokeDurableCredential({
                                qualifiedContributionId: current.agent,
                                hostInstallationId:
                                    resolution.value.hostInstallationId,
                                installationPrincipalRef:
                                    credential.installationPrincipalRef,
                                eventId: credential.eventId,
                            }).catch(() => undefined);
                        }
                        return mapActionError(applied.code);
                    }
                    durable = true;
                    if (
                        applied.state !== 'installed_disabled'
                        || !operationIsCurrent(current, options?.signal)
                    ) {
                        return failure('installation_replaced', false);
                    }
                    const stagedRecord =
                        await dependencies.readInstallationRecord(recordPath({
                            activeServerDir,
                            agent: current.agent,
                            installationId:
                                resolution.value.hostInstallationId,
                        }));
                    if (
                        !stagedRecord
                        || stagedRecord.state !== 'disabled'
                        || !recordMatchesResolution(
                            stagedRecord,
                            resolution.value,
                        )
                    ) {
                        return failure('installation_replaced', false);
                    }
                    let readiness: Resolution;
                    try {
                        readiness = await resolveInstallation({
                            machineId: input.machineId,
                            current,
                            dependencies,
                            custodyRecord: stagedRecord,
                            signal: operationSignal(options?.signal),
                        });
                    } catch {
                        return PluginSessionHookInstallResponseV1Schema.parse({
                            ok: true,
                            status: attention(
                                'operation_failed',
                                stagedRecord.hostInstallationId,
                            ),
                        });
                    }
                    if (
                        !operationIsCurrent(current, options?.signal)
                        || !readiness.ok
                    ) {
                        return PluginSessionHookInstallResponseV1Schema.parse({
                            ok: true,
                            status: !readiness.ok
                                && readiness.diagnostic
                                ? {
                                    state: 'needs_attention',
                                    installationId:
                                        stagedRecord.hostInstallationId,
                                    diagnostic: readiness.diagnostic,
                                }
                                : attention(
                                    'operation_failed',
                                    stagedRecord.hostInstallationId,
                                ),
                        });
                    }
                    if (!recordMatchesResolution(
                        stagedRecord,
                        readiness.value,
                    )) {
                        return failure('installation_replaced', false);
                    }
                    if (
                        readiness.value.readiness.kind
                        === 'needs_attention'
                    ) {
                        return PluginSessionHookInstallResponseV1Schema.parse({
                            ok: true,
                            status: {
                                state: 'needs_attention',
                                installationId:
                                    stagedRecord.hostInstallationId,
                                diagnostic:
                                    readiness.value.readiness.diagnostic,
                            },
                        });
                    }
                    const enabled =
                        await dependencies.applyInstallationAction({
                            action: 'enable',
                            activeServerDir,
                            machineId: input.machineId,
                            qualifiedAgent: current.agent,
                            hostInstallationId:
                                stagedRecord.hostInstallationId,
                            installationIdentity:
                                stagedRecord.installationIdentity,
                            executableIdentity:
                                stagedRecord.executableIdentity,
                            ingressPrincipalRef:
                                stagedRecord.ingressPrincipalRef,
                            generation: {
                                expected: current.lease.generation,
                                current: current.lease.generation,
                            },
                            isCurrent: () => operationIsCurrent(current, options?.signal),
                        });
                    if (!enabled.ok) return mapActionError(enabled.code);
                    if (!operationIsCurrent(current, options?.signal)) {
                        await dependencies.applyInstallationAction({
                            action: 'disable',
                            activeServerDir,
                            machineId: input.machineId,
                            qualifiedAgent: current.agent,
                            hostInstallationId:
                                stagedRecord.hostInstallationId,
                            installationIdentity:
                                stagedRecord.installationIdentity,
                            executableIdentity:
                                stagedRecord.executableIdentity,
                            ingressPrincipalRef:
                                stagedRecord.ingressPrincipalRef,
                        }).catch(() => undefined);
                        return failure('installation_replaced', false);
                    }
                    try {
                        for (const credential of credentials) {
                            listener.enable(credential.eventPrincipalRef);
                        }
                    } catch {
                        for (const credential of credentials) {
                            listener.disable(credential.eventPrincipalRef);
                        }
                        await dependencies.applyInstallationAction({
                            action: 'disable',
                            activeServerDir,
                            machineId: input.machineId,
                            qualifiedAgent: current.agent,
                            hostInstallationId:
                                stagedRecord.hostInstallationId,
                            installationIdentity:
                                stagedRecord.installationIdentity,
                            executableIdentity:
                                stagedRecord.executableIdentity,
                            ingressPrincipalRef:
                                stagedRecord.ingressPrincipalRef,
                        }).catch(() => undefined);
                        return failure('listener_unavailable', true);
                    }
                    return PluginSessionHookInstallResponseV1Schema.parse({
                        ok: true,
                        status: {
                            state: 'installed_enabled',
                            installationId:
                                resolution.value.hostInstallationId,
                        },
                    });
                } catch {
                    if (!durable) {
                        for (const credential of credentials) {
                            await listener.revokeDurableCredential({
                                qualifiedContributionId: current.agent,
                                hostInstallationId:
                                    resolution.value.hostInstallationId,
                                installationPrincipalRef:
                                    credential.installationPrincipalRef,
                                eventId: credential.eventId,
                            }).catch(() => undefined);
                        }
                    }
                    return failure('operation_failed', true);
                }
            } finally {
                await registryLease.release().catch(() => undefined);
                releaseOperation();
            }
        },

        async disable(
            mutation: PluginSessionHookInstallationMutationInputV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ):
        Promise<PluginSessionHookToggleResponseV1> {
            const releaseOperation = admitOperation();
            if (!releaseOperation || !featureEnabled() || options?.signal?.aborted) {
                return failure('operation_failed', false);
            }
            try {
                const record = await loadRecord(mutation);
                if (!record) return failure('installation_replaced', false);
                const applied = await dependencies.applyInstallationAction({
                    action: 'disable',
                    activeServerDir,
                    machineId: input.machineId,
                    qualifiedAgent: mutation.agent,
                    hostInstallationId: record.hostInstallationId,
                    installationIdentity: record.installationIdentity,
                    executableIdentity: record.executableIdentity,
                    ingressPrincipalRef: record.ingressPrincipalRef,
                    isCurrent: () => operationIsCurrent(undefined, options?.signal),
                });
                if (!applied.ok) return mapActionError(applied.code);
                const listener = await input.listener.catch(() => null);
                if (listener) {
                    for (const eventId of ownedEventIds(record)) {
                        try {
                            listener.disableDurableCredential({
                                qualifiedContributionId: mutation.agent,
                                hostInstallationId:
                                    record.hostInstallationId,
                                installationPrincipalRef:
                                    record.ingressPrincipalRef,
                                eventId,
                            });
                        } catch {
                            // Durable disabled custody is authoritative.
                        }
                    }
                }
                return PluginSessionHookToggleResponseV1Schema.parse({
                    ok: true,
                    status: {
                        state: 'installed_disabled',
                        installationId: record.hostInstallationId,
                    },
                });
            } finally {
                releaseOperation();
            }
        },

        async enable(
            mutation: PluginSessionHookInstallationMutationInputV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ):
        Promise<PluginSessionHookToggleResponseV1> {
            const releaseOperation = admitOperation();
            if (!releaseOperation || !featureEnabled() || options?.signal?.aborted) {
                return failure('operation_failed', false);
            }
            const record = await loadRecord(mutation);
            if (!record) {
                releaseOperation();
                return failure('installation_replaced', false);
            }
            const registryLease = await dependencies
                .acquireRuntimeRegistryLease()
                .catch(() => null);
            if (!registryLease) {
                releaseOperation();
                return failure('agent_unavailable', true);
            }
            try {
                await registryLease.registry.activateContributionsOnDemand([{
                    pluginId: mutation.agent.pluginId,
                    family: 'agents',
                    localId: mutation.agent.localId,
                }]);
                const current = findCurrentRuntime(
                    registryLease.registry,
                    mutation.agent,
                );
                if (!current) {
                    return failure('agent_unavailable', true);
                }
                let resolution: Resolution;
                try {
                    resolution = await resolveInstallation({
                        machineId: input.machineId,
                        current,
                        dependencies,
                        custodyRecord: record,
                        signal: operationSignal(options?.signal),
                    });
                } catch {
                    return PluginSessionHookToggleResponseV1Schema.parse({
                        ok: true,
                        status: attention(
                            'operation_failed',
                            record.hostInstallationId,
                        ),
                    });
                }
                if (
                    !operationIsCurrent(current, options?.signal)
                    || !resolution.ok
                ) {
                    return PluginSessionHookToggleResponseV1Schema.parse({
                        ok: true,
                        status: !resolution.ok
                            && resolution.diagnostic
                            ? {
                                state: 'needs_attention',
                                installationId:
                                    record.hostInstallationId,
                                diagnostic: resolution.diagnostic,
                            }
                            : attention(
                                'operation_failed',
                                record.hostInstallationId,
                            ),
                    });
                }
                if (!recordMatchesResolution(record, resolution.value)) {
                    return failure('installation_replaced', false);
                }
                if (
                    resolution.value.readiness.kind
                    === 'needs_attention'
                ) {
                    return PluginSessionHookToggleResponseV1Schema.parse({
                        ok: true,
                        status: {
                            state: 'needs_attention',
                            installationId: record.hostInstallationId,
                            diagnostic:
                                resolution.value.readiness.diagnostic,
                        },
                    });
                }
                const variant = resolution.value.selectedVariant;
                const listener = await input.listener.catch(() => null);
                if (!listener) return failure('listener_unavailable', true);
                const credentials: Awaited<ReturnType<
                    QualifiedExternalSessionHookListener[
                        'createOrReuseCredential'
                    ]
                >>[] = [];
                try {
                    for (const event of variant.events) {
                        if (!ownedEventIds(record).includes(event.eventId)) {
                            return failure('installation_replaced', false);
                        }
                        const credential =
                            await listener.createOrReuseCredential({
                                machineId: input.machineId,
                                agentId: current.agentId,
                                qualifiedContributionId: current.agent,
                                hostInstallationId:
                                    record.hostInstallationId,
                                installationPrincipalRef:
                                    record.ingressPrincipalRef,
                                installationIdentity:
                                    record.installationIdentity,
                                variantId: record.variantId,
                                eventId: event.eventId,
                                pluginGeneration: current.lease.generation,
                                retirementSignal:
                                    current.lease.retirementSignal,
                            });
                        credentials.push(credential);
                        listener.disable(credential.eventPrincipalRef);
                        if (!operationIsCurrent(current, options?.signal)) {
                            return failure('installation_replaced', false);
                        }
                    }
                } catch {
                    return failure('listener_unavailable', true);
                }
                const applied = await dependencies.applyInstallationAction({
                    action: 'enable',
                    activeServerDir,
                    machineId: input.machineId,
                    qualifiedAgent: mutation.agent,
                    hostInstallationId: record.hostInstallationId,
                    installationIdentity: record.installationIdentity,
                    executableIdentity: record.executableIdentity,
                    ingressPrincipalRef: record.ingressPrincipalRef,
                    generation: {
                        expected: current.lease.generation,
                        current: current.lease.generation,
                    },
                    isCurrent: () => (
                        operationIsCurrent(current, options?.signal)
                    ),
                });
                if (!applied.ok) return mapActionError(applied.code);
                if (!operationIsCurrent(current, options?.signal)) {
                    await dependencies.applyInstallationAction({
                        action: 'disable',
                        activeServerDir,
                        machineId: input.machineId,
                        qualifiedAgent: mutation.agent,
                        hostInstallationId: record.hostInstallationId,
                        installationIdentity: record.installationIdentity,
                        executableIdentity: record.executableIdentity,
                        ingressPrincipalRef: record.ingressPrincipalRef,
                    }).catch(() => undefined);
                    return failure('installation_replaced', false);
                }
                try {
                    for (const credential of credentials) {
                        listener.enable(credential.eventPrincipalRef);
                    }
                } catch {
                    for (const credential of credentials) {
                        listener.disable(credential.eventPrincipalRef);
                    }
                    await dependencies.applyInstallationAction({
                        action: 'disable',
                        activeServerDir,
                        machineId: input.machineId,
                        qualifiedAgent: mutation.agent,
                        hostInstallationId: record.hostInstallationId,
                        installationIdentity: record.installationIdentity,
                        executableIdentity: record.executableIdentity,
                        ingressPrincipalRef: record.ingressPrincipalRef,
                    }).catch(() => undefined);
                    return failure('listener_unavailable', true);
                }
                return PluginSessionHookToggleResponseV1Schema.parse({
                    ok: true,
                    status: {
                        state: 'installed_enabled',
                        installationId: record.hostInstallationId,
                    },
                });
            } finally {
                await registryLease.release().catch(() => undefined);
                releaseOperation();
            }
        },

        async uninstall(
            mutation: PluginSessionHookInstallationMutationInputV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ):
        Promise<PluginSessionHookUninstallResponseV1> {
            const releaseOperation = admitOperation();
            if (!releaseOperation || !featureEnabled() || options?.signal?.aborted) {
                return failure('operation_failed', false);
            }
            const record = await loadRecord(mutation);
            if (!record) {
                releaseOperation();
                return failure('installation_replaced', false);
            }
            const listener = await input.listener.catch(() => null);
            try {
                // A crash between the transitional record and its final state
                // leaves `preparing` or `revoked` custody, which Disable
                // refuses by contract. Those records are exactly the ones the
                // product surfaces as needing attention, so Uninstall cleans
                // them directly through the same exact-occurrence removal.
                if (record.state === 'active' || record.state === 'disabled') {
                    const disabled =
                        await dependencies.applyInstallationAction({
                            action: 'disable',
                            activeServerDir,
                            machineId: input.machineId,
                            qualifiedAgent: mutation.agent,
                            hostInstallationId: record.hostInstallationId,
                            installationIdentity:
                                record.installationIdentity,
                            executableIdentity: record.executableIdentity,
                            ingressPrincipalRef: record.ingressPrincipalRef,
                            isCurrent: () => operationIsCurrent(undefined, options?.signal),
                        });
                    if (!disabled.ok) return mapActionError(disabled.code);
                }
                for (const eventId of ownedEventIds(record)) {
                    const credential = {
                        qualifiedContributionId: mutation.agent,
                        hostInstallationId: record.hostInstallationId,
                        installationPrincipalRef:
                            record.ingressPrincipalRef,
                        eventId,
                    };
                    if (listener) {
                        await listener.revokeDurableCredential(credential);
                    } else {
                        await revokeQualifiedExternalSessionHookDurableCredential({
                            activeServerDir,
                            ...credential,
                        });
                    }
                }
                const applied =
                    await dependencies.applyInstallationAction({
                        action: 'uninstall',
                        activeServerDir,
                        machineId: input.machineId,
                        qualifiedAgent: mutation.agent,
                        hostInstallationId: record.hostInstallationId,
                        installationIdentity:
                            record.installationIdentity,
                        executableIdentity: record.executableIdentity,
                        ingressPrincipalRef: record.ingressPrincipalRef,
                        isCurrent: () => operationIsCurrent(undefined, options?.signal),
                    });
                if (!applied.ok) return mapActionError(applied.code);
                return PluginSessionHookUninstallResponseV1Schema.parse({
                    ok: true,
                    status: { state: 'not_installed' },
                });
            } catch {
                return failure('operation_failed', true);
            } finally {
                releaseOperation();
            }
        },
    };
    return {
        ...host,
        status: async (target, options) => (
            target.intent === 'passive_inventory'
                ? await host.status(target, options)
                : await withMutationLock(
                    mutationKey(
                        target.agent,
                        target.intent === 'installation_recheck'
                            ? target.installationId
                            : hostInstallationId(
                                input.machineId,
                                target.agent,
                            ),
                    ),
                    async () => await host.status(target, options),
                )
        ),
        install: async (target, options) => await withMutationLock(
            mutationKey(
                target.agent,
                hostInstallationId(input.machineId, target.agent),
            ),
            async () => await host.install(target, options),
        ),
        disable: async (target, options) => await withMutationLock(
            mutationKey(target.agent, target.installationId),
            async () => await host.disable(target, options),
        ),
        enable: async (target, options) => await withMutationLock(
            mutationKey(target.agent, target.installationId),
            async () => await host.enable(target, options),
        ),
        uninstall: async (target, options) => await withMutationLock(
            mutationKey(target.agent, target.installationId),
            async () => await host.uninstall(target, options),
        ),
    };
}
