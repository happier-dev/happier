import axios from 'axios';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { admitProjectSourceAttachmentV1 } from '@happier-dev/protocol/projects/sources/projectSourceAttachmentAdmissionV1';
import {
  ProjectSourcesListInputV1Schema, ProjectSourcesListOutputV1Schema,
  ProjectSourcesReadInputV1Schema, ProjectSourcesReadOutputV1Schema,
  ProjectSourcesCreateInputV1Schema, ProjectSourcesCreateOutputV1Schema,
  ProjectSourcesUpdateInputV1Schema, ProjectSourcesUpdateOutputV1Schema,
  ProjectSourcesDeleteInputV1Schema, ProjectSourcesDeleteOutputV1Schema,
  type ProjectSourcesFailureV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';

type SourceActionId = 'projects.sources.list' | 'projects.sources.read' | 'projects.sources.create' | 'projects.sources.update' | 'projects.sources.delete';
type SourceActionDeps = Pick<ActionExecutorDeps, 'projectSourcesList' | 'projectSourcesRead' | 'projectSourcesCreate' | 'projectSourcesUpdate' | 'projectSourcesDelete'>;
type Schema<T> = Readonly<{ parse(value: unknown): T }>;
type SourceArtifactReader = Parameters<typeof admitProjectSourceAttachmentV1>[0]['readArtifact'];
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** CLI carrier of the Source contract; Account admission and request authority remain host-owned. */
export function createCliProjectSourceActionDeps(params: Readonly<{
  serverHttpBaseUrl: string;
  admitAccount(serverId: string, context: ActionExecutorContext): ActionExecuteFailure | null | Promise<ActionExecuteFailure | null>;
  resolveRequestHeaders(context: ActionExecutorContext, actionId: SourceActionId,
    request: Readonly<{ method: string; path: string; body?: unknown }>): Readonly<Record<string, string>> | null
      | Promise<Readonly<Record<string, string>> | null>;
  readArtifact?(ref: Parameters<SourceArtifactReader>[0], options: Parameters<SourceArtifactReader>[1],
    context: ActionExecutorContext): ReturnType<SourceArtifactReader>;
}>): SourceActionDeps {
  async function request<T>(actionId: SourceActionId, serverId: string, path: string, method: string, body: unknown,
    schema: Schema<T>, context: ActionExecutorContext, prepare?: () => Promise<Readonly<{ ok: true }> | ProjectSourcesFailureV1>): Promise<T | ActionExecuteFailure | ProjectSourcesFailureV1> {
    let issued = false;
    try {
      const denied = await params.admitAccount(serverId, context);
      if (denied) return denied;
      context.signal?.throwIfAborted();
      const headers = await params.resolveRequestHeaders(context, actionId, { method, path,
        ...(body === undefined ? {} : { body }) });
      if (!headers) return failure('project_requester_authority_unavailable');
      if (prepare) {
        const admission = await prepare();
        if (!admission.ok) return admission;
        const changed = await params.admitAccount(serverId, context);
        if (changed) return changed;
      }
      context.signal?.throwIfAborted();
      issued = true;
      context.onTransportIssued?.();
      const response = await axios.request<unknown>({ url: `${params.serverHttpBaseUrl}${path}`, method, headers,
        ...(body === undefined ? {} : { data: body }), ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
      let output: T;
      try { output = schema.parse(response.data); }
      catch {
        if (response.status === 404 || response.status === 405 || response.status === 501) return failure('unsupported_action');
        if (response.status === 401) return failure('action_home_signed_out');
        if (response.status === 403) return failure('action_forbidden');
        return failure(method === 'GET' ? 'invalid_action_output' : 'outcome_unknown');
      }
      if (method === 'GET') {
        context.signal?.throwIfAborted();
        const changed = await params.admitAccount(serverId, context);
        if (changed) return changed;
      }
      return output;
    } catch (error) {
      const outcome = classifyHomeDomainHttpMutationFailureV1({ error, issued, aborted: context.signal?.aborted === true });
      return failure(outcome === 'cancelled' ? 'cancelled'
        : method !== 'GET' && outcome === 'outcome_unknown' ? 'outcome_unknown'
          : context.signal?.aborted ? 'cancelled' : 'home_unreachable');
    }
  }
  return {
    projectSourcesList: async (raw, context) => {
      const input = ProjectSourcesListInputV1Schema.parse(raw);
      const query = new URLSearchParams({ serverId: input.serverId });
      if (input.query !== undefined) query.set('query', input.query);
      if (input.audience) query.set('audience', JSON.stringify(input.audience));
      if (input.cursor) query.set('cursor', input.cursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      return request('projects.sources.list', input.serverId, `/v1/projects/sources?${query}`, 'GET', undefined, ProjectSourcesListOutputV1Schema, context);
    },
    projectSourcesRead: async (raw, context) => {
      const input = ProjectSourcesReadInputV1Schema.parse(raw);
      return request('projects.sources.read', input.serverId, `/v1/projects/sources/${encodeURIComponent(input.sourceId)}?serverId=${encodeURIComponent(input.serverId)}`,
        'GET', undefined, ProjectSourcesReadOutputV1Schema, context);
    },
    projectSourcesCreate: async (raw, context) => {
      const input = ProjectSourcesCreateInputV1Schema.parse(raw);
      return request('projects.sources.create', input.serverId, '/v1/projects/sources', 'POST', input, ProjectSourcesCreateOutputV1Schema, context);
    },
    projectSourcesUpdate: async (raw, context) => {
      const input = ProjectSourcesUpdateInputV1Schema.parse(raw);
      const attachment = input.patch.attachment;
      return request('projects.sources.update', input.serverId, `/v1/projects/sources/${encodeURIComponent(input.sourceId)}`, 'PATCH', input,
        ProjectSourcesUpdateOutputV1Schema, context, attachment?.kind === 'attach' ? () => admitProjectSourceAttachmentV1({
          attachment: attachment.attachment, sourceServerId: input.serverId, signal: context.signal,
          readArtifact: (ref, options) => params.readArtifact ? params.readArtifact(ref, options, context) : Promise.resolve(null),
        }) : undefined);
    },
    projectSourcesDelete: async (raw, context) => {
      const input = ProjectSourcesDeleteInputV1Schema.parse(raw);
      return request('projects.sources.delete', input.serverId, `/v1/projects/sources/${encodeURIComponent(input.sourceId)}`, 'DELETE', input, ProjectSourcesDeleteOutputV1Schema, context);
    },
  };
}
