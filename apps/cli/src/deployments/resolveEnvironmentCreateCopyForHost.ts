import { environmentSecretBindingIdentityV1, type ActionExecutorContext, type DeploymentEnvironmentCreateIntentInputV1,
    type DeploymentEnvironmentCopyPlanV1, type DeploymentEnvironmentCopyReviewV1,
    type EnvironmentSecretBindingV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { ArtifactEncryptionMaterialUnavailableError, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import type { EnvironmentCreateHost } from './prepareEnvironmentCreateForHost';

export type EnvironmentCreateCopyResolution = Readonly<{
    input: DeploymentEnvironmentCreateIntentInputV1;
    content?: Pick<DeploymentEnvironmentContentV1, 'ownServer'>;
    copyPlan?: DeploymentEnvironmentCopyPlanV1;
    review?: DeploymentEnvironmentCopyReviewV1;
}>;
export type EnvironmentCreateCopyHost = EnvironmentCreateHost & Readonly<{
    readMetadata: Parameters<typeof readDeploymentEnvironmentForHost>[1]['readMetadata'];
}>;

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

function exactChoices<T>(choices: readonly T[], identity: (choice: T) => string, expected: readonly string[]): Map<string, T> {
    const selected = new Map(choices.map(choice => [identity(choice), choice]));
    if (selected.size !== choices.length || choices.length !== expected.length || expected.some(key => !selected.has(key)))
        return refuse('deployment_invalid');
    return selected;
}

/** Capture the admitted source once, before the creating Action resolves omitted defaults. */
export async function resolveEnvironmentCreateCopyForHost(
    { input, context }: Readonly<{ input: DeploymentEnvironmentCreateIntentInputV1; context: ActionExecutorContext }>,
    host: EnvironmentCreateCopyHost,
): Promise<EnvironmentCreateCopyResolution | ActionExecuteFailure> {
    if (!input.copyFrom) return { input };
    const copyFrom = input.copyFrom;
    const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
    const headers = async (transport: Readonly<{ method: string; path: string; body?: unknown }>) => {
        const admitted = await host.resolveRequestHeaders(context, 'deployments.environments.create', transport);
        if (!admitted) return refuse('action_forbidden');
        return admitted;
    };
    try {
        await host.assertCurrent(context);
        context.signal?.throwIfAborted();
        const source = await readDeploymentEnvironmentForHost({ environmentId: copyFrom.environmentId, context }, {
            assertCurrent: host.assertCurrent,
            async readMetadata(request) {
                const detail = await host.readMetadata(request);
                if (detail.environment.revision !== copyFrom.expectedRevision) return refuse('deployment_conflict');
                return detail;
            },
            open: artifactId => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read(artifactId, {
                signal: context.signal, prepareRecipients: false, includeSharedAudience: false,
                authorizationHeaders: headers,
            })),
        });
        const secretRows = source.content.bindings.filter(binding => binding.source.kind === 'secret');
        const valueRows = source.content.bindings.filter(binding => binding.source.kind !== 'secret');
        const secrets = exactChoices(copyFrom.choices.secrets, choice => environmentSecretBindingIdentityV1(choice.binding),
            secretRows.map(environmentSecretBindingIdentityV1));
        const values = exactChoices(copyFrom.choices.values, choice => environmentSecretBindingIdentityV1(choice.binding),
            valueRows.map(environmentSecretBindingIdentityV1));
        const data = exactChoices(copyFrom.choices.data, choice => choice.targetLinkId,
            source.targetLinks.filter(link => link.role === 'data').map(link => link.id));
        const review: DeploymentEnvironmentCopyReviewV1 = { sourceEnvironmentId: source.environment.id,
            sourceRevision: source.environment.revision, included: [`definition:${source.content.definition.kind}`], omitted: [] };
        const bindings: EnvironmentSecretBindingV1[] = [];
        for (const binding of source.content.bindings) {
            const identity = environmentSecretBindingIdentityV1(binding);
            const choice = binding.source.kind === 'secret' ? secrets.get(identity)! : values.get(identity)!;
            if (choice.kind === 'omit') { review.omitted.push(`binding:${identity}`); continue; }
            // These addresses require their existing owner to select a new
            // destination. Copy never assigns a foreign live Domain/data link.
            if (binding.purpose !== 'variable' && binding.purpose !== 'registry') return refuse('unsupported_action');
            if (binding.purpose === 'registry' && (binding.targetLinkId !== source.environment.runtimeTargetLinkId
                || input.firstTargetLink === undefined)) return refuse('unsupported_action');
            const selected = choice.kind === 'rebind' || choice.kind === 'remap' ? { ...binding, source: choice.source } : binding;
            // The source-row partition keeps non-variable bindings secret-only.
            bindings.push(selected as EnvironmentSecretBindingV1);
            review.included.push(`binding:${identity}:${choice.kind}`);
        }
        for (const choice of data.values()) {
            if (choice.kind !== 'omit') return refuse('unsupported_action');
            review.omitted.push(`data:${choice.targetLinkId}`);
        }
        const definition = source.content.definition;
        const authoredDefinition: NonNullable<DeploymentEnvironmentCreateIntentInputV1['definition']> = definition.kind === 'repository'
            ? { from: 'repository', ref: definition.ref, compose: definition.compose }
            : { from: 'compose', document: definition.document, profiles: definition.profiles, services: definition.services,
                ...(definition.primaryService === undefined ? {} : { primaryService: definition.primaryService }) };
        const retention = input.retainPreviousDeployments ?? (copyFrom.choices.retainPreviousDeployments === 'copy'
            ? source.content.retainPreviousDeployments : undefined);
        if (copyFrom.choices.retainPreviousDeployments === 'copy' && input.retainPreviousDeployments === undefined)
            review.included.push('retainPreviousDeployments:copy');
        if (source.content.ownServer !== undefined) review.included.push('ownServer');
        context.signal?.throwIfAborted();
        return { input: { ...input, definition: authoredDefinition,
            ...(retention === undefined ? {} : { retainPreviousDeployments: retention }) },
            content: { ownServer: source.content.ownServer }, review,
            copyPlan: { bindings, ...(source.environment.runtimeTargetLinkId === undefined ? {}
                : { sourceRuntimeTargetLinkId: source.environment.runtimeTargetLinkId }) } };
    } catch (error) {
        const code = context.signal?.aborted ? 'cancelled' : error instanceof ArtifactEncryptionMaterialUnavailableError ? 'client_required'
            : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable';
        return { ok: false, errorCode: code, error: code };
    }
}
