import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { configuration } from '@/configuration';
import { prepareProjectSetup, readProjectSetupNamespaceRefusal, type ProjectSetupPreparationInput, type ProjectSetupPreparationOutcome, type ProjectSetupReviewPresentation } from './projectSetupPreparation';
import { resolveProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';
import { projectNativeSystemIo } from './projectNativeSystemIo';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';
import { resolveProjectRequesterSecretBindings } from './projectSetupRequesterInputs';
import { SavedSecretOperationAdmissionError } from '@/settings/secrets/savedSecretCatalogRead';
import { performance } from 'node:perf_hooks';
import { logger } from '@/utils/logger';

export type ProjectAgentLaunchPreparationInput = Readonly<{
    /** Content-free observation for the containing native-launch diagnostic. */
    onPhase?(phase: 'association' | 'secret_inputs' | 'manifest' | 'setup_preparation'): void;
    cwd: string;
    machineId: string;
    serverId: string;
    serverHttpBaseUrl: string;
    account: ProjectAccountRowsInput;
    requesterIdentity?: ProjectSetupPreparationInput['requesterIdentity'];
    workspaceId?: string;
    nativeIo?: ProjectSetupPreparationInput['nativeIo'];
    plugins?: ProjectSetupPreparationInput['plugins'];
    secretEnvironment?: ProjectSetupPreparationInput['secretEnvironment'];
    /** Available exact Profile/launch refs; only declared Project secret names are consumed. */
    environmentBindings?: ProjectSetupPreparationInput['environmentBindings'];
    /** Bound Account/Profile owner, demanded only after an accepted Project is found. */
    resolveSecretInputs?: (projectBindings?: ProjectSetupPreparationInput['environmentBindings']) => Promise<Readonly<Pick<ProjectAgentLaunchPreparationInput, 'secretEnvironment' | 'environmentBindings'>>>;
    configEnvironment?: ProjectSetupPreparationInput['configEnvironment'];
    withProjectWorkspaceSource?: <T>(workspace: WorkspaceRefV1, read: () => Promise<T>) => Promise<T>;
    /** One native invocation shares its private selected file family across review and launch. */
    readDotenvPreparation?: (workspace: WorkspaceRefV1) => NonNullable<ProjectSetupPreparationInput['dotenvPreparation']>;
    originalEnvironment?: ProjectSetupPreparationInput['originalEnvironment'];
    /** Active native preparation supplies B's placed-worktree defaults before value validation. */
    readRuntimeEnvironment?: (workspace: WorkspaceRefV1,
        manifest: import('@happier-dev/protocol/workspaces/projectSetup/projectManifestV1').ProjectManifestV1 | null) => Promise<Readonly<Record<string, string>>>;
    approvalContext?: ProjectSetupPreparationInput['approvalContext'];
    successHomeDir?: string;
    platform?: ProjectSetupPreparationInput['platform'];
    signal?: AbortSignal;
}>;

export type ProjectAgentLaunchPreparation = Readonly<{ kind: 'notAssociated' }>
    | Readonly<{ kind: 'refused'; code: string }>
    | Readonly<{ kind: 'prepared'; preparation: ProjectSetupPreparationInput;
        outcome: Exclude<ProjectSetupPreparationOutcome, { kind: 'refused' }> }>;

/** Namespace preflight intentionally needs no materialized child-process launch values. */
export async function preflightProjectAgentLaunch(input: Pick<ProjectAgentLaunchPreparationInput,
    'cwd' | 'machineId' | 'serverId' | 'serverHttpBaseUrl' | 'account' | 'workspaceId' | 'signal'>): Promise<
    Readonly<{ kind: 'notAssociated' | 'ready' }> | Readonly<{ kind: 'refused'; code: string }>> {
    try {
        const association = await resolveProjectSetupAcceptedWorkspace({ ...input.account,
            serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
            address: { serverId: input.serverId, machineId: input.machineId, rootPath: input.cwd,
                ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) },
            allowUnassociated: true, ...(input.signal ? { signal: input.signal } : {}) });
        if (!association) return { kind: 'notAssociated' };
        const definition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath,
            account: input.account, project: association.project, serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal });
        return await readProjectSetupNamespaceRefusal({ workspace: association.workspace,
            requester: { ...input.account, serverHttpBaseUrl: input.serverHttpBaseUrl }, signal: input.signal },
        definition.effectiveDefinition.effectiveManifest) ?? { kind: 'ready' };
    } catch (error) {
        return { kind: 'refused', code: input.signal?.aborted ? 'cancelled'
            : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_workspace_unavailable' };
    }
}

/** Passive cold admission: exact accepted Account association, then the one setup policy.
 * No filesystem containment, native evaluation or setup execution establishes a Project.
 */
export async function prepareProjectAgentLaunch(input: ProjectAgentLaunchPreparationInput,
    presentation?: Pick<ProjectSetupReviewPresentation, 'provenance'>): Promise<ProjectAgentLaunchPreparation> {
    try {
        input.signal?.throwIfAborted();
        input.onPhase?.('association');
        const associationStartedAt = performance.now();
        const association = await resolveProjectSetupAcceptedWorkspace({
            ...input.account, serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
            address: { serverId: input.serverId, machineId: input.machineId, rootPath: input.cwd,
                ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) },
            allowUnassociated: true, ...(input.signal ? { signal: input.signal } : {}),
        });
        logger.debug('[ProjectSetup] launch phase', { phase: 'association', durationMs: Math.round(performance.now() - associationStartedAt) });
        if (!association) return { kind: 'notAssociated' };
        const prepare = async (): Promise<ProjectAgentLaunchPreparation> => {
            input.onPhase?.('manifest');
            const definition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath,
                account: input.account, project: association.project, serverHttpBaseUrl: input.serverHttpBaseUrl, signal: input.signal });
            const requirements = definition.effectiveDefinition.effectiveManifest?.environmentVariables ?? [];
            input.onPhase?.('secret_inputs');
            const secretsStartedAt = performance.now();
            const environmentBindings = await resolveProjectRequesterSecretBindings(input.account, {
                project: association.project, requirements, environmentBindings: input.environmentBindings,
            }, input.signal);
            const secretInputs = input.resolveSecretInputs ? await input.resolveSecretInputs(environmentBindings) : { ...input, environmentBindings };
            logger.debug('[ProjectSetup] launch phase', { phase: 'secret_inputs', durationMs: Math.round(performance.now() - secretsStartedAt) });
            const secretNames = new Set(requirements.filter(requirement => requirement.kind === 'secret').map(requirement => requirement.name));
            const bindings = Object.fromEntries(Object.entries(secretInputs.environmentBindings?.bindings ?? {}).filter(([name]) => secretNames.has(name)));
            const preparation: ProjectSetupPreparationInput = {
                acceptedSetup: definition.acceptedSetup,
                originalEnvironment: input.originalEnvironment ?? process.env,
                ...(input.readRuntimeEnvironment ? { runtimeEnvironment: await input.readRuntimeEnvironment(association.workspace,
                    definition.effectiveDefinition.effectiveManifest) } : {}),
                ...(input.readDotenvPreparation ? { dotenvPreparation: input.readDotenvPreparation(association.workspace) } : {}),
                workspace: association.workspace, projectAssociation: association,
                requesterIdentity: input.requesterIdentity,
                requester: { ...input.account, serverHttpBaseUrl: input.serverHttpBaseUrl },
                purpose: 'setup', nativeIo: input.nativeIo ?? projectNativeSystemIo,
                platform: input.platform ?? { os: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch },
                successHomeDir: input.successHomeDir ?? configuration.happyHomeDir,
                ...(input.plugins ? { plugins: input.plugins } : {}),
                ...(secretInputs.secretEnvironment ? { secretEnvironment: secretInputs.secretEnvironment } : {}),
                ...(Object.keys(bindings).length ? { environmentBindings: { v: 1, bindings } } : {}),
                ...(input.configEnvironment ? { configEnvironment: input.configEnvironment } : {}),
                ...(input.approvalContext ? { approvalContext: input.approvalContext } : {}),
                ...(input.signal ? { signal: input.signal } : {}),
            };
            input.onPhase?.('setup_preparation');
            const outcome = await prepareProjectSetup(preparation, presentation);
            return outcome.kind === 'refused' ? outcome : { kind: 'prepared', preparation, outcome };
        };
        return await (input.withProjectWorkspaceSource?.(association.workspace, prepare) ?? prepare());
    } catch (error) {
        return { kind: 'refused', code: input.signal?.aborted ? 'cancelled'
            : error instanceof SavedSecretOperationAdmissionError ? 'project_environment_binding_unavailable'
            : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_workspace_unavailable' };
    }
}
