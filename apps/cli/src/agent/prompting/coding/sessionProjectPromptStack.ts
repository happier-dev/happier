import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { StoredCredentials } from '@/persistence';
import { resolveWorkspaceRefV1, projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';

export type SessionProjectPromptStackInput = Readonly<{
  credentials: StoredCredentials; metadata: unknown; signal?: AbortSignal; machineId: string; directory?: string; serverId?: string;
}>;

export async function resolveSessionProjectPromptStack(input: SessionProjectPromptStackInput): Promise<readonly PromptStackEntryV1[]> {
  input.signal?.throwIfAborted();
  const pending = (reason: 'project_association_unavailable' | 'project_source_unavailable'): never => {
    throw Object.assign(new Error(reason), { code: 'preparation_pending', status: 'preparation_pending', reason });
  };
  const metadata = input.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const workspaceId: unknown = Reflect.get(metadata, 'workspaceId');
  const projectId: unknown = Reflect.get(metadata, 'projectId');
  if (workspaceId === undefined && projectId === undefined) return [];
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) return pending('project_association_unavailable');
  const path: unknown = input.directory ?? Reflect.get(metadata, 'path');
  if (typeof path !== 'string' || !path.trim()) return pending('project_association_unavailable');
  const serverId = input.serverId ?? configuration.activeServerId;
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const root = resolveSessionWorkspaceRootForMachine({ metadata, machineId: input.machineId, candidatePath: path });
  let snapshot: Awaited<ReturnType<typeof readProjectAccountRows>>;
  try { snapshot = await readProjectAccountRows({ credentials: input.credentials, serverId, signal: input.signal }); }
  catch { input.signal?.throwIfAborted(); return pending('project_association_unavailable'); }
  const resolved = resolveWorkspaceRefV1(snapshot.workspaceRefs, {
    serverId, workspaceId, machineId: input.machineId, rootPath: root.machinePath,
  });
  if (resolved.kind !== 'resolved') return pending('project_association_unavailable');
  const project = projectWorkspaceRefV1(resolved.ref);
  if (projectId !== undefined && projectId !== project.projectKey) return pending('project_association_unavailable');
  const personal = snapshot.organizations.find(row => row.key.serverId === serverId
    && row.key.projectKey === project.projectKey)?.value.promptStack ?? [];
  let shared: readonly PromptStackEntryV1[] = [];
  if (resolved.ref.source) {
    const sourceOwner = createCliProjectSourceActionDeps({
      serverHttpBaseUrl,
      admitAccount: target => target === serverId ? null : { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' },
      resolveRequestHeaders: () => ({ Authorization: `Bearer ${input.credentials.token}` }),
      readArtifact: (ref, options) => withCliPromptLibraryArtifactReader(async reader => {
        const artifact = await reader.readArtifact(ref);
        return artifact ? { artifactId: artifact.id, header: artifact.header } : null;
      }, {
        credentials: input.credentials, serverId, signal: options?.signal ?? input.signal,
      }),
    });
    const source = ProjectSourcesReadOutputV1Schema.safeParse(await sourceOwner.projectSourcesRead!({ serverId, sourceId: resolved.ref.source.sourceId }, { signal: input.signal }));
    input.signal?.throwIfAborted();
    if (!source.success || !source.data.ok) return pending('project_source_unavailable');
    shared = (source.data.source.attachments ?? []).flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : []);
  }
  input.signal?.throwIfAborted();
  return [...shared, ...personal].map(entry => ({ ...entry, ref: { ...entry.ref, serverId: entry.ref.serverId ?? serverId } }));
}
