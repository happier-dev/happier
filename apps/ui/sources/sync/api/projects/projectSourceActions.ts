import {
    ProjectSourcesListInputV1Schema, ProjectSourcesListOutputV1Schema,
    ProjectSourcesReadInputV1Schema, ProjectSourcesReadOutputV1Schema,
    ProjectSourcesCreateInputV1Schema, ProjectSourcesCreateOutputV1Schema,
    ProjectSourcesUpdateInputV1Schema, ProjectSourcesUpdateOutputV1Schema,
    ProjectSourcesDeleteInputV1Schema, ProjectSourcesDeleteOutputV1Schema,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { admitProjectSourceAttachmentV1 } from '@happier-dev/protocol/projects/sources/projectSourceAttachmentAdmissionV1';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type SourceAccountPort = Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'credentialAuthorityKind' | 'request' | 'assertCurrent'> & Readonly<{
    workflowArtifacts: Pick<LazyActionAccountContext['workflowArtifacts'], 'read'>;
}>;
type Schema<T> = Readonly<{ parse(value: unknown): T }>;

/** Transport below the Action front door, bound to its authenticated Account channel. */
export function createProjectSourceActionDeps(account: SourceAccountPort) {
    const scopeFailure = (error: unknown): ActionExecuteFailure | null => error instanceof Error
        && 'code' in error && error.code === 'action_account_scope_changed'
        ? { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' } : null;
    async function inSourceHome<T>(serverId: string, run: () => Promise<T>): Promise<T | ActionExecuteFailure> {
        try {
            admitHome(serverId);
            account.assertCurrent();
            return await run();
        } catch (error) {
            const failure = scopeFailure(error);
            if (failure) return failure;
            throw error;
        }
    }
    async function request<T>(path: string, method: string, input: unknown, schema: Schema<T>, context?: ActionExecutorContext): Promise<T | ActionExecuteFailure> {
        let issued = false;
        try {
            account.assertCurrent();
            context?.signal?.throwIfAborted();
            const response = await account.request(path, { method,
                ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
                ...(context?.signal ? { signal: context.signal } : {}),
            }, { onIssued: () => { issued = true; } });
            // A Source refusal is a domain result, including its current conflict row.
            // Parsing it at every status preserves that result instead of collapsing it to HTTP prose.
            let output: T;
            try { output = schema.parse(await response.json()); }
            catch (error) {
                const code = response.status === 404 || response.status === 405 ? 'unsupported_action'
                    : response.status === 401 ? 'action_home_signed_out' : response.status === 403 ? 'action_forbidden' : null;
                if (code) return { ok: false, errorCode: code, error: code };
                throw error;
            }
            if (method === 'GET') {
                context?.signal?.throwIfAborted();
                account.assertCurrent();
            }
            return output;
        } catch (error) {
            const failure = scopeFailure(error);
            if (failure) return failure;
            const outcome = classifyHttpMutationRequestFailure({ error, issued, signal: context?.signal });
            const errorCode = outcome === 'cancelled' || (method === 'GET' && context?.signal?.aborted) ? 'cancelled'
                : method !== 'GET' && outcome === 'outcome_unknown' ? 'outcome_unknown' : 'home_unreachable';
            return { ok: false, errorCode, error: errorCode };
        }
    }
    function admitHome(serverId: string) {
        if (!areServerProfileIdentifiersEquivalent(serverId, account.serverId)) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
    return {
        projectSourcesList: async (raw: Parameters<typeof ProjectSourcesListInputV1Schema.parse>[0], context?: ActionExecutorContext) => {
            const input = ProjectSourcesListInputV1Schema.parse(raw);
            const query = new URLSearchParams({ serverId: input.serverId });
            if (input.query !== undefined) query.set('query', input.query);
            if (input.audience) query.set('audience', JSON.stringify(input.audience));
            if (input.cursor) query.set('cursor', input.cursor);
            if (input.limit !== undefined) query.set('limit', String(input.limit));
            return inSourceHome(input.serverId, () => request(`/v1/projects/sources?${query}`, 'GET', undefined, ProjectSourcesListOutputV1Schema, context));
        },
        projectSourcesRead: async (raw: Parameters<typeof ProjectSourcesReadInputV1Schema.parse>[0], context?: ActionExecutorContext) => {
            const input = ProjectSourcesReadInputV1Schema.parse(raw);
            return inSourceHome(input.serverId, () => request(`/v1/projects/sources/${encodeURIComponent(input.sourceId)}?serverId=${encodeURIComponent(input.serverId)}`, 'GET', undefined, ProjectSourcesReadOutputV1Schema, context));
        },
        projectSourcesCreate: async (raw: Parameters<typeof ProjectSourcesCreateInputV1Schema.parse>[0], context?: ActionExecutorContext) => {
            const input = ProjectSourcesCreateInputV1Schema.parse(raw);
            return inSourceHome(input.serverId, () => request('/v1/projects/sources', 'POST', input, ProjectSourcesCreateOutputV1Schema, context));
        },
        projectSourcesUpdate: async (raw: Parameters<typeof ProjectSourcesUpdateInputV1Schema.parse>[0], context?: ActionExecutorContext) => {
            const input = ProjectSourcesUpdateInputV1Schema.parse(raw);
            return inSourceHome(input.serverId, async () => {
                if (input.patch.attachment?.kind === 'attach') {
                    account.assertCurrent();
                    const admission = await admitProjectSourceAttachmentV1({
                        attachment: input.patch.attachment.attachment, sourceServerId: input.serverId, signal: context?.signal,
                        readArtifact: async (ref, options) => {
                            if (areServerProfileIdentifiersEquivalent(ref.serverId, account.serverId)) return account.workflowArtifacts.read(ref.artifactId, options);
                            // Delegation on this Home cannot borrow the user's foreign
                            // credentials. Ordinary reads capture that Home independently.
                            if (account.credentialAuthorityKind === 'api_token'
                                || context?.externalActionCredential || context?.externalActionExecutionAuthorization) return null;
                            const opened = await withUiPromptLibraryArtifactReader(reader => reader.readArtifact(ref), {
                                serverId: account.serverId, signal: options?.signal,
                            });
                            return opened ? { artifactId: opened.id, header: opened.header } : null;
                        },
                    });
                    account.assertCurrent();
                    if (!admission.ok) return admission;
                }
                return request(`/v1/projects/sources/${encodeURIComponent(input.sourceId)}`, 'PATCH', input, ProjectSourcesUpdateOutputV1Schema, context);
            });
        },
        projectSourcesDelete: async (raw: Parameters<typeof ProjectSourcesDeleteInputV1Schema.parse>[0], context?: ActionExecutorContext) => {
            const input = ProjectSourcesDeleteInputV1Schema.parse(raw);
            return inSourceHome(input.serverId, () => request(`/v1/projects/sources/${encodeURIComponent(input.sourceId)}`, 'DELETE', input, ProjectSourcesDeleteOutputV1Schema, context));
        },
    };
}
