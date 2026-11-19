import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { environmentSecretBindingIdentityV1, type ActionExecutorContext, type DeploymentEnvironmentCreateIntentInputV1,
    type DeploymentEnvironmentCopyPlanV1, type DeploymentEnvironmentCopyReviewV1,
    type EnvironmentSecretBindingV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DeploymentEnvironmentCopyProvisionV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentCopyV1';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { DeploymentTargetV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployments/contracts/v1';
import { ArtifactEncryptionMaterialUnavailableError, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { projectDeploymentException } from './deploymentFailure';
import type { EnvironmentCreateHost } from './prepareEnvironmentCreateForHost';

export type EnvironmentCreateCopyResolution = Readonly<{
    input: DeploymentEnvironmentCreateIntentInputV1;
    content?: Pick<DeploymentEnvironmentContentV1, 'ownServer'>;
    copyPlan?: DeploymentEnvironmentCopyPlanV1;
    review?: DeploymentEnvironmentCopyReviewV1;
}>;
export type EnvironmentCreateCopyHost = EnvironmentCreateHost & Readonly<{
    readMetadata: Parameters<typeof readDeploymentEnvironmentForHost>[1]['readMetadata'];
    readDataProvisionDeclaration?(source: DeploymentTargetV1['source']): Promise<Readonly<{
        target: DeploymentTargetV1; action: DeploymentEnvironmentCopyProvisionV1['action'];
        inputSchema: NonNullable<ResolvedActionContribution['definition']['inputSchema']>;
    }> | null>;
}>;

const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };

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
        const copiedData: NonNullable<DeploymentEnvironmentCopyPlanV1['data']> = [];
        const selectedConnections = new Set(bindings.filter(binding => binding.purpose === 'variable'
            && binding.source.kind === 'secret').map(environmentSecretBindingIdentityV1));
        for (const [index, choice] of [...data.values()].entries()) {
            if (choice.kind === 'omit') { review.omitted.push(`data:${choice.targetLinkId}`); continue; }
            if (choice.kind === 'reuse') {
                const connections = choice.bindings?.map(environmentSecretBindingIdentityV1) ?? [];
                if (connections.length === 0 || new Set(connections).size !== connections.length
                    || connections.some(identity => !selectedConnections.has(identity))) {
                    const { actionInputIssueFailure } = await import('@happier-dev/protocol/actions/executor/actionInputValidation');
                    return actionInputIssueFailure({ code: 'custom', path: ['copyFrom', 'choices', 'data', index, 'bindings'] });
                }
                // Share only explicitly selected Saved Secret connections. The source
                // provider resource stays attached to its original Environment.
                review.included.push(`data:${choice.targetLinkId}:reuse`);
                continue;
            }
            if (choice.kind === 'createEmpty') {
                const link = source.targetLinks.find(row => row.id === choice.targetLinkId)!;
                if (link.source.kind !== 'plugin') return refuse('unsupported_action');
                const declaration = await host.readDataProvisionDeclaration?.(link.source);
                if (!declaration) return refuse('unsupported_action');
                if (declaration.target.role !== 'data' || declaration.target.targetKind !== link.targetKind
                    || !sameStrictJsonValue(declaration.action, choice.provision.action)) return refuse('target_mismatch');
                const { compilePluginJsonSchema } = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
                const validate = compilePluginJsonSchema(declaration.inputSchema);
                if (!validate(choice.provision.input)) {
                    const { actionInputIssueFailure, projectActionInputJsonSchemaIssues } = await import('@happier-dev/protocol/actions/executor/actionInputValidation');
                    return actionInputIssueFailure(...projectActionInputJsonSchemaIssues(validate, declaration.inputSchema, choice.provision.input)
                        .map(issue => ({ ...issue, path: ['copyFrom', 'choices', 'data', index, 'provision', 'input', ...issue.path] })));
                }
                copiedData.push({ targetLinkId: link.id, targetId: declaration.target.id, targetKind: link.targetKind,
                    contribution: link.source.contribution, provision: choice.provision });
                review.included.push(`data:${choice.targetLinkId}:createEmpty`);
                continue;
            }
            return refuse('unsupported_action');
        }
        const definition = source.content.definition;
        const authoredDefinition: NonNullable<DeploymentEnvironmentCreateIntentInputV1['definition']> = definition.kind === 'repository'
            ? { from: 'repository', ref: definition.ref, compose: definition.compose }
            : { from: 'compose', document: definition.document, profiles: definition.profiles, services: definition.services,
                ...(definition.publicFiles === undefined ? {} : { publicFiles: definition.publicFiles }),
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
            copyPlan: { bindings, ...(copiedData.length ? { data: copiedData } : {}), ...(source.environment.runtimeTargetLinkId === undefined ? {}
                : { sourceRuntimeTargetLinkId: source.environment.runtimeTargetLinkId }) } };
    } catch (error) {
        if (!context.signal?.aborted && error instanceof ArtifactEncryptionMaterialUnavailableError) {
            return { ok: false, errorCode: 'client_required', error: 'client_required' };
        }
        return projectDeploymentException(error, { signal: context.signal });
    }
}
