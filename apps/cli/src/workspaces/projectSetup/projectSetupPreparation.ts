import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { WorkspaceRefV1Schema, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectCommandSourceV1, ProjectEnvironmentSelectionV1, ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { ProjectManifestFileSnapshot } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { QualifiedProjectTrustProjectV1Schema, type QualifiedProjectTrustProjectV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import type { ProjectSetupSuccessV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectSetupSuccessV1';
import type { ProjectSetupReadinessV1 } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { SecretReferenceOverlayV1Schema, listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference, type SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';

import { LaunchSecretReferenceOverlayError, resolveProjectSecretReferenceEnvironment, type ProjectSecretReferenceEnvironmentInput } from '@/settings/secrets/secretReferenceOverlay';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import type { ScmStatusSnapshotResponse } from '@happier-dev/protocol/scm';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { createNonRepositoryScmSnapshotResponse, runScmRoute } from '@/scm/rpc/dispatch';
import { preserveUnconfirmedNativeProcess, type ProjectNativeAdapterLeaseV1, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { resolveProjectEnvironmentSelection, inspectProjectNativeCommand, type ProjectNativeCommandIo, type ProjectNativeCommandResult, type ProjectNativeFileFact } from './projectNativeResolution';
import { readProjectManifest } from './projectManifestFile';
import { readWorkspaceSyncChildMachineFacts } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { isManagedDevcontainerChildProjectionCurrentV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { readProjectDefinitionFile, readProjectDefinitionFileBytes } from './nativeDefinitionFiles';
import { createProjectSetupTrustClient, type ProjectSetupTrustClientInput } from './projectSetupTrust';
import { createProjectSetupSuccessStore } from './projectSetupSuccess';

export type PreparedProjectSetupCommand = Readonly<
    { kind: 'literal'; source: Extract<ProjectCommandSourceV1, { kind: 'command' }>; cwd: string }
    | { kind: 'native'; source: Extract<ProjectCommandSourceV1, { kind: 'native' }>; resolution: Extract<ProjectNativeCommandResult, { kind: 'resolved' }> }
    | { kind: 'pluginNative'; source: Extract<ProjectCommandSourceV1, { kind: 'pluginNative' }>; resolution: Extract<ProjectNativeCommandResult, { kind: 'pluginResolved' }>['command']; lease: ProjectNativeAdapterProductionV1 }
    | { kind: 'pluginNativeReference'; source: Extract<ProjectCommandSourceV1, { kind: 'pluginNative' }>; reviewInputs: readonly ProjectNativeFileFact[]; lease: ProjectNativeAdapterLeaseV1 }
>;

export type ProjectSetupPreparationInput = Readonly<{
    workspace: WorkspaceRefV1;
    /** Resolved by the accepted Workspace/Project row owner, never from Action input. */
    projectAssociation: Readonly<{ workspace: WorkspaceRefV1; project: QualifiedProjectTrustProjectV1 }>;
    requester: ProjectSetupTrustClientInput;
    purpose: 'setup' | 'teardown';
    platform: Readonly<{ os: string; arch: string }>;
    nativeIo: ProjectNativeCommandIo;
    environmentBindings?: SecretReferenceOverlayV1;
    secretEnvironment?: Omit<ProjectSecretReferenceEnvironmentInput, 'requirements' | 'secretReferenceOverlay'>;
    configEnvironment?: Readonly<Record<string, string>>;
    /** Host SCM catalog port; never a caller-provided repository or commit claim. */
    scmRegistry?: ScmBackendRegistry;
    plugins?: Pick<ResolvedExecutablePluginRuntimeRegistry, 'resolveProjectNativeAdapter'>;
    /** The containing accepted operation owns these invocations through actual settlement. */
    retainNativeInvocation?: (production: import('@/plugins/runtime/invocation/services/exec').ProjectNativeEffectCaptureForHost) => void;
    successHomeDir?: string;
    /** Supplied only by the admitted host human-review producer, never Action params or custodian credentials. */
    effectDecision?: Readonly<{ authority: 'present_user'; project: QualifiedProjectTrustProjectV1; reviewedEffectDigest: string }>;
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
    }>;
}>;

export type ProjectSetupReviewedEffect = Readonly<{
    v: 1;
    purpose: 'setup' | 'teardown';
    commands: readonly unknown[];
    environment: Readonly<{ selection: ProjectEnvironmentSelectionV1; adapterVersion?: string; tool?: Readonly<{ executable?: string; version?: string }> }>;
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
    environment: ProjectEnvironmentSelectionV1;
    environmentAdapterLease?: ProjectNativeAdapterLeaseV1;
    /** Host-private config facts consumed by the same selected adapter at final production. */
    environmentReviewInputs: readonly ProjectNativeFileFact[];
    configEnvironment: Readonly<Record<string, string>>;
    /** Host-private execution baseline; excludes setup/teardown commands and explicit setupInputs. */
    executionEnvironmentEffectDigest: string;
    reviewedEffect: ProjectSetupReviewedEffect;
    reviewedEffectDigest: string;
    setupInputsDigest: string;
    successBasis: Omit<ProjectSetupSuccessV1, 'v' | 'workspaceRefId' | 'completedAtMs'>;
}>;

export type ProjectSetupPreparationRefusal = Readonly<{ kind: 'refused'; code: string }>;
export type ProjectSetupPreparationOutcome = ProjectSetupPreparationRefusal
    | Readonly<{ kind: 'notRequired'; plan: PreparedProjectSetupPlan }>
    | Readonly<{ kind: 'skippedForInvocation'; plan: PreparedProjectSetupPlan }>
    | Readonly<{ kind: 'pendingApproval'; code: 'project_setup_consent_required' | 'project_setup_effect_changed'; plan: PreparedProjectSetupPlan }>
    | Readonly<{ kind: 'prepared'; plan: PreparedProjectSetupPlan; consent: 'trusted' | 'thisTime'; previousSuccess: boolean }>;

const refuse = (code: string): ProjectSetupPreparationRefusal => ({ kind: 'refused', code });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(createCanonicalJsonSigningInput(value));

/** The declared non-secret bindings, shared by passive admission and effect review. */
export function resolveProjectSetupConfigEnvironment(manifest: ProjectManifestV1 | null,
    values: ProjectSetupPreparationInput['configEnvironment']): ProjectSetupPreparationRefusal | Readonly<{ kind: 'ready'; environment: Readonly<Record<string, string>> }> {
    const environment: Record<string, string> = Object.create(null);
    for (const requirement of manifest?.environmentVariables?.filter(requirement => requirement.kind === 'config') ?? []) {
        const value = values?.[requirement.name];
        if (requirement.required && (value === undefined || value === '') || value?.includes('\0')) return refuse('project_environment_binding_unavailable');
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

async function readReviewProvenance(input: ProjectSetupPreparationInput, root: string, manifestPresent: boolean): Promise<ProjectSetupReviewPresentation['provenance']> {
    const base = { file: '.happier/project.json' as const, fileState: manifestPresent ? 'unknown' as const : 'absent' as const };
    try {
        return await runWithScmBackendRegistryLease(input.scmRegistry, async (registry): Promise<ProjectSetupReviewPresentation['provenance']> => {
            // No installed detector has observed the path; absence of a catalog is not non-repository evidence.
            if (registry.listBackends().length === 0) return { ...base, kind: 'unavailable' };
            const response = await runScmRoute<{ cwd: string }, ScmStatusSnapshotResponse>({
                request: { cwd: root }, workingDirectory: root, registry, signal: input.signal,
                onNonRepository: ({ cwd, workingDirectory }) => createNonRepositoryScmSnapshotResponse({ cwd, workingDirectory }),
                runWithBackend: ({ context, selection }) => selection.backend.statusSnapshot({ context, request: { cwd: root } }),
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
                // A clean status alone cannot distinguish tracked from ignored bytes; never call it committed.
                fileState: !manifestPresent ? 'absent' : entry ? entry.kind === 'untracked' ? 'untracked' : 'modified' : 'unknown',
            };
        });
    } catch {
        return { ...base, kind: 'unavailable' };
    }
}

/** Current-byte review with registered read-only SCM metadata; no environment evaluation, native effects, installation or grant. */
export async function reviewProjectSetupEffect(input: ProjectSetupPreparationInput): Promise<ProjectSetupPreparationRefusal | Readonly<{ kind: 'reviewed'; plan: PreparedProjectSetupPlan }>> {
    if (!associationMatches(input)) return refuse('project_workspace_association_mismatch');
    if (input.signal?.aborted) return refuse('project_setup_cancelled');
    const root = resolve(input.workspace.rootPath);
    try {
        const snapshot = await readProjectManifest({ root });
        if (snapshot.document?.status === 'invalid') return refuse('invalid_manifest');
        const manifest = snapshot.document?.manifest ?? null;
        // A selected child is realized/accepted by its owner before child-local preparation.
        if (manifest?.devcontainer) {
            const children = await readWorkspaceSyncChildMachineFacts({ serverId: input.workspace.serverId,
                purpose: 'child_namespace',
                ...input.requester, credentials: input.requester.credentials, machineIds: [input.workspace.machineId], signal: input.signal });
            const child = children[0];
            if (children.length !== 1 || !child || !isManagedDevcontainerChildProjectionCurrentV1({ homeId: input.workspace.serverId,
                machineId: input.workspace.machineId, projection: child.projection, managedMachine: child.managedMachine })
                || resolveWorkspaceRefV1([input.workspace], { serverId: input.workspace.serverId,
                    machineId: input.workspace.machineId, rootPath: child.projection.observation.workspaceFolder }).kind !== 'resolved') return refuse('child_required');
        }
        const environmentSelection = manifest?.environment ?? { kind: 'host' as const };
        const selectedEnvironment = await resolveProjectEnvironmentSelection({ root, selection: environmentSelection });
        if (selectedEnvironment.kind === 'refused') return refuse(selectedEnvironment.code);
        if (selectedEnvironment.coverage === 'partial') return refuse('native_environment_dynamic_unsupported');
        const environment = selectedEnvironment.selection;
        const environmentReviewInputs: ProjectNativeFileFact[] = selectedEnvironment.file !== undefined && selectedEnvironment.content !== undefined
            ? [{ file: selectedEnvironment.file, content: selectedEnvironment.content }] : [];
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
        if (selectedEnvironment.file !== undefined) {
            const result = await addFile(selectedEnvironment.file, selectedEnvironment.content);
            if (result) return result;
        }
        let environmentAdapterLease: ProjectNativeAdapterLeaseV1 | undefined;
        let environmentAdapterVersion: string | undefined;
        let environmentTool: Readonly<{ executablePath: string; version?: string }> | undefined;
        if (environment.kind === 'pluginToolchain') {
            if (!input.plugins) return refuse('native_adapter_unavailable');
            const selected = await input.plugins.resolveProjectNativeAdapter(environment.adapter, 'produceEnvironment');
            if (selected.kind === 'refused') return refuse(selected.code);
            environmentAdapterLease = selected.lease;
            environmentAdapterVersion = selected.lease.pluginVersion;
        } else if (environment.kind === 'toolchain') {
            environmentTool = await input.nativeIo.resolveTool(environment.tool === 'nix_flake' ? 'nix' : environment.tool, {
                cwd: root, ...(input.signal ? { signal: input.signal } : {}),
            }) ?? undefined;
            if (!environmentTool) return refuse('native_tool_unavailable');
            if (!isAbsolute(environmentTool.executablePath) || environmentTool.executablePath.includes('\0')) return refuse('native_tool_invalid');
            if (reviewPath(root, environmentTool.executablePath) !== environmentTool.executablePath) {
                const result = await addFile(relative(root, environmentTool.executablePath));
                if (result) return result;
            }
        }
        const overlay = input.environmentBindings === undefined ? undefined : SecretReferenceOverlayV1Schema.parse(input.environmentBindings);
        const requirements = manifest?.environmentVariables ?? [];
        const secretRequirements = requirements.filter(requirement => requirement.kind === 'secret');
        if ((overlay || secretRequirements.some(requirement => requirement.required)) && !input.secretEnvironment) return refuse('project_environment_binding_unavailable');
        // Validate real binding availability; only the final launch owner retains materialized values.
        if (overlay || secretRequirements.length) resolveProjectSecretReferenceEnvironment({
            ...(input.secretEnvironment ?? { accountSettings: {}, settingsSecretsReadKeys: [] }), requirements, ...(overlay ? { secretReferenceOverlay: overlay } : {}),
        });
        const bindings = overlay ? listSecretReferenceOverlayV1BindingNames(overlay).map(name => ({ name, ...readSecretReferenceOverlayV1Reference(overlay, name)! })) : [];
        const displayBindings: ProjectSetupReviewPresentation['bindings'][number][] = [];
        if (bindings.length > 0 && input.secretEnvironment) {
            const materializer = createSavedSecretMaterializerV1({
                accountSettings: input.secretEnvironment.accountSettings,
                settingsSecretsReadKeys: input.secretEnvironment.settingsSecretsReadKeys,
                resources: input.secretEnvironment.savedSecretResources,
            });
            for (const binding of bindings) {
                const description = materializer.describe(binding.ref);
                if (description.status !== 'ready') return refuse('project_environment_binding_unavailable');
                displayBindings.push({ ...binding, source: description.source, displayName: description.displayName });
            }
        }
        const config = resolveProjectSetupConfigEnvironment(manifest, input.configEnvironment);
        if (config.kind === 'refused') return config;
        const configEnvironment = config.environment;
        const reviewedEnvironment = {
            selection: environment,
            ...(environmentAdapterVersion ? { adapterVersion: environmentAdapterVersion } : {}),
            ...(environmentTool ? { tool: {
                ...(reviewPath(root, environmentTool.executablePath) !== environmentTool.executablePath ? { executable: reviewPath(root, environmentTool.executablePath) } : {}),
                ...(environmentTool.version ? { version: environmentTool.version } : {}),
            } } : {}),
        };
        // Capture only environment-owned current bytes before command definitions/setupInputs join the full consent effect.
        const executionEnvironmentEffectDigest = digest({ v: 1, environment: reviewedEnvironment,
            files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, digest]) => ({ file, digest })),
            bindings, configEnvironment });
        const commands: PreparedProjectSetupCommand[] = [];
        const reviewedCommands: unknown[] = [];
        for (const source of manifest?.workspace?.[input.purpose] ?? []) {
            if (input.signal?.aborted) return refuse('project_setup_cancelled');
            if (source.kind === 'command') {
                if (source.platforms && !source.platforms.some(platform => platform === input.platform.os)) continue;
                const cwd = validatePath((source.cwd ?? '.').replaceAll('\\', '/'), root);
                if (!cwd.valid || !cwd.resolvedPath) return refuse('outside_root');
                if (source.command.includes('\0')) return refuse('project_setup_command_invalid');
                commands.push({ kind: 'literal', source, cwd: cwd.resolvedPath });
                reviewedCommands.push({ kind: 'command', command: source.command, cwd: reviewPath(root, cwd.resolvedPath), os: input.platform.os });
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
            const resolved = await inspectProjectNativeCommand({ root, source, usage: 'setup', io: input.nativeIo,
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
                commands.push({ kind: 'native', source, resolution: resolved });
                // Installed tool identity/version are provenance; its target-local installation path is not the effect.
                reviewedCommands.push({ source: provenance, ...(projectExecutable !== resolved.command ? { executable: projectExecutable } : {}), args: resolved.reviewInvocation.args.map(arg => reviewPath(root, arg)),
                    cwd: reviewPath(root, resolved.cwd), toolchain: resolved.toolchain,
                    ...(resolved.nativeCommandEnvironment ? { nativeCommandEnvironment: resolved.nativeCommandEnvironment } : {}),
                    ...(resolved.reviewInvocation.environmentOverlay ? { environmentOverlay: Object.fromEntries(Object.entries(resolved.reviewInvocation.environmentOverlay).map(([key, value]) => [key, reviewPath(root, value)])) } : {}),
                });
            } else return refuse('native_adapter_result_invalid');
        }
        const setupInputs: Array<Readonly<{ file: string; digest: string }>> = [];
        for (const file of manifest?.workspace?.setupInputs ?? []) {
            const result = await addFile(file);
            if (result) return result;
            const normalized = relative(root, resolve(root, file.replaceAll('\\', '/'))).replaceAll('\\', '/');
            setupInputs.push({ file: normalized, digest: files.get(normalized)! });
        }
        if (input.signal?.aborted) return refuse('project_setup_cancelled');
        const semanticEffect = { v: 1 as const, purpose: input.purpose, commands: reviewedCommands, environment: reviewedEnvironment,
            files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, digest]) => ({ file, digest })), setupInputs, bindings, configEnvironment };
        const reviewedEffectDigest = digest(semanticEffect);
        const provenance = await readReviewProvenance(input, root, manifest !== null);
        if (input.signal?.aborted) return refuse('project_setup_cancelled');
        if (environmentAdapterLease && !environmentAdapterLease.isCurrent()
            || commands.some(command => (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent())) return refuse('native_adapter_retired');
        const reviewedEffect: ProjectSetupReviewedEffect = { ...semanticEffect, presentation: { bindings: displayBindings, provenance } };
        const setupInputsDigest = digest(setupInputs);
        const successBasis = { cwd: root, platform: input.platform, reviewedEffectDigest, setupInputsDigest,
            environmentBindingReferences: bindings.map(binding => createCanonicalJsonSigningInput(binding)) };
        return { kind: 'reviewed', plan: { workspace: input.workspace, project: input.projectAssociation.project, purpose: input.purpose, manifest,
            fileBasis: snapshot.basis, commands, environment, environmentReviewInputs, ...(environmentAdapterLease ? { environmentAdapterLease } : {}),
            configEnvironment: Object.freeze(configEnvironment), executionEnvironmentEffectDigest, reviewedEffect, reviewedEffectDigest, setupInputsDigest, successBasis } };
    } catch (error) {
        preserveUnconfirmedNativeProcess(error);
        if (error instanceof LaunchSecretReferenceOverlayError) return refuse('project_environment_binding_unavailable');
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') return refuse(error.code);
        return refuse('project_setup_effect_unavailable');
    }
}

/** Passive target readiness, inside the admitted requester's review/native lifetime. Trust is separate. */
export async function inspectProjectSetupReadiness(input: ProjectSetupPreparationInput): Promise<ProjectSetupReadinessV1> {
    if (input.purpose !== 'setup') return { kind: 'unknown', code: 'project_setup_review_unavailable' };
    const reviewed = await reviewProjectSetupEffect(input);
    if (reviewed.kind === 'refused') return { kind: 'needsReview', code: reviewed.code };
    const plan = reviewed.plan;
    if (plan.commands.some(command => command.kind === 'pluginNativeReference')) {
        return { kind: 'unknown', code: 'native_setup_readiness_unresolved' };
    }
    if (plan.commands.length === 0 && plan.environment.kind === 'host') {
        return { kind: 'notRequired', reviewedEffectDigest: plan.reviewedEffectDigest };
    }
    if (!input.successHomeDir) return { kind: 'unknown', code: 'project_setup_success_unavailable' };
    try {
        const success = await createProjectSetupSuccessStore({ homeDir: input.successHomeDir }).readMatching({
            serverId: plan.workspace.serverId, machineId: plan.workspace.machineId, workspaceRefId: plan.workspace.id,
        }, plan.successBasis);
        if (input.signal?.aborted) return { kind: 'unknown', code: 'project_setup_cancelled' };
        if (plan.environmentAdapterLease && !plan.environmentAdapterLease.isCurrent()
            || plan.commands.some(command => (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent())) {
            return { kind: 'needsReview', code: 'native_adapter_retired' };
        }
        return success ? { kind: 'current', reviewedEffectDigest: plan.reviewedEffectDigest, completedAtMs: success.completedAtMs }
            : { kind: 'unprepared', reviewedEffectDigest: plan.reviewedEffectDigest };
    } catch {
        return { kind: 'unknown', code: 'project_setup_success_unavailable' };
    }
}

/** Produces an execution plan and consent facts. It never launches or records completion. */
export async function prepareProjectSetup(input: ProjectSetupPreparationInput & Readonly<{ expectedEffectDigest?: string; skipForInvocation?: boolean }>): Promise<ProjectSetupPreparationOutcome> {
    const reviewed = await reviewProjectSetupEffect(input);
    if (reviewed.kind === 'refused') return reviewed;
    const plan = reviewed.plan;
    if (input.expectedEffectDigest !== undefined && input.expectedEffectDigest !== plan.reviewedEffectDigest) {
        return { kind: 'pendingApproval', code: 'project_setup_effect_changed', plan };
    }
    if (input.skipForInvocation) return { kind: 'skippedForInvocation', plan };
    if (plan.commands.length === 0 && plan.environment.kind === 'host') return { kind: 'notRequired', plan };
    try {
        let consent: 'trusted' | 'thisTime';
        if (input.effectDecision !== undefined) {
            const decision = input.effectDecision;
            if (decision.authority !== 'present_user') return { kind: 'pendingApproval', code: 'project_setup_consent_required', plan };
            const project = QualifiedProjectTrustProjectV1Schema.safeParse(decision.project);
            if (!project.success || project.data.serverId !== plan.project.serverId || project.data.projectId !== plan.project.projectId) return refuse('project_setup_consent_invalid');
            if (decision.reviewedEffectDigest !== plan.reviewedEffectDigest) return { kind: 'pendingApproval', code: 'project_setup_effect_changed', plan };
            consent = 'thisTime';
        } else {
            const remembered = await createProjectSetupTrustClient(input.requester).resolveConsent(plan.project, plan.reviewedEffectDigest);
            if (remembered.kind === 'pendingApproval') return { kind: 'pendingApproval', code: remembered.code, plan };
            consent = 'trusted';
        }
        const previousSuccess = input.purpose === 'setup' && input.successHomeDir !== undefined
            ? await createProjectSetupSuccessStore({ homeDir: input.successHomeDir }).matches({
                serverId: plan.workspace.serverId, machineId: plan.workspace.machineId, workspaceRefId: plan.workspace.id,
            }, plan.successBasis) : false;
        if (input.signal?.aborted) return refuse('project_setup_cancelled');
        if (plan.environmentAdapterLease && !plan.environmentAdapterLease.isCurrent()
            || plan.commands.some(command => (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent())) return refuse('native_adapter_retired');
        return { kind: 'prepared', plan, consent, previousSuccess };
    } catch (error) {
        preserveUnconfirmedNativeProcess(error);
        return refuse(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_setup_admission_unavailable');
    }
}
