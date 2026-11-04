import { randomUUID } from 'node:crypto';
import { readSessionStateFieldFromMetadata, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { createSessionStateFieldMetadataUpdater } from '@happier-dev/agents/session/state/metadataWriters';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { createBotTemplateActionExecuteV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAcknowledgedAccountArtifactTransport, type ArtifactRequestAuthorizationHeaders,
  type createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { CliSessionActionTransport } from '@/session/transport/cliActionTransport';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import type { CliActionDepsParams } from './types';
import type { PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { enrichTemplateRequesterSetupAuthorization, prepareOriginalTemplateRequesterAuthorization, resolveExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

export function createCliBotTemplateActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'serverHttpBaseUrl' | 'savedSecretOperationContext' | 'onPublicLinkIssued'>,
  host: Pick<CliSessionActionTransport, 'resolveTransportForSession' | 'readTransportSessionOwnerMetadata'> & Readonly<{
    artifactCallerContext(context: ActionExecutorContext): ActionExecutorContext;
    homeAccountId: string | null;
    isSameActionHomeId(serverId: string): boolean;
    roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
    registryPort?: PromptLibraryStackActionPortV1;
    content: Pick<ActionExecutorDeps, 'promptDocGet' | 'skillActionExecute' | 'machineSetupPlan'>;
    resolveServerRequestHeaders(context: ActionExecutorContext | undefined, actionId: string,
      request: Readonly<{ method: string; path: string; body?: unknown }>): Readonly<Record<string, string>> | null;
  }>,
): Pick<ActionExecutorDeps, 'botTemplateAction' | 'prepareBotTemplateInstantiation' | 'prepareBotTemplateRelease' | 'prepareBotTemplateUpdate'> {
  const resolveHeaders = async (context: ActionExecutorContext, actionId: string,
    request: Readonly<{ method: string; path: string; body?: unknown }>) => {
    const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
    const rootActionId = context.externalActionExecutionAuthorization?.binding.actionId;
    return (rootActionId === 'template.instantiate' || rootActionId === 'template.updates.apply') && projection
      ? resolveExternalActionRequesterServerRequestHeaders({ context, effectActionId: actionId,
        serverHttpBaseUrl: params.serverHttpBaseUrl ?? projection.serverHttpBaseUrl, ...request })
      : host.resolveServerRequestHeaders(context, actionId, request);
  };
  const metadataHeaders = async (context: ActionExecutorContext, actionId: string, sessionId: string):
    Promise<NonNullable<Parameters<typeof updateSessionMetadataForTarget>[0]['resolveAuthorizationHeaders']>> => {
    const rootActionId = context.externalActionExecutionAuthorization?.binding.actionId;
    if (rootActionId === 'template.instantiate' || rootActionId === 'template.updates.apply') {
      // Requester roots bind the admitted operation, rather than each HTTP body.
      // The metadata owner already carries the invocation's local cancel signal.
      const headers = await resolveHeaders(context, actionId, { method: 'GET', path: `/v2/sessions/${encodeURIComponent(sessionId)}` });
      return () => headers;
    }
    return request => host.resolveServerRequestHeaders(context, actionId, request);
  };
  const createExecute = (args: Parameters<NonNullable<ActionExecutorDeps['botTemplateAction']>>[0]) => {
    let context = args.context;
    const signal = args.signal ?? context.signal;
    const requireStore = () => host.roleArtifactStore ?? refuse('not_authenticated');
    const authorizationHeaders: ArtifactRequestAuthorizationHeaders = async request => {
      const headers = await resolveHeaders(context, args.actionId, request);
      return headers ? { ...headers } : refuse('execution_not_authorized');
    };
    const readOwnedSession = async (source: Readonly<{ serverId: string; sessionId: string }>) => {
      if (!host.homeAccountId || !params.credentials) return refuse('not_authenticated');
      if (!host.isSameActionHomeId(source.serverId)) return refuse('server_scope_mismatch');
      const target = await host.resolveTransportForSession(source.sessionId, signal,
        { context, actionId: args.actionId }, source);
      if (!target.ok) return refuse(target.code);
      const raw = target.rawSession;
      if (target.sessionId !== source.sessionId || raw.id !== source.sessionId
        || raw.effectiveAccess === undefined && raw.share === undefined
        || readSessionAccessProjectionRoleV1(raw) !== 'owner'
        || raw.ownerAccountId !== undefined && raw.ownerAccountId !== host.homeAccountId) return refuse('session_target_unavailable');
      const metadata = host.readTransportSessionOwnerMetadata(target);
      if (!metadata) return refuse('session_target_unavailable');
      const agentId = resolveAgentIdFromSessionMetadata(metadata);
      return { metadata, revision: raw.metadataVersion,
        ...(typeof metadata.machineId === 'string' && agentId ? { executionTarget: { machineId: metadata.machineId, agentId } } : {}) };
    };
    return createBotTemplateActionExecuteV1({
      artifacts: createAcknowledgedAccountArtifactTransport({
        read: (artifactId, options) => requireStore().read(artifactId, { ...options, authorizationHeaders }),
        create: input => requireStore().create({ ...input, authorizationHeaders }),
        update: input => requireStore().update({ ...input, authorizationHeaders }),
      }),
      randomId: randomUUID,
      requesterAccountId: host.homeAccountId ?? undefined,
      resolvePluginRelease: async (source, _context, _signal, purpose) => {
        const { createCliRegistryHostV1 } = await import('@/registries/createCliRegistryHost');
        const registry = createCliRegistryHostV1({ credentials: params.credentials, port: host.registryPort, signal,
          operationContext: params.savedSecretOperationContext, actionContext: context });
        return purpose === 'update' ? registry.readBotTemplateUpdate(source.registryItem, source.contributionId)
          : registry.readBotTemplate(source.registryItem, source.contributionId);
      },
      isSameServerId: (left, right) => host.isSameActionHomeId(left) && host.isSameActionHomeId(right),
      recipient: { content: host.content,
        prepareRequesterAdmission: async request => {
          if (!request.machineSetupPlanInput && request.requesterAuthorship === undefined) return request.context;
          const credentials = params.credentials ?? refuse('not_authenticated');
          const projection = request.context.externalActionExecutionAuthorization?.requesterHttpProjection;
          if (!projection) return refuse('execution_not_authorized');
          context = await enrichTemplateRequesterSetupAuthorization({ context: request.context,
            ...(request.machineSetupPlanInput ? { planInput: request.machineSetupPlanInput } : {}),
            ...(request.requesterAuthorship ? { requesterAuthorship: request.requesterAuthorship } : {}), credentials,
            serverHttpBaseUrl: params.serverHttpBaseUrl ?? projection.serverHttpBaseUrl }) ?? refuse('execution_not_authorized');
          return context;
        },
        prepareUpdateRequesterAdmission: async request => {
          const credentials = params.credentials ?? refuse('not_authenticated');
          let preparedContext = request.context;
          if (!preparedContext.externalActionExecutionAuthorization) {
            const serverIdentityId = request.context.serverIdentityId ?? refuse('server_scope_mismatch');
            const serverHttpBaseUrl = params.serverHttpBaseUrl ?? refuse('server_scope_mismatch');
            const prepared = await prepareOriginalTemplateRequesterAuthorization({ actionId: 'template.updates.apply',
              input: request.input, context: request.context, executionTarget: request.executionTarget,
              credentials, serverId: request.context.serverId ?? serverIdentityId, serverIdentityId, serverHttpBaseUrl });
            preparedContext = prepared.ok ? prepared.context : refuse(prepared.code);
          }
          if (request.machineSetupPlanInput || request.requesterAuthorship !== undefined) {
            const projection = preparedContext.externalActionExecutionAuthorization?.requesterHttpProjection;
            if (!projection) return refuse('execution_not_authorized');
            preparedContext = await enrichTemplateRequesterSetupAuthorization({ context: preparedContext,
              ...(request.machineSetupPlanInput ? { planInput: request.machineSetupPlanInput } : {}),
              ...(request.requesterAuthorship ? { requesterAuthorship: request.requesterAuthorship } : {}),
              credentials, serverHttpBaseUrl: params.serverHttpBaseUrl ?? projection.serverHttpBaseUrl })
              ?? refuse('execution_not_authorized');
          }
          return context = preparedContext;
        },
        reportAcceptedVersion: (input, reportContext) => requireStore().reportTemplateAcceptedVersion(input, reportContext.signal, {
        authorizationHeaders: async request => {
          const headers = await resolveHeaders(reportContext, args.actionId, request);
          return headers ? { ...headers } : refuse('execution_not_authorized');
        },
      }), readSession: readOwnedSession, writeInstance: async (ref, instance, instanceContext) => {
        const credentials = params.credentials ?? refuse('not_authenticated');
        const result = await updateSessionMetadataForTarget({ credentials, idOrPrefix: ref.sessionId,
          expectedSessionId: ref.sessionId,
          resolveAuthorizationHeaders: await metadataHeaders(instanceContext, 'template.instantiate', ref.sessionId),
          updater: createSessionStateFieldMetadataUpdater('intent.templateInstance', instance, undefined, null),
          currentness: { signal: instanceContext.signal },
        });
        if (!result.ok) refuse(result.code);
      }, updateInstance: async (ref, instance, expectedInstance, instanceContext) => {
        const credentials = params.credentials ?? refuse('not_authenticated');
        const result = await updateSessionMetadataForTarget({ credentials, idOrPrefix: ref.sessionId,
          expectedSessionId: ref.sessionId,
          resolveAuthorizationHeaders: await metadataHeaders(instanceContext, args.actionId, ref.sessionId),
          updater: createSessionStateFieldMetadataUpdater('intent.templateInstance', instance, undefined, expectedInstance),
          currentness: { signal: instanceContext.signal },
        });
        if (!result.ok) refuse(result.code);
      } },
      readSourceDraftRef: async source => {
        const { metadata } = await readOwnedSession(source);
        return readSessionStateFieldFromMetadata(metadata, 'intent.templateDraftRef') ?? null;
      },
      writeSourceDraftRef: async (source, ref) => {
        const credentials = params.credentials ?? refuse('not_authenticated');
        const result = await updateSessionMetadataForTarget({ credentials, idOrPrefix: source.sessionId,
          expectedSessionId: source.sessionId,
          resolveAuthorizationHeaders: await metadataHeaders(context, args.actionId, source.sessionId),
          updater: createSessionStateFieldMetadataUpdater('intent.templateDraftRef', ref, undefined, null),
          currentness: { signal },
        });
        if (!result.ok) refuse(result.code);
      },
      grant: async input => {
        const receipt = await requireStore().accessGrants.set(input, signal, { authorizationHeaders });
        if (receipt.preparation?.status === 'pending') refuse('artifact_encryption_material_unavailable');
      },
      signedInLink: params.onPublicLinkIssued ? async (input, childContext) => {
        if (!childContext.hostReviewedChild) return refuse('admission_unavailable');
        const result = await childContext.hostReviewedChild.invoke({ action: 'artifact.public_link.create',
          role: 'signed_in_link', input });
        if (!result.ok) refuse(result.errorCode ?? 'public_share_request_failed');
      } : undefined,
    });
  };
  const withHome = <T>(operation: () => Promise<T>): Promise<T> => params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
  return { botTemplateAction: args => withHome(() => {
    const admitted = { ...args, context: host.artifactCallerContext(args.context) };
    return createExecute(admitted)(admitted);
  }),
    prepareBotTemplateRelease: request => {
      const admitted = { ...request, context: host.artifactCallerContext(request.context) };
      return withHome(() => createExecute({ ...admitted, actionId: 'template.release' }).prepareRelease(admitted));
    },
    prepareBotTemplateUpdate: async request => {
      const admitted = { ...request, context: host.artifactCallerContext(request.context) };
      const prepared = await withHome(() => createExecute({ ...admitted, actionId: 'template.updates.apply' }).prepareUpdate(admitted));
      if ('ok' in prepared || !prepared.executeAdmittedAction) return prepared;
      const execute = prepared.executeAdmittedAction;
      return { ...prepared, executeAdmittedAction: args => withHome(() => execute(args)) };
    },
    prepareBotTemplateInstantiation: async request => {
      const admitted = { ...request, context: host.artifactCallerContext(request.context) };
      const prepared = await withHome(() => createExecute({ ...admitted, actionId: 'template.instantiate' }).prepareInstantiation(admitted));
      if ('ok' in prepared || !prepared.executeAdmittedAction) return prepared;
      const execute = prepared.executeAdmittedAction;
      return { ...prepared, executeAdmittedAction: args => withHome(() => execute(args)) };
    } };
}
