import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import type { ForgeCiActionInputByOperationV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createGithubNativeApiClient } from '../observations/githubApiClient.js';
import { readGithubPositiveDecimal } from '../observations/githubProviderContracts.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { githubRecord } from './mapping.js';
import { GithubCiReadError, githubCiRepositoryUrl, readExactGithubRun, readSelectedGithubJob, requestGithubCiJson } from './reads.js';

type DownloadOperation = 'downloadArtifact' | 'downloadJobLog';

/** Provider acquisition only. The admitted Action/host own destination custody,
 * publication and receiver settlement; no nested download Action or local sink. */
export async function downloadGithubCiFile<K extends DownloadOperation>(operation: K,
  input: ForgeCiActionInputByOperationV1[K], context: PluginInvocationContext): Promise<FileDownloadResultV1> {
  let acquired: Readonly<{ name: string; bytes: Uint8Array; destination: typeof input.destination }>;
  try {
    const client = await createGithubNativeApiClient(context);
    let url: string;
    let name: string;
    if (operation === 'downloadArtifact') {
      const operands = input as ForgeCiActionInputByOperationV1['downloadArtifact'];
      const id = readGithubPositiveDecimal(operands.artifactId, 'artifact ID');
      await readExactGithubRun(client, input.repository, input.runId);
      const metadata = await requestGithubCiJson(client, githubCiRepositoryUrl(input.repository, 'actions', 'artifacts', id));
      if (metadata.kind !== 'value') throw new RangeError('Artifact metadata is unavailable');
      const artifact = githubRecord(metadata.value);
      if (readGithubPositiveDecimal(artifact.id, 'artifact ID') !== id || artifact.expired !== false
        || readGithubPositiveDecimal(githubRecord(artifact.workflow_run).id, 'artifact run ID') !== input.runId) throw new RangeError('Artifact is expired or outside the selected run');
      url = githubCiRepositoryUrl(input.repository, 'actions', 'artifacts', id, 'zip');
      name = `artifact-${id}.zip`;
    } else {
      const operands = input as ForgeCiActionInputByOperationV1['downloadJobLog'];
      const job = await readSelectedGithubJob(client, operands);
      if (job.state.phase !== 'completed') throw new RangeError('The selected job has not completed');
      url = githubCiRepositoryUrl(input.repository, 'actions', 'jobs', job.ref.jobId, 'logs');
      name = `job-${job.ref.jobId}.log`;
    }
    const response = await client.requestMedia({ url, media: 'binary' });
    if (response.status !== 200) throw new GithubCiReadError(classifyGithubResponseFailure(response, Date.now()));
    acquired = { name, bytes: response.body, destination: input.destination };
  } catch (error) {
    if (context.signal.aborted) return { success: false, status: 'cancelled', error: 'Download acquisition cancelled.', errorCode: 'cancelled' };
    const failure = error instanceof GithubCiReadError ? error.failure : error instanceof RangeError
      ? { code: 'github_download_target_invalid' } : classifyGithubTransportFailure(error);
    return { success: false, status: 'failed', error: 'GitHub file acquisition failed.', errorCode: failure.code };
  }
  // Do not turn a publication exception into a claim that nothing was accepted.
  // The host preserves its own cancellation/uncertain outcome and retained life.
  return context.services.fs.prepareDownload(acquired, { signal: context.signal });
}
