import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import { ForgeCiActionInputSchemasV1, ForgeCiActionResultSchemasV1, type ForgeCiActionInputByOperationV1, type ForgeCiOperationIdV1 } from './contracts.js';
import { createGithubApiClient, createGithubNativeApiClient } from '../observations/githubApiClient.js';
import { classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { GithubCiReadError, readGithubCiOperation } from './reads.js';
import { mutateGithubCi } from './mutations.js';
import { createGithubReadCadence } from '../observations/githubChannelPollCadence.js';

export type GithubCiInvocationContextV1<K extends ForgeCiOperationIdV1> =
  K extends 'downloadArtifact' | 'downloadJobLog' ? PluginInvocationContext : GithubHttpInvocationContextV1;

export async function executeGithubCiAction<K extends ForgeCiOperationIdV1>(operation: K, raw: unknown, context: GithubCiInvocationContextV1<K>): Promise<unknown> {
  // The declaration uses this exact executable schema's JSON projection. This
  // is the provider ingress, before credential materialization or any I/O.
  const schema = ForgeCiActionInputSchemasV1[operation];
  const input = schema.parse(raw);
  if (operation === 'downloadArtifact' || operation === 'downloadJobLog') return (await import('./download.js')).downloadGithubCiFile<'downloadArtifact' | 'downloadJobLog'>(
    // The operation-indexed public context requires native download services for these two operations.
    operation, input as ForgeCiActionInputByOperationV1['downloadArtifact' | 'downloadJobLog'], context as PluginInvocationContext);
  try {
    const client = 'credentialRef' in input && input.credentialRef
      ? await createGithubApiClient(context, input.credentialRef)
      : await createGithubNativeApiClient(context);
    switch (operation) {
      case 'listRuns': case 'readRun': case 'listJobs': case 'readJob': {
        const cadence = createGithubReadCadence(client, Date.now());
        const readOperation: 'listRuns' | 'readRun' | 'listJobs' | 'readJob' = operation;
        const result = ForgeCiActionResultSchemasV1[readOperation].parse(
          await readGithubCiOperation(operation, input as Parameters<typeof readGithubCiOperation>[1], cadence.client));
        if (result.kind === 'unavailable') return result;
        const refreshAfterMs = cadence.refreshAfterMs();
        return { ...result, ...(refreshAfterMs === undefined ? {} : { refreshAfterMs }) };
      }
      case 'listWorkflows': case 'readWorkflow': case 'listArtifacts': case 'listEnvironments': case 'listAnnotations':
        return await readGithubCiOperation(operation, input as Parameters<typeof readGithubCiOperation>[1], client);
      case 'enableWorkflow': case 'disableWorkflow': case 'rerunAll': case 'rerunFailed': case 'rerunJob': case 'cancelRun': case 'forceCancelRun': case 'approveForkRun':
        return await mutateGithubCi(operation, input as Parameters<typeof mutateGithubCi>[1], client);
      case 'readTrigger': return await (await import('./dispatch.js')).readGithubTrigger(client, input as ForgeCiActionInputByOperationV1['readTrigger']);
      case 'dispatchWorkflow': return await (await import('./dispatch.js')).dispatchGithubWorkflow(client, input as ForgeCiActionInputByOperationV1['dispatchWorkflow']);
      case 'readJobLog': return await (await import('./evidence.js')).readGithubJobLog(client, input as ForgeCiActionInputByOperationV1['readJobLog']);
      case 'readFailureContext': return await (await import('./evidence.js')).readGithubFailureContext(client, input as ForgeCiActionInputByOperationV1['readFailureContext']);
      case 'listDeployments': case 'readDeploymentHistory': case 'approveDeployment': case 'rejectDeployment':
        return await (await import('./deploymentReviews.js')).executeGithubDeploymentActionV1(operation, input as Parameters<typeof import('./deploymentReviews.js').executeGithubDeploymentActionV1>[1], client, context);
      default: throw new RangeError('This CI operation belongs to its deployment owner');
    }
  } catch (error) {
    const failure = error instanceof GithubCiReadError ? error.failure : error instanceof RangeError
      ? { class: 'unsupportedContract' as const, code: 'github_ci_target_invalid' } : classifyGithubTransportFailure(error);
    // Select the failure envelope from L02's executable result contract rather
    // than maintaining another operation-family table. No write was dispatched
    // here: native write owners settle their own uncertain outcomes in place.
    const readFailure = ForgeCiActionResultSchemasV1[operation].safeParse({ kind: 'unavailable', failure });
    return readFailure.success ? readFailure.data : { kind: 'rejected', failure };
  }
}
