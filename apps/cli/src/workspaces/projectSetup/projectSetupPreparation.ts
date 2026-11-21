import { createHash } from 'node:crypto';
import { readHostAdmittedReviewedRootV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { WorkspaceRefV1Schema, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectCommandSourceV1, ProjectToolchainSelectionV1, ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { ProjectManifestFileSnapshot } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { QualifiedProjectTrustProjectV1Schema, type QualifiedProjectTrustProjectV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import type { ProjectSetupReadinessV1, ProjectDefinitionInspectOutput } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectSetupReviewV1Schema, type ProjectSetupReviewV1 } from '@happier-dev/protocol/actions/projectSetupConsentFailure';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SecretReferenceOverlayV1Schema, listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference, type SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';

import { LaunchSecretReferenceOverlayError, listMissingProjectSecretRequirements, resolveProjectSecretReferenceEnvironment, type ProjectSecretReferenceEnvironmentInput } from '@/settings/secrets/secretReferenceOverlay';
import type { ScmStatusSnapshotResponse } from '@happier-dev/protocol/scm';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { createNonRepositoryScmSnapshotResponse, runScmRoute } from '@/scm/rpc/dispatch';
import { preserveUnconfirmedNativeProcess, type ProjectNativeAdapterLeaseV1, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { resolveProjectToolchainSelection, inspectProjectNativeCommand, type ProjectNativeCommandIo, type ProjectNativeCommandResult, type ProjectNativeFileFact } from './projectNativeResolution';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';
import type { ProjectSetupReadV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { prepareProjectLaunchEnvironment, type PreparedProjectLaunchInput } from './projectLaunchEnvironment';
import { createProjectDotenvPreparation, type ProjectDotenvPreparation } from './projectDotenv';
import { readLiteralCommandExecutedFiles, type LiteralCommandFileFactV1 } from './literalCommandFiles';
import { readWorkspaceSyncChildMachineFacts } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { isManagedDevcontainerChildProjectionCurrentV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { readProjectDefinitionFile, readProjectDefinitionFileBytes } from './nativeDefinitionFiles';
import { createProjectSetupTrustClient, type ProjectCheckoutTeardownConsent, type ProjectSetupTrustClientInput } from './projectSetupTrust';
import { createProjectSetupSuccessStore, type ProjectSetupSuccessBasis } from './projectSetupSuccess';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { performance } from 'node:perf_hooks';
import { logger } from '@/utils/logger';
import { isHostRequesterUnrestrictedOwner, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';

export type PreparedProjectSetupCommand = Readonly<(
    { kind: 'literal'; source: Extract<ProjectCommandSourceV1, { kind: 'command' }>; cwd: string }
    | { kind: 'native'; source: Extract<ProjectCommandSourceV1, { kind: 'native' }>; resolution: Extract<ProjectNativeCommandResult, { kind: 'resolved' }> }
    | { kind: 'pluginNative'; source: Extract<ProjectCommandSourceV1, { kind: 'pluginNative' }>; resolution: Extract<ProjectNativeCommandResult, { kind: 'pluginResolved' }>['command']; lease: ProjectNativeAdapterProductionV1 }
    | { kind: 'pluginNativeReference'; source: Extract<ProjectCommandSourceV1, { kind: 'pluginNative' }>; reviewInputs: readonly ProjectNativeFileFact[]; lease: ProjectNativeAdapterLeaseV1 }
) & { inputFiles?: readonly LiteralCommandFileFactV1[] }>;

export type ProjectSetupPreparationInput = Readonly<{
    workspace: WorkspaceRefV1;
    /** Resolved by the accepted Workspace/Project row owner, never from Action input. */
    projectAssociation: Readonly<{ workspace: WorkspaceRefV1; project: QualifiedProjectTrustProjectV1 }>;
    requester: ProjectSetupTrustClientInput;
    /** Already opened detail retained by the same review/preparation; never Action input. */
    acceptedSetup?: ProjectSetupReadV1;
    /** Host-selected execution identity; never inferred from credentials or Action operands. */
    requesterIdentity?: HostRequesterExecutionIdentity;
    purpose: 'setup' | 'teardown';
    platform: Readonly<{ os: string; arch: string }>;
    nativeIo: ProjectNativeCommandIo;
    environmentBindings?: SecretReferenceOverlayV1;
    secretEnvironment?: Omit<ProjectSecretReferenceEnvironmentInput, 'requirements' | 'secretReferenceOverlay'>;
    /** Selected values opened by the retained-copy controller, kept outside the reviewed effect. */
    admittedTeardownEnvironment?: Readonly<Record<string, string>>;
    configEnvironment?: Readonly<Record<string, string>>;
    profileEnvironment?: Readonly<Record<string, string>>;
    invocationEnvironment?: ProcessEnvInput;
    /** Prepared on the execution host after admission; never persisted in consent. */
    runtimeEnvironment?: Readonly<Record<string, string>>;
    /** Invocation-private snapshot shared by review, launch and declared-name discovery. */
    dotenvPreparation?: ProjectDotenvPreparation;
    originalEnvironment?: Readonly<NodeJS.ProcessEnv>;
    /** Host SCM catalog port; never a caller-provided repository or commit claim. */
    scmRegistry?: ScmBackendRegistry;
    plugins?: Pick<ResolvedExecutablePluginRuntimeRegistry, 'resolveProjectNativeAdapter'>
        & Partial<Pick<ResolvedExecutablePluginRuntimeRegistry, 'secretSources'>>;
    /** The containing accepted operation owns these invocations through actual settlement. */
    retainNativeInvocation?: (production: import('@/plugins/runtime/invocation/services/exec').ProjectNativeEffectCaptureForHost) => void;
    successHomeDir?: string;
    /** Explicit Setup may reuse only a completion produced after the request began. */
    setupRequestedAtMs?: number;
    /** Supplied only by the admitted host decision producer, never raw Action params or custodian credentials. */
    effectDecision?: Readonly<{ project: QualifiedProjectTrustProjectV1; reviewedEffectDigest: string }>;
    /** The admitted host's original surface and Account policy, never Project Action input. */
    approvalContext?: ActionExecutorContext;
    /** Unattended checkout destruction consumes remembered lifecycle consent only. */
    requireRememberedConsent?: boolean;
    /** The accepted checkout's requester Trust fact for this teardown operation. */
    checkoutTeardownConsent?: ProjectCheckoutTeardownConsent;
    signal?: AbortSignal;
}>;

export type ProjectSetupReviewPresentation = Readonly<{
    bindings: readonly Readonly<{ name: string; ref: string; revision?: number; source: 'personal' | 'shared_resource'; displayName: string | null }>[];
    provenance: Readonly<{
        file: '.happier/project.json';
        kind: 'repository' | 'nonRepository' | 'unavailable';
        /** Repository HEAD is context, not proof the current reviewed file bytes were committed. */
        headCommit?: string;
        branch?: string;
        fileState: 'modified' | 'untracked' | 'unknown' | 'absent';
        /** Additive display evidence; legacy fileState readers remain valid. Never consent. */
        committed?: Readonly<{ commit: string }>;
    }>;
}>;

export type ProjectSetupReviewedEffect = Readonly<{
    v: 1;
    purpose: 'setup' | 'teardown';
    commands: readonly unknown[];
    lifecycle: Readonly<Record<ProjectSetupPreparationInput['purpose'], readonly unknown[]>>;
    autostart?: readonly Readonly<{ name: string; commands: readonly unknown[] }>[];
    toolchain: Readonly<{ selection: ProjectToolchainSelectionV1; adapterVersion?: string; tool?: Readonly<{ executable?: string; version?: string }> }>;
    files: readonly Readonly<{ file: string; digest: string }>[];
    setupInputs: readonly Readonly<{ file: string; digest: string }>[];
    bindings: readonly Readonly<{ name: string; ref: string; revision?: number }>[];
    configEnvironment: Readonly<Record<string, string>>;
    presentation: ProjectSetupReviewPresentation;
}>;

export type PreparedProjectSetupPlan = Readonly<{
    workspace: WorkspaceRefV1;
    project: QualifiedProjectTrustProjectV1;
    purpose: 'setup' | 'teardown';
    manifest: ProjectManifestV1 | null;
    fileBasis: ProjectManifestFileSnapshot['basis'];
    commands: readonly PreparedProjectSetupCommand[];
    toolchain: ProjectToolchainSelectionV1;
    toolchainAdapterLease?: ProjectNativeAdapterLeaseV1;
    /** Host-private config facts consumed by the same selected adapter at final production. */
    toolchainReviewInputs: readonly ProjectNativeFileFact[];
    toolchainInputFiles?: readonly LiteralCommandFileFactV1[];
    /** Never part of the serializable reviewed effect or its consent digest. */
    privateConfigEnvironment?: Readonly<Record<string, string>>;
    preparedLaunchInput: PreparedProjectLaunchInput;
    /** The same invocation-private file snapshot is reused after runtime assignment. */
    dotenvPreparation: ProjectDotenvPreparation;
    runtimeEnvironment?: Readonly<Record<string, string>>;
    configEnvironment: Readonly<Record<string, string>>;
    /** Host-private execution baseline; excludes setup/teardown commands and explicit setupInputs. */
    executionEnvironmentEffectDigest: string;
    reviewedEffect: ProjectSetupReviewedEffect;
    reviewedEffectDigest: string;
    successBasis: ProjectSetupSuccessBasis;
}>;

export type ProjectSetupPreparationRefusal = Readonly<{ kind: 'refused'; code: string }>;
export type ProjectSetupPreparationOutcome = ProjectSetupPreparationRefusal
    | Readonly<{ kind: 'notRequired'; plan: PreparedProjectSetupPlan }>
    | Readonly<{ kind: 'skippedForInvocation'; plan: PreparedProjectSetupPlan }>
    | Readonly<{ kind: 'pendingApproval'; code: 'project_setup_consent_required' | 'project_setup_effect_changed'; plan: PreparedProjectSetupPlan }>
    | Readonly<{ kind: 'prepared'; plan: PreparedProjectSetupPlan; consent: 'trusted' | 'thisTime' | 'completed'; previousSuccess: boolean; confirmedCommandCount: number }>;

const refuse = (code: string): ProjectSetupPreparationRefusal => ({ kind: 'refused', code });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(createCanonicalJsonSigningInput(value));

/** The declared non-secret bindings, shared by passive admission and effect review. */
export function resolveProjectSetupConfigEnvironment(manifest: ProjectManifestV1 | null,
    values: ProjectSetupPreparationInput['configEnvironment']): ProjectSetupPreparationRefusal | Readonly<{ kind: 'ready'; environment: Readonly<Record<string, string>> }> {
    const environment: Record<string, string> = Object.create(null);
    for (const requirement of manifest?.environmentVariables?.filter(requirement => requirement.kind === 'config') ?? []) {
        const value = values?.[requirement.name];
        // Required-value readiness belongs to the demanded private launch preparation.
        // Passive effect selection records only deliberate, non-secret config values.
        if (value?.includes('\0')) return refuse('project_environment_binding_unavailable');
        if (value !== undefined) environment[requirement.name] = value;
    }
    return { kind: 'ready', environment: Object.freeze(environment) };
}

/** Normalize only generated root-derived native paths. Execution tuples retain absolute paths. */
function reviewPath(root: string, value: string): string {
    if (!isAbsolute(value)) return value;
    const local = relative(root, value);
    return local === '' ? '.' : local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
        ? `./${local.replaceAll('\\', '/')}` : value;
}

function associationMatches(input: ProjectSetupPreparationInput): boolean {
    const workspace = WorkspaceRefV1Schema.safeParse(input.workspace);
    const associated = WorkspaceRefV1Schema.safeParse(input.projectAssociation.workspace);
    const project = QualifiedProjectTrustProjectV1Schema.safeParse(input.projectAssociation.project);
    return workspace.success && associated.success
        && typeof workspace.data.projectKey === 'string' && workspace.data.projectKey.length > 0
        && project.success && project.data.serverId === workspace.data.serverId && project.data.projectId === workspace.data.projectKey
        && (['id', 'serverId', 'machineId', 'rootPath', 'projectKey'] as const)
            .every(field => workspace.data[field] === associated.data[field]);
}

async function readReviewProvenance(input: ProjectSetupPreparationInput, root: string, basis: ProjectManifestFileSnapshot['basis'],
    presentation?: Pick<ProjectSetupReviewPresentation, 'provenance'>): Promise<ProjectSetupReviewPresentation['provenance']> {
    if (!input.requesterIdentity || !isHostRequesterUnrestrictedOwner(input.requesterIdentity)) {
        return { kind: 'unavailable', file: '.happier/project.json', fileState: 'unknown' };
    }
    if (presentation) return presentation.provenance;
    const manifestPresent = basis.kind === 'present';
    const base = { file: '.happier/project.json' as const, fileState: manifestPresent ? 'unknown' as const : 'absent' as const };
    const registryStartedAt = performance.now();
    let registryReady = false;
    try {
        return await runWithScmBackendRegistryLease(input.scmRegistry, async (registry): Promise<ProjectSetupReviewPresentation['provenance']> => {
            registryReady = true;
            logger.debug('[ProjectSetup] launch phase', { phase: 'review_provenance_registry',
                durationMs: Math.round(performance.now() - registryStartedAt) });
            // No installed detector has observed the path; absence of a catalog is not non-repository evidence.
            if (registry.listBackends().length === 0) return { ...base, kind: 'unavailable' };
            let committedAt: string | undefined;
            const statusStartedAt = performance.now();
            const response = await runScmRoute<{ cwd: string }, ScmStatusSnapshotResponse>({
                request: { cwd: root }, workingDirectory: root, registry, signal: input.signal,
                onNonRepository: ({ cwd, workingDirectory }) => createNonRepositoryScmSnapshotResponse({ cwd, workingDirectory }),
                runWithBackend: async ({ context, selection }) => {
                    const status = await selection.backend.statusSnapshot({ context, request: { cwd: root } });
                    const snapshot = status.success ? status.snapshot : undefined;
                    const manifestPath = snapshot?.repo.rootPath
                        ? relative(snapshot.repo.rootPath, resolve(root, base.file)).replaceAll('\\', '/') : null;
                    if (basis.kind !== 'present' || !snapshot?.branch.headOid || !manifestPath
                        || snapshot.entries.some(entry => entry.path === manifestPath) || !selection.backend.fileAtRevision) return status;
                    // Status omits both clean tracked and ignored files. Read through the
                    // selected SCM owner and match the exact bytes already reviewed.
                    const committed = await selection.backend.fileAtRevision({ context, request: {
                        cwd: root, path: manifestPath, selector: { side: 'before', area: 'included' },
                    } });
                    if (committed.success && committed.sha256 === basis.hash) {
                        committedAt = snapshot.branch.headOid;
                    }
                    return status;
                },
            }).finally(() => {
                logger.debug('[ProjectSetup] launch phase', { phase: 'review_provenance_status',
                    durationMs: Math.round(performance.now() - statusStartedAt) });
            });
            if (!response.success || !response.snapshot) return { ...base, kind: 'unavailable' };
            const snapshot = response.snapshot;
            if (!snapshot.repo.isRepo) return { ...base, kind: 'nonRepository' };
            const manifestPath = snapshot.repo.rootPath
                ? relative(snapshot.repo.rootPath, resolve(root, base.file)).replaceAll('\\', '/') : null;
            const entry = manifestPath === null ? undefined : snapshot.entries.find(entry => entry.path === manifestPath);
            return {
                ...base, kind: 'repository',
                ...(snapshot.branch.headOid ? { headCommit: snapshot.branch.headOid } : {}),
                ...(snapshot.branch.head && !snapshot.branch.detached ? { branch: snapshot.branch.head } : {}),
                ...(committedAt ? { committed: { commit: committedAt } } : {}),
                // Preserve the legacy enum; only the separate proven fact means committed.
                fileState: !manifestPresent ? 'absent' : entry ? entry.kind === 'untracked' ? 'untracked' : 'modified' : 'unknown',
            };
        }, { includeHostingProviders: false });
    } catch {
        if (!registryReady) logger.debug('[ProjectSetup] launch phase', { phase: 'review_provenance_registry',
            outcome: 'unavailable', durationMs: Math.round(performance.now() - registryStartedAt) });
        return { ...base, kind: 'unavailable' };
    }
}

/** One namespace decision for passive cold preflight and complete setup review. */
export async function readProjectSetupNamespaceRefusal(input: Pick<ProjectSetupPreparationInput, 'workspace' | 'requester' | 'signal'>,
    manifest: ProjectManifestV1 | null): Promise<ProjectSetupPreparationRefusal | null> {
    if (!manifest?.devcontainer) return null;
    const children = await readWorkspaceSyncChildMachineFacts({ serverId: input.workspace.serverId,
        purpose: 'child_namespace', ...input.requester, credentials: input.requester.credentials,
        machineIds: [input.workspace.machineId], signal: input.signal });
    const child = children[0];
    return children.length !== 1 || !child || !child.managedMachine || !isManagedDevcontainerChildProjectionCurrentV1({ homeId: input.workspace.serverId,
        machineId: input.workspace.machineId, projection: child.projection, managedMachine: child.managedMachine })
        || resolveWorkspaceRefV1([input.workspace], { serverId: input.workspace.serverId,
            machineId: input.workspace.machineId, rootPath: child.projection.observation.workspaceFolder }).kind !== 'resolved'
        ? refuse('child_required') : null;
}

/** Current-byte review with registered read-only SCM metadata; no environment evaluation, native effects, installation or grant. */
export async function reviewProjectSetupEffect(input: ProjectSetupPreparationInput,
    presentation?: Pick<ProjectSetupReviewPresentation, 'provenance'>): Promise<ProjectSetupPreparationRefusal | Readonly<{ kind: 'reviewed'; plan: PreparedProjectSetupPlan }>> {
    return reviewProjectEffect(input, presentation, true);
}

/** A terminal admits its native environment, without setup commands, inputs or consent. */
export async function reviewProjectExecutionEnvironment(input: Omit<ProjectSetupPreparationInput, 'purpose'>): Promise<ProjectSetupPreparationRefusal | Readonly<{ kind: 'reviewed'; plan: PreparedProjectSetupPlan }>> {
    return reviewProjectEffect({ ...input, purpose: 'setup' }, {
        provenance: { kind: 'unavailable', file: '.happier/project.json', fileState: 'unknown' },
    }, false);
}

async function reviewProjectEffect(input: ProjectSetupPreparationInput,
    presentation: Pick<ProjectSetupReviewPresentation, 'provenance'> | undefined,
    includeSetupEffects: boolean): Promise<ProjectSetupPreparationRefusal | Readonly<{ kind: 'reviewed'; plan: PreparedProjectSetupPlan }>> {
    if (!associationMatches(input)) return refuse('project_workspace_association_mismatch');
    if (input.signal?.aborted) return refuse('project_setup_cancelled');
    const root = resolve(input.workspace.rootPath);
    try {
        const requester = input.requester;
        const account = requester.authorization ? { authorization: requester.authorization,
            effectActionId: requester.effectActionId ?? requester.authorization.binding.actionId }
            : requester.credentials ? { credentials: requester.credentials } : null;
        if (!account) return refuse('project_requester_credentials_unavailable');
        const { snapshot, effectiveDefinition } = await readProjectEffectiveDefinition({ root, account,
            project: input.projectAssociation.project, serverHttpBaseUrl: requester.serverHttpBaseUrl,
            signal: input.signal, ...(input.acceptedSetup ? { acceptedSetup: input.acceptedSetup } : {}) });
        const manifest = effectiveDefinition.effectiveManifest;
        const namespaceRefusal = await readProjectSetupNamespaceRefusal(input, manifest);
        if (namespaceRefusal) return namespaceRefusal;
        const toolchainSelection = manifest?.toolchain ?? { kind: 'host' as const };
        const selectedToolchain = await resolveProjectToolchainSelection({ root, selection: toolchainSelection });
        if (selectedToolchain.kind === 'refused') return refuse(selectedToolchain.code);
        // Unevaluated Nix is a passive inspection fact, not an unsupported
        // toolchain. Review its bytes here; the qualified native producer
        // evaluates under the admitted setup consent or terminal approval.
        if (selectedToolchain.coverage === 'partial'
            && (selectedToolchain.diagnostics.length === 0
                || selectedToolchain.diagnostics.some(diagnostic => diagnostic.code !== 'unevaluated_nix'))) {
            return refuse('native_toolchain_dynamic_unsupported');
        }
        const toolchain = selectedToolchain.selection;
        const toolchainReviewInputs: ProjectNativeFileFact[] = selectedToolchain.file !== undefined && selectedToolchain.content !== undefined
            ? [{ file: selectedToolchain.file, content: selectedToolchain.content }] : [];
        const files = new Map<string, string>();
        async function addFile(file: string, expectedContent?: string): Promise<ProjectSetupPreparationRefusal | null> {
            const result = await readProjectDefinitionFileBytes(root, file);
            if (result.kind === 'absent') return refuse('setup_input_missing');
            if (result.kind === 'refused') return refuse(result.code);
            if (expectedContent !== undefined && result.bytes.toString('utf8') !== expectedContent) return refuse('project_setup_effect_changed');
            const normalized = relative(root, resolve(root, file.replaceAll('\\', '/'))).replaceAll('\\', '/');
            const value = hash(result.bytes);
            const prior = files.get(normalized);
            if (prior !== undefined && prior !== value) return refuse('project_setup_effect_changed');
            files.set(normalized, value);
            return null;
        }
        if (selectedToolchain.file !== undefined) {
            const result = await addFile(selectedToolchain.file, selectedToolchain.content);
            if (result) return result;
        }
        let toolchainAdapterLease: ProjectNativeAdapterLeaseV1 | undefined;
        let toolchainAdapterVersion: string | undefined;
        let toolchainTool: Readonly<{ executablePath: string; version?: string }> | undefined;
        if (toolchain.kind === 'pluginToolchain') {
            if (!input.plugins) return refuse('native_adapter_unavailable');
            const selected = await input.plugins.resolveProjectNativeAdapter(toolchain.adapter, 'prepareToolchain');
            if (selected.kind === 'refused') return refuse(selected.code);
            toolchainAdapterLease = selected.lease;
            toolchainAdapterVersion = selected.lease.pluginVersion;
        } else if (toolchain.kind === 'toolchain') {
            toolchainTool = await input.nativeIo.resolveTool(toolchain.tool === 'nix_flake' ? 'nix' : toolchain.tool, {
                cwd: root, ...(input.signal ? { signal: input.signal } : {}),
            }) ?? undefined;
            if (!toolchainTool) return refuse('native_tool_unavailable');
            if (!isAbsolute(toolchainTool.executablePath) || toolchainTool.executablePath.includes('\0')) return refuse('native_tool_invalid');
            if (reviewPath(root, toolchainTool.executablePath) !== toolchainTool.executablePath) {
                const result = await addFile(relative(root, toolchainTool.executablePath));
                if (result) return result;
            }
        }
        const overlay = input.environmentBindings === undefined ? undefined : SecretReferenceOverlayV1Schema.parse(input.environmentBindings);
        const requirements = manifest?.environmentVariables ?? [];
        const secretRequirements = requirements.filter(requirement => requirement.kind === 'secret');
        const names = overlay ? listSecretReferenceOverlayV1BindingNames(overlay) : [];
        const captured = input.admittedTeardownEnvironment;
        if (captured) {
            const available = new Set(Object.keys(captured));
            if (input.purpose !== 'teardown' || available.size !== names.length || names.some(name => !available.has(name))
                || listMissingProjectSecretRequirements(secretRequirements, available).length) return refuse('project_environment_binding_unavailable');
        } else if ((overlay || secretRequirements.some(requirement => requirement.required)) && !input.secretEnvironment) {
            return refuse('project_environment_binding_unavailable');
        }
        // Validate real binding availability; only the final launch owner retains materialized values.
        if (!captured && (overlay || secretRequirements.length)) resolveProjectSecretReferenceEnvironment({
            ...(input.secretEnvironment ?? { accountSettings: {}, settingsSecretsReadKeys: [], savedSecretMaterializer: null }), requirements, ...(overlay ? { secretReferenceOverlay: overlay } : {}),
        });
        const bindings = overlay ? names.map(name => ({ name, ...readSecretReferenceOverlayV1Reference(overlay, name)! })) : [];
        const displayBindings: ProjectSetupReviewPresentation['bindings'][number][] = [];
        if (bindings.length > 0 && input.secretEnvironment) {
            // The exact-reference owner above admitted every binding before presentation.
            const materializer = input.secretEnvironment.savedSecretMaterializer!;
            for (const binding of bindings) {
                const description = materializer.describe(binding.ref);
                if (description.status !== 'ready') return refuse('project_environment_binding_unavailable');
                displayBindings.push({ ...binding, source: description.source, displayName: description.displayName });
            }
        }
        const declaredConfigNames = new Set(requirements.filter(requirement => requirement.kind === 'config').map(requirement => requirement.name));
        const configEnvironment = Object.freeze(Object.fromEntries(Object.entries(input.configEnvironment ?? {})
            .filter(([name]) => declaredConfigNames.has(name))));
        const originalEnvironment = input.originalEnvironment ?? process.env;
        const dotenvPreparation = input.dotenvPreparation ?? createProjectDotenvPreparation(root, originalEnvironment);
        const privateLaunch = await prepareProjectLaunchEnvironment({ workspace: input.workspace, requirements,
            originalEnvironment, dotenvPreparation,
            runtimeEnvironment: input.runtimeEnvironment, projectEnvironment: configEnvironment,
            profileEnvironment: input.profileEnvironment, invocationEnvironment: input.invocationEnvironment,
            platform: input.platform.os === 'windows' ? 'win32' : input.platform.os as NodeJS.Platform });
        if (privateLaunch.kind === 'refused') return refuse(privateLaunch.code);
        const privateConfigEnvironment = Object.fromEntries(requirements.filter(requirement => requirement.kind === 'config')
            .flatMap(requirement => privateLaunch.launchInput.environment[requirement.name] === undefined ? []
                : [[requirement.name, privateLaunch.launchInput.environment[requirement.name]]]));
        const reviewedToolchain = {
            selection: toolchain,
            // Files the environment loads beyond its config file (imported .nix, locks, hook-run and sourced scripts).
            ...(selectedToolchain.executedFiles ? { files: selectedToolchain.executedFiles } : {}),
            ...(toolchainAdapterVersion ? { adapterVersion: toolchainAdapterVersion } : {}),
            ...(toolchainTool ? { tool: {
                ...(reviewPath(root, toolchainTool.executablePath) !== toolchainTool.executablePath ? { executable: reviewPath(root, toolchainTool.executablePath) } : {}),
                ...(toolchainTool.version ? { version: toolchainTool.version } : {}),
            } } : {}),
        };
        // Capture only toolchain-owned current bytes before command definitions/setupInputs join the full consent effect.
        const executionEnvironmentEffectDigest = digest({ v: 1, toolchain: reviewedToolchain,
            files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, digest]) => ({ file, digest })),
            bindings, configEnvironment });
        const lifecycleCommands: Record<ProjectSetupPreparationInput['purpose'], PreparedProjectSetupCommand[]> = { setup: [], teardown: [] };
        const lifecycleReview: Record<ProjectSetupPreparationInput['purpose'], unknown[]> = { setup: [], teardown: [] };
        const autostart = Object.entries(includeSetupEffects ? manifest?.services ?? {} : {})
            .filter(([, service]) => service.runtime?.autostart === true)
            .map(([name, service]) => ({ name, commands: [] as PreparedProjectSetupCommand[], reviewedCommands: [] as unknown[], source: service.source }));
        // Human consent covers one lifecycle; only the requested phase is executed.
        const phases = [
            ...(includeSetupEffects ? (['setup', 'teardown'] as const).map(phase => ({ commands: lifecycleCommands[phase],
                reviewedCommands: lifecycleReview[phase], sources: manifest?.workspace?.[phase] ?? [], usage: 'setup' as const })) : []),
            ...autostart.map(service => ({ commands: service.commands, reviewedCommands: service.reviewedCommands,
                sources: [service.source], usage: 'service' as const })),
        ];
        for (const phase of phases) {
        const { commands, reviewedCommands } = phase;
        for (const source of phase.sources) {
            if (input.signal?.aborted) return refuse('project_setup_cancelled');
            if (source.kind === 'command') {
                if (source.platforms && !source.platforms.some(platform => platform === input.platform.os)) continue;
                const cwd = validatePath((source.cwd ?? '.').replaceAll('\\', '/'), root);
                if (!cwd.valid || !cwd.resolvedPath) return refuse('outside_root');
                if (source.command.includes('\0')) return refuse('project_setup_command_invalid');
                // The command text names the files it runs; their current bytes are the reviewed effect.
                const executed = await readLiteralCommandExecutedFiles(root, cwd.resolvedPath, source.command);
                if (executed.kind === 'refused') return refuse(executed.code);
                commands.push({ kind: 'literal', source, cwd: cwd.resolvedPath, inputFiles: executed.files });
                reviewedCommands.push({ kind: 'command', command: source.command, cwd: reviewPath(root, cwd.resolvedPath), os: input.platform.os,
                    ...(executed.files.length ? { files: executed.files } : {}) });
                continue;
            }
            const provenance = { ...source, file: relative(root, resolve(root, source.file.replaceAll('\\', '/'))).replaceAll('\\', '/') };
            if (source.kind === 'pluginNative') {
                if (!input.plugins) return refuse('native_adapter_unavailable');
                const selected = await input.plugins.resolveProjectNativeAdapter(source.adapter, 'resolveCommand');
                if (selected.kind === 'refused') return refuse(selected.code);
                const read = await readProjectDefinitionFile(root, provenance.file);
                if (read.kind === 'absent') return refuse('native_configuration_missing');
                if (read.kind === 'refused') return refuse(read.code);
                const fact = { file: provenance.file, content: read.content };
                const result = await addFile(fact.file, fact.content);
                if (result) return result;
                commands.push({ kind: 'pluginNativeReference', source, reviewInputs: [fact], lease: selected.lease });
                reviewedCommands.push({ source: provenance, adapterVersion: selected.lease.pluginVersion });
                continue;
            }
            const resolved = await inspectProjectNativeCommand({ root, source, usage: phase.usage, io: input.nativeIo,
                ...(input.signal ? { signal: input.signal } : {}) });
            if (resolved.kind === 'refused') return refuse(resolved.code);
            const native = resolved;
            const cwd = validatePath(native.cwd, root);
            if (!cwd.valid) return refuse('outside_root');
            for (const fact of native.reviewInputs) {
                const result = await addFile(fact.file, fact.content);
                if (result) return result;
            }
            if (source.kind === 'native' && resolved.kind === 'resolved') {
                const projectExecutable = reviewPath(root, resolved.command);
                if (projectExecutable !== resolved.command) {
                    const result = await addFile(relative(root, resolved.command));
                    if (result) return result;
                }
                commands.push({ kind: 'native', source, resolution: resolved, inputFiles: [
                    ...resolved.reviewInputs.map(fact => ({ file: fact.file, digest: hash(fact.content) })),
                    ...(resolved.executedFiles ?? []),
                    ...(projectExecutable !== resolved.command ? [{ file: relative(root, resolved.command).replaceAll('\\', '/'),
                        digest: files.get(relative(root, resolved.command).replaceAll('\\', '/'))! }] : []),
                ] });
                // Installed tool identity/version are provenance; its target-local installation path is not the effect.
                reviewedCommands.push({ source: provenance, ...(projectExecutable !== resolved.command ? { executable: projectExecutable } : {}), args: resolved.reviewInvocation.args.map(arg => reviewPath(root, arg)),
                    cwd: reviewPath(root, resolved.cwd), toolchain: resolved.toolchain,
                    ...(resolved.executedFiles ? { files: resolved.executedFiles } : {}),
                    ...(resolved.nativeCommandToolchain ? { nativeCommandToolchain: resolved.nativeCommandToolchain } : {}),
                    ...(resolved.reviewInvocation.environmentOverlay ? { environmentOverlay: Object.fromEntries(Object.entries(resolved.reviewInvocation.environmentOverlay).map(([key, value]) => [key, reviewPath(root, value)])) } : {}),
                });
            } else return refuse('native_adapter_result_invalid');
        }
        }
        const commands = lifecycleCommands[input.purpose];
        const reviewedCommands = lifecycleReview[input.purpose];
        const setupInputs: Array<Readonly<{ file: string; digest: string }>> = [];
        for (const file of includeSetupEffects ? manifest?.workspace?.setupInputs ?? [] : []) {
            const result = await addFile(file);
            if (result) return result;
            const normalized = relative(root, resolve(root, file.replaceAll('\\', '/'))).replaceAll('\\', '/');
            setupInputs.push({ file: normalized, digest: files.get(normalized)! });
        }
        if (input.signal?.aborted) return refuse('project_setup_cancelled');
        const semanticEffect = { v: 1 as const, purpose: input.purpose, commands: reviewedCommands, lifecycle: lifecycleReview, toolchain: reviewedToolchain,
            ...(autostart.length ? { autostart: autostart.map(service => ({ name: service.name, commands: service.reviewedCommands })) } : {}),
            files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, digest]) => ({ file, digest })), setupInputs, bindings, configEnvironment };
        const { purpose: _purpose, commands: _commands, ...lifecycleEffect } = semanticEffect;
        const reviewedEffectDigest = digest(lifecycleEffect);
        // SCM provenance is display context, excluded from the consent digest.
        // Native-launch checkpoints remeasure effect inputs, not repository UI.
        const provenanceStartedAt = performance.now();
        const provenance = await readReviewProvenance(input, root, snapshot.basis, presentation);
        logger.debug('[ProjectSetup] launch phase', { phase: 'review_provenance', retained: presentation !== undefined,
            durationMs: Math.round(performance.now() - provenanceStartedAt) });
        if (input.signal?.aborted) return refuse('project_setup_cancelled');
        if (toolchainAdapterLease && !toolchainAdapterLease.isCurrent()
            || phases.some(phase => phase.commands.some(command => (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent()))) return refuse('native_adapter_retired');
        const reviewedEffect: ProjectSetupReviewedEffect = { ...semanticEffect, presentation: { bindings: displayBindings, provenance } };
        const setupInputsDigest = digest(setupInputs);
        const successBasis = { cwd: root, platform: input.platform, reviewedEffectDigest, setupInputsDigest,
            environmentBindingReferences: bindings.map(binding => createCanonicalJsonSigningInput(binding)) };
        return { kind: 'reviewed', plan: { workspace: input.workspace, project: input.projectAssociation.project, purpose: input.purpose, manifest,
            fileBasis: snapshot.basis, commands, toolchain, toolchainReviewInputs,
            toolchainInputFiles: [...toolchainReviewInputs.map(fact => ({ file: fact.file, digest: hash(fact.content) })),
                ...(selectedToolchain.executedFiles ?? [])], ...(toolchainAdapterLease ? { toolchainAdapterLease } : {}),
            privateConfigEnvironment, preparedLaunchInput: privateLaunch.launchInput, dotenvPreparation,
            ...(input.runtimeEnvironment ? { runtimeEnvironment: input.runtimeEnvironment } : {}),
            configEnvironment: Object.freeze(configEnvironment), executionEnvironmentEffectDigest, reviewedEffect, reviewedEffectDigest, successBasis } };
    } catch (error) {
        preserveUnconfirmedNativeProcess(error);
        if (error instanceof LaunchSecretReferenceOverlayError) return refuse('project_environment_binding_unavailable');
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') return refuse(error.code);
        return refuse('project_setup_effect_unavailable');
    }
}

/** Passive target readiness, inside the admitted requester's review/native lifetime. Trust is separate. */
export async function inspectProjectSetupReadiness(input: ProjectSetupPreparationInput): Promise<ProjectSetupReadinessV1> {
    return (await inspectProjectSetup(input)).setupReadiness;
}

export type ProjectSetupInspection = Readonly<{ setupReadiness: ProjectSetupReadinessV1; setupReview?: ProjectSetupReviewV1;
    setupConsent?: ProjectDefinitionInspectOutput['setupConsent'] }>;

/** One passive review supplies readiness and approval facts without producing native effects. */
export async function inspectProjectSetup(input: ProjectSetupPreparationInput, options?: Readonly<{ reviewConsent: true }>): Promise<ProjectSetupInspection> {
    if (input.purpose !== 'setup') return { setupReadiness: { kind: 'unknown', code: 'project_setup_review_unavailable' } };
    const reviewed = await reviewProjectSetupEffect(input);
    if (reviewed.kind === 'refused') return { setupReadiness: { kind: 'needsReview', code: reviewed.code } };
    // reviewedEffect is the canonical non-secret effect, not the private executable plan.
    const setupReview = ProjectSetupReviewV1Schema.parse({ reviewedEffect: projectNativeJsonValueForTransport(reviewed.plan.reviewedEffect),
        reviewedEffectDigest: reviewed.plan.reviewedEffectDigest });
    if (!options?.reviewConsent) return { setupReview, setupReadiness: await readReviewedProjectSetupReadiness(input, reviewed.plan) };
    const admission = await admitReviewedProjectSetup(input, reviewed.plan);
    const setupConsent: ProjectDefinitionInspectOutput['setupConsent'] = admission.kind === 'pendingApproval'
        ? { kind: 'required', code: admission.code }
        : admission.kind === 'refused' ? { kind: 'unavailable', code: admission.code } : { kind: 'admitted' };
    return { setupReview, setupConsent, setupReadiness: await readReviewedProjectSetupReadiness(input, reviewed.plan) };
}

/** Setup admits the whole lifecycle; cleanup only admits effects it will execute. */
function hasProjectSetupAdmissionEffect(plan: PreparedProjectSetupPlan): boolean {
    if (plan.toolchain.kind !== 'host') return true;
    if (plan.purpose === 'teardown') return plan.commands.length > 0;
    return plan.reviewedEffect.lifecycle.setup.length > 0
        || plan.reviewedEffect.lifecycle.teardown.length > 0
        || (plan.reviewedEffect.autostart?.some(service => service.commands.length > 0) ?? false);
}

async function readReviewedProjectSetupReadiness(input: ProjectSetupPreparationInput, plan: PreparedProjectSetupPlan): Promise<ProjectSetupReadinessV1> {
    if (plan.commands.some(command => command.kind === 'pluginNativeReference')) {
        return { kind: 'unknown', code: 'native_setup_readiness_unresolved' };
    }
    if (!hasProjectSetupAdmissionEffect(plan)) {
        return { kind: 'notRequired', reviewedEffectDigest: plan.reviewedEffectDigest };
    }
    if (!input.successHomeDir) return { kind: 'unknown', code: 'project_setup_success_unavailable' };
    try {
        const success = await createProjectSetupSuccessStore({ homeDir: input.successHomeDir }).readMatching({
            serverId: plan.workspace.serverId, machineId: plan.workspace.machineId, workspaceRefId: plan.workspace.id,
        }, plan.successBasis);
        if (input.signal?.aborted) return { kind: 'unknown', code: 'project_setup_cancelled' };
        if (plan.toolchainAdapterLease && !plan.toolchainAdapterLease.isCurrent()
            || plan.commands.some(command => (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent())) {
            return { kind: 'needsReview', code: 'native_adapter_retired' };
        }
        return success?.completedAtMs !== undefined ? { kind: 'current', reviewedEffectDigest: plan.reviewedEffectDigest, completedAtMs: success.completedAtMs }
            : { kind: 'unprepared', reviewedEffectDigest: plan.reviewedEffectDigest };
    } catch {
        return { kind: 'unknown', code: 'project_setup_success_unavailable' };
    }
}

/** Shared requester-bound settings input for Project setup and service-effect review. */
export function readProjectActionApprovalSettings(input: Pick<ProjectSetupPreparationInput, 'approvalContext' | 'requester' | 'secretEnvironment'>): ActionsSettingsV1 {
    const requester = readRequesterAccountActionContext(input.requester.authorization);
    return input.approvalContext?.actionsSettings ?? (requester
        ? normalizeActionsSettingsV1(requester.accountSettingsContext.settings.actionsSettingsV1)
        : input.secretEnvironment
            ? normalizeActionsSettingsV1(input.secretEnvironment.accountSettings.actionsSettingsV1)
            : input.requester.credentials
                ? createActionSettingsProvider({ scopeKey: resolveAccountSettingsScopeKey(input.requester.credentials) }).getActionsSettings()
                : normalizeActionsSettingsV1(undefined));
}

/** Produces an execution plan and consent facts. It never launches or records completion. */
export async function prepareProjectSetup(input: ProjectSetupPreparationInput & Readonly<{ expectedEffectDigest?: string; skipForInvocation?: boolean }>,
    presentation?: Pick<ProjectSetupReviewPresentation, 'provenance'>,
    admittedConsent?: Extract<ProjectSetupPreparationOutcome, { kind: 'prepared' }>['consent']): Promise<ProjectSetupPreparationOutcome> {
    const startedAt = performance.now();
    // Admission needs effect bytes, not repository display. Passive inspection
    // publishes provenance independently when ready; a consent hold still gets
    // the same full presentation before it is returned to its reviewer.
    const reviewed = await reviewProjectSetupEffect(input, presentation ?? {
        provenance: { kind: 'unavailable', file: '.happier/project.json', fileState: 'unknown' },
    });
    logger.debug('[ProjectSetup] launch phase', { phase: 'effect_review', durationMs: Math.round(performance.now() - startedAt) });
    if (reviewed.kind === 'refused') return reviewed;
    const admissionStartedAt = performance.now();
    const result = await admitReviewedProjectSetup(input, reviewed.plan, admittedConsent);
    logger.debug('[ProjectSetup] launch phase', { phase: 'consent_admission', durationMs: Math.round(performance.now() - admissionStartedAt) });
    if (result.kind === 'pendingApproval' && presentation === undefined) {
        const plan = result.plan;
        const provenance = await readReviewProvenance(input, resolve(plan.workspace.rootPath), plan.fileBasis);
        return { ...result, plan: { ...plan, reviewedEffect: { ...plan.reviewedEffect,
            presentation: { ...plan.reviewedEffect.presentation, provenance } } } };
    }
    return result;
}

/** Admit consent and compare target-local completion once per finite run. */
export async function admitReviewedProjectSetup(input: ProjectSetupPreparationInput & Readonly<{ expectedEffectDigest?: string; skipForInvocation?: boolean }>,
    plan: PreparedProjectSetupPlan,
    admittedConsent?: Extract<ProjectSetupPreparationOutcome, { kind: 'prepared' }>['consent']): Promise<ProjectSetupPreparationOutcome> {
    if (input.expectedEffectDigest !== undefined && input.expectedEffectDigest !== plan.reviewedEffectDigest) {
        return { kind: 'pendingApproval', code: 'project_setup_effect_changed', plan };
    }
    const root = readHostAdmittedReviewedRootV1(input.approvalContext);
    const move = root?.actionId === 'projects.service.relocate' ? ProjectServiceRelocateInputV1Schema.safeParse(root.input) : null;
    const moveReview = move?.success && move.data.workspace.serverId === plan.project.serverId ? move.data.setupReview : undefined;
    // The compound Action admitted projects.prepare policy in its single review.
    // Only the private admitted root carries that decision; a public parent projection does not.
    // Destination-native resolution (including platform, tools and environment) must still match.
    if (moveReview && moveReview.reviewedEffectDigest !== plan.reviewedEffectDigest) {
        return { kind: 'pendingApproval', code: 'project_setup_effect_changed', plan };
    }
    if (input.skipForInvocation) return { kind: 'skippedForInvocation', plan };
    if (!hasProjectSetupAdmissionEffect(plan)) return { kind: 'notRequired', plan };
    try {
        const matchingCheckpoint = input.purpose === 'setup' && input.successHomeDir !== undefined
            ? await createProjectSetupSuccessStore({ homeDir: input.successHomeDir }).readMatching({
                serverId: plan.workspace.serverId, machineId: plan.workspace.machineId, workspaceRefId: plan.workspace.id,
            }, plan.successBasis) : null;
        // An earlier successful Run never satisfies a new explicit Setup. Keep an exact
        // partial checkpoint for Retry and accept completion while a Run was waiting.
        const checkpoint = matchingCheckpoint?.completedAtMs !== undefined && input.setupRequestedAtMs !== undefined
            && matchingCheckpoint.completedAtMs <= input.setupRequestedAtMs ? null : matchingCheckpoint;
        const previousSuccess = checkpoint?.completedAtMs !== undefined;
        const confirmedCommandCount = checkpoint?.confirmedCommandCount !== undefined
            && checkpoint.confirmedCommandCount <= plan.commands.length ? checkpoint.confirmedCommandCount : 0;
        let consent: 'trusted' | 'thisTime' | 'completed';
        if (admittedConsent !== undefined) {
            consent = admittedConsent;
        } else if (input.effectDecision !== undefined) {
            const decision = input.effectDecision;
            const project = QualifiedProjectTrustProjectV1Schema.safeParse(decision.project);
            if (!project.success || project.data.serverId !== plan.project.serverId || project.data.projectId !== plan.project.projectId) return refuse('project_setup_consent_invalid');
            if (decision.reviewedEffectDigest !== plan.reviewedEffectDigest) return { kind: 'pendingApproval', code: 'project_setup_effect_changed', plan };
            consent = 'thisTime';
        } else if (moveReview) {
            consent = 'thisTime';
        } else if (previousSuccess) {
            // Exact target completion skips setup effects; it is not a remembered
            // grant to run them again or on another target. This also releases a
            // Script held while a separately reviewed This time setup completed.
            consent = 'completed';
        } else {
            const settings = readProjectActionApprovalSettings(input);
            if (!input.requireRememberedConsent && !isApprovalRequiredByActionsSettings('projects.prepare', settings, input.approvalContext)) {
                // The person's policy permits this invocation; it does not write a
                // Project trust grant or turn an agent into an approving user.
                consent = 'thisTime';
            } else {
                const remembered = input.checkoutTeardownConsent
                    ? await input.checkoutTeardownConsent(plan.reviewedEffectDigest)
                    : await createProjectSetupTrustClient(input.requester).resolveConsent(plan.project, plan.reviewedEffectDigest);
                if (remembered.kind === 'pendingApproval') return { kind: 'pendingApproval', code: remembered.code, plan };
                consent = 'trusted';
            }
        }
        if (input.signal?.aborted) return refuse('project_setup_cancelled');
        if (plan.toolchainAdapterLease && !plan.toolchainAdapterLease.isCurrent()
            || plan.commands.some(command => (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent())) return refuse('native_adapter_retired');
        return { kind: 'prepared', plan, consent, previousSuccess, confirmedCommandCount };
    } catch (error) {
        preserveUnconfirmedNativeProcess(error);
        return refuse(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_setup_admission_unavailable');
    }
}
