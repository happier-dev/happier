import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema, PromptDocRevisionV1Schema, type PromptDocRevisionV1, type PromptDocCreateActionInputV1 } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { ArtifactOrganizationMutationFailureV1, ArtifactOrganizationMutationFailureDetailsV1Schema, readArtifactOrganizationV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';

import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
export {
  findPromptExternalLink,
  removePromptExternalLink,
  upsertPromptExternalLink,
} from './promptExternalLinks';

export async function createPromptDoc(
  params: PromptDocCreateActionInputV1 & Readonly<{
    serverId?: string | null;
    expectedAccountId?: string;
    signal?: AbortSignal;
    executeAction?: MountedAuthoringActionExecute;
  }>,
): Promise<string> {
  const { serverId, expectedAccountId, signal, executeAction, ...request } = params;
  const result = executeAction ? await executeAction('prompt_doc.create', request, { signal })
    : await (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor().execute('prompt_doc.create', request,
    { surface: 'ui', serverId: serverId ?? undefined, expectedAccountId, signal });
  if (!result.ok) {
    if (result.errorCode === 'artifact_organization_failed') {
      const details = ArtifactOrganizationMutationFailureDetailsV1Schema.safeParse(result.details);
      if (details.success) throw new ArtifactOrganizationMutationFailureV1(details.data);
    }
    throw Object.assign(new Error(result.errorCode), { code: result.errorCode, result });
  }
  const output = result.result;
  if (!output || typeof output !== 'object' || !('ok' in output) || output.ok !== true
    || !('artifactId' in output) || typeof output.artifactId !== 'string') {
    throw Object.assign(new Error('action_not_completed'), { code: 'action_not_completed', result });
  }
  return output.artifactId;
}

export async function updatePromptDoc(
  params: Readonly<{
    artifactId: string;
    title: string;
    markdown: string;
    folderId?: string | null;
    tags?: readonly string[];
    expectedRevision?: PromptDocRevisionV1;
    serverId?: string | null;
    signal?: AbortSignal;
  }>,
): Promise<PromptDocRevisionV1> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');
  const { serverId, signal, ...request } = params;
  const result = await (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor().execute(
    'prompt_doc.update', { ...request, artifactId }, { surface: 'ui', serverId: serverId ?? undefined, signal },
  );
  if (!result.ok) {
    if (result.errorCode === 'artifact_organization_failed') {
      const details = ArtifactOrganizationMutationFailureDetailsV1Schema.safeParse(result.details);
      if (details.success) throw new ArtifactOrganizationMutationFailureV1(details.data);
    }
    throw Object.assign(new Error(result.error), { code: result.errorCode, result });
  }
  const output = result.result;
  const revision = output && typeof output === 'object' && 'revision' in output
    ? PromptDocRevisionV1Schema.safeParse(output.revision) : null;
  if (!revision?.success) throw new Error('prompt_doc_update_receipt_unavailable');
  return revision.data;
}

export async function duplicatePromptDoc(artifactId: string, options?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>): Promise<string> {
  return await withUiPromptLibraryArtifactStore(async (store, account) => {
    const existing = await store.read(artifactId, { signal: options?.signal });
    if (existing?.header?.kind !== 'prompt_doc.v2')
      throw new Error('prompt_doc_invalid_kind');
    if (typeof existing.body !== 'string')
      throw new Error('prompt_doc_missing_body');
    const bodyRaw = existing.body;
    const parsed = PromptDocBodyV1Schema.safeParse(JSON.parse(bodyRaw));
    if (!parsed.success) throw new Error('prompt_doc_invalid_body');

    const header = PromptDocArtifactHeaderV1Schema.parse(existing.header);
    if (!store.organization) throw new Error('artifact_organization_unavailable');
    const read = await readArtifactOrganizationV1({ port: store.organization, artifactId, signal: options?.signal });
    if (read.status !== 'ready') throw Object.assign(new Error(read.reason), { code: read.reason });
    const organization = read.header;

    return await createPromptDoc({
        title: `${header.title || 'Prompt'} Copy`,
        markdown: parsed.data.markdown,
        folderId: organization.folderId ?? null,
        tags: organization.tags ?? [],
      serverId: store.organization.serverId,
      signal: options?.signal,
      executeAction: async (actionId, request, execution) => {
        const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
        return executeDefaultActionInCapturedAccount(account, actionId, request, {
          surface: 'ui', serverId: account.serverId, expectedAccountId: account.accountId, signal: execution?.signal,
        });
      },
    });
  }, options);
}
