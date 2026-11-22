import { randomUUID } from 'node:crypto';
import { readSessionStateFieldFromMetadata, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { createSessionStateFieldMetadataUpdater } from '@happier-dev/agents/session/state/metadataWriters';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { createBotTemplateActionExecuteV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAcknowledgedAccountArtifactTransport, type ArtifactRequestAuthorizationHeaders,
  type createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { requireExternalActionHeaders } from '@/api/externalActionHeaderRefusal';
import type { CliSessionActionTransport } from '@/session/transport/cliActionTransport';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import type { CliActionDepsParams } from './types';
import type { PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readRequesterDeploymentArtifactStore } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionTransportContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

export function createCliBotTemplateActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'serverHttpBaseUrl' | 'savedSecretOperationContext' | 'onPublicLinkIssued'>,
  host: Pick<CliSessionActionTransport, 'resolveTransportForSession' | 'readTransportSessionOwnerMetadata'> & Readonly<{
    artifactCallerContext(context: ActionExecutorContext): ActionExecutorContext;
    homeAccountId: string | null;
    isSameActionHomeId(serverId: string): boolean;
    roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
    registryPort?: PromptLibraryStackActionPortV1;
    content: Pick<ActionExecutorDeps, 'promptDocGet' | 'skillActionExecute'>;
    resolveServerRequestHeaders(context: ActionExecutorContext | undefined, actionId: string,
      request: Readonly<{ method: string; path: string; body?: unknown }>): Readonly<Record<string, string>> | null;
  }>,
): Pick<ActionExecutorDeps, 'botTemplateAction' | 'prepareBotTemplateInstantiation' | 'prepareBotTemplateRelease' | 'prepareBotTemplateUpdate'> {
  const ordinaryContext = (context: ActionExecutorContext): ActionExecutorContext | null => {
    const root = context.externalActionExecutionAuthorization;
    if (root && root.binding.accountId !== host.homeAccountId) return null;
    return root ? { ...context, externalActionExecutionAuthorization: undefined } : context;
  };
  const metadataHeaders = async (context: ActionExecutorContext, actionId: string):
    Promise<NonNullable<Parameters<typeof updateSessionMetadataForTarget>[0]['resolveAuthorizationHeaders']>> => {
    const root = context.externalActionExecutionAuthorization;
    if (root && 'credentialId' in root.binding) {
      return request => host.resolveServerRequestHeaders(context, actionId, request);
    }
    const accountContext = ordinaryContext(context);
    return request => accountContext ? host.resolveServerRequestHeaders(accountContext, actionId, request) : null;
  };
  const createExecute = (args: Parameters<NonNullable<ActionExecutorDeps['botTemplateAction']>>[0]) => {
    const context = args.context;
    const signal = args.signal ?? context.signal;
    const requireStore = () => {
      const authorization = context.externalActionExecutionAuthorization;
      const requesterStore = readRequesterDeploymentArtifactStore(authorization);
      if (requesterStore) return requesterStore;
      if (authorization && 'credentialId' in authorization.binding
        && authorization.binding.accountEncryptionMode === 'e2ee') return refuse('content_unavailable');
      return host.roleArtifactStore ?? refuse('not_authenticated');
    };
    const artifactHeaders = (caller: ActionExecutorContext): ArtifactRequestAuthorizationHeaders => async request => {
      const root = caller.externalActionExecutionAuthorization;
      if (root && 'credentialId' in root.binding) {
        return host.resolveServerRequestHeaders(caller, args.actionId, request) ?? refuse('execution_not_authorized');
      }
      const accountContext = ordinaryContext(caller) ?? refuse('execution_not_authorized');
      if (readRequesterDeploymentArtifactStore(root)) {
        // The admitted Artifact store holds the original requester's credential.
        const requester = readRequesterAccountActionTransportContext(root) ?? refuse('execution_not_authorized');
        return requireExternalActionHeaders(resolveExternalActionServerRequestHeaders({
          context: accountContext, effectActionId: args.actionId, ...request, daemonToken: requester.credentials.token,
        }));
      }
      return host.resolveServerRequestHeaders(accountContext, args.actionId, request) ?? refuse('execution_not_authorized');
    };
    const authorizationHeaders = artifactHeaders(context);
    const readOwnedSession = async (source: Readonly<{ serverId: string; sessionId: string }>) => {
      if (!host.homeAccountId || !params.credentials) return refuse('not_authenticated');
      if (!host.isSameActionHomeId(source.serverId)) return refuse('server_scope_mismatch');
      const ownerAccountId = context.runtimeAccountId ?? host.homeAccountId;
      const root = context.externalActionExecutionAuthorization;
      const sessionReadContext = root && !('credentialId' in root.binding)
        ? ordinaryContext(context) : context;
      if (!sessionReadContext) return refuse('execution_not_authorized');
      const target = await host.resolveTransportForSession(source.sessionId, signal,
        { context: sessionReadContext, actionId: args.actionId }, source);
      if (!target.ok) return refuse(target.code);
      const raw = target.rawSession;
      if (target.sessionId !== source.sessionId || raw.id !== source.sessionId
        || raw.effectiveAccess === undefined && raw.share === undefined
        || readSessionAccessProjectionRoleV1(raw) !== 'owner'
        || raw.ownerAccountId !== undefined && raw.ownerAccountId !== ownerAccountId) return refuse('session_target_unavailable');
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
      resolvePluginRelease: async (source, _context, _signal, purpose) => {
        const { createCliRegistryHostV1 } = await import('@/registries/createCliRegistryHost');
        const registry = createCliRegistryHostV1({ credentials: params.credentials, port: host.registryPort, signal,
          operationContext: params.savedSecretOperationContext, actionContext: context });
        return purpose === 'update' ? registry.readBotTemplateUpdate(source.registryItem, source.contributionId)
          : registry.readBotTemplate(source.registryItem, source.contributionId);
      },
      isSameServerId: (left, right) => host.isSameActionHomeId(left) && host.isSameActionHomeId(right),
      recipient: { content: host.content,
        reportAcceptedVersion: (input, reportContext) => requireStore().reportTemplateAcceptedVersion(input, reportContext.signal, {
          authorizationHeaders: artifactHeaders(reportContext),
      }), readSession: readOwnedSession, writeInstance: async (ref, instance, instanceContext) => {
        const credentials = params.credentials ?? refuse('not_authenticated');
        const updater = createSessionStateFieldMetadataUpdater('intent.templateInstance', instance, undefined, null);
        const result = await updateSessionMetadataForTarget({ credentials, idOrPrefix: ref.sessionId,
          expectedSessionId: ref.sessionId,
          resolveAuthorizationHeaders: await metadataHeaders(instanceContext, 'template.instantiate'),
          updater: (metadata, mutation) => updater(metadata, mutation?.metadataRevision),
          currentness: { signal: instanceContext.signal },
        });
        if (!result.ok) refuse(result.code);
      }, updateInstance: async (ref, instance, expectedInstance, instanceContext) => {
        const credentials = params.credentials ?? refuse('not_authenticated');
        const updater = createSessionStateFieldMetadataUpdater('intent.templateInstance', instance, undefined, expectedInstance);
        const result = await updateSessionMetadataForTarget({ credentials, idOrPrefix: ref.sessionId,
          expectedSessionId: ref.sessionId,
          resolveAuthorizationHeaders: await metadataHeaders(instanceContext, args.actionId),
          updater: (metadata, mutation) => updater(metadata, mutation?.metadataRevision),
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
        const updater = createSessionStateFieldMetadataUpdater('intent.templateDraftRef', ref, undefined, null);
        const result = await updateSessionMetadataForTarget({ credentials, idOrPrefix: source.sessionId,
          expectedSessionId: source.sessionId,
          resolveAuthorizationHeaders: await metadataHeaders(context, args.actionId),
          updater: (metadata, mutation) => updater(metadata, mutation?.metadataRevision),
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
