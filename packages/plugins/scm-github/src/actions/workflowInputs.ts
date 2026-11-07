import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { parseGithubWorkflowDefinitionV1, type GithubWorkflowDefinitionV1 } from './workflowDefinition.js';
import type { GithubApiClientV1 } from '../observations/githubApiClient.js';
import { githubRecord } from './mapping.js';
import { githubCiRepositoryUrl, requestGithubCiJson } from './reads.js';
import { GithubWorkflowShaV1Schema } from './identity.js';

// One immutable-byte owner, keyed by the existing admitted client authority.
// Weak lifetime keys retire naturally with the request owner's credential/occurrence.
const definitions = new WeakMap<object, Map<string, GithubWorkflowDefinitionV1>>();
export async function resolveGithubWorkflowRefV1(client: GithubApiClientV1, repository: ScmHostingRepositoryIdentityV1, ref: string): Promise<string> {
  const response = await requestGithubCiJson(client, githubCiRepositoryUrl(repository, 'commits', ref));
  if (response.kind !== 'value') throw new RangeError('The workflow ref did not resolve');
  const sha = githubRecord(response.value).sha;
  const admitted = GithubWorkflowShaV1Schema.safeParse(sha);
  if (!admitted.success) throw new RangeError('Invalid workflow commit identity');
  return admitted.data;
}
export async function readGithubWorkflowDefinitionV1(client: GithubApiClientV1, input: Readonly<{
  repository: ScmHostingRepositoryIdentityV1; workflowPath: string; ref: string; commitSha?: string;
}>): Promise<Readonly<{ revision: string; definition: GithubWorkflowDefinitionV1 }>> {
  const path = input.workflowPath.split('/');
  if (path.length !== 3 || path[0] !== '.github' || path[1] !== 'workflows' || !/^[^/\\]+\.ya?ml$/u.test(path[2] ?? '') || path.some(part => part === '.' || part === '..')) throw new RangeError('Invalid workflow path');
  const revision = input.commitSha ?? await resolveGithubWorkflowRefV1(client, input.repository, input.ref);
  if (!GithubWorkflowShaV1Schema.safeParse(revision).success) throw new RangeError('Invalid workflow commit identity');
  const lifetime = client.immutableDefinitionLifetime ?? client;
  let retained = definitions.get(lifetime);
  if (retained === undefined) { retained = new Map(); definitions.set(lifetime, retained); }
  const key = JSON.stringify([input.repository.kind, input.repository.deployment, input.repository.repository, input.workflowPath, revision]);
  let definition = retained.get(key);
  if (definition === undefined) {
      // The account request owner coalesces simultaneous reads while preserving
      // each caller's cancellation. Do not cache the first caller's signal-bound
      // promise here: its cancellation must not reject another caller's demand.
      const url = new URL(githubCiRepositoryUrl(input.repository, 'contents', ...path));
      url.searchParams.set('ref', revision);
      const result = await requestGithubCiJson(client, url.toString());
      if (result.kind !== 'value') throw new RangeError('The immutable workflow has no body');
      const body = githubRecord(result.value);
      if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') throw new RangeError('Unsupported workflow Contents response');
      const content = body.content.replace(/\s/gu, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content)) throw new RangeError('Invalid workflow encoding');
      definition = retained.get(key);
      if (definition === undefined) {
        definition = parseGithubWorkflowDefinitionV1(decodeBase64(content));
        retained.set(key, definition);
      }
  }
  return { revision, definition };
}
