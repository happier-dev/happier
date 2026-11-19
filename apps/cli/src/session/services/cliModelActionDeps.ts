import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import type { setSessionModel } from '@/session/services/setSessionModel';
import { SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionModelUnarm' | 'sessionModelSet'>;

export function createCliSessionModelActionDeps(
  params: CliActionDepsParams,
  { projectHomeId, resolveServerRequestHeaders }: Readonly<{

    projectHomeId: string;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
  }>,
): FamilyActionDeps {
  return {
    sessionModelUnarm: async ({ sessionId, context }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const externalRequest = Boolean(context.externalActionCredential || context.externalActionExecutionAuthorization);
      const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }>) =>
        resolveServerRequestHeaders(context, 'session.model.unarm', request);
      if (externalRequest && (!params.externalActionMachineInstallationId || !params.externalActionMachineRequestPrivateKey
        || !resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const { setSessionModel } = await import("@/session/services/setSessionModel");
      const mutate = async () => setSessionModel({ credentials: params.credentials!, idOrPrefix: sessionId, serverId: projectHomeId, unarm: true,
        serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
        ...(externalRequest ? { resolveAuthorizationHeaders } : {}),
        ...(externalRequest && params.externalActionMachineInstallationId && params.externalActionMachineRequestPrivateKey ? {
          externalAction: { context, effectActionId: 'session.model.unarm', installationId: params.externalActionMachineInstallationId,
            privateKey: params.externalActionMachineRequestPrivateKey },
        } : {}),
      });
      const result = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if ('code' in result) return { ok: false, errorCode: result.code, error: result.code };
      const { sessionId: _sessionId, ...transition } = result;
      return SessionModelTransitionResultV1Schema.parse(transition);
    },
    sessionModelSet: async ({ context, callerInputConstraints, sessionId, modelId, providerConnectionId, teamCredentialModel, teamVisibilityGrantConsent, captureBefore, expected, applyTiming }) => {
      const credentials = params.credentials;
      if (!credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedModelId = readNonBlankOpaqueIdentifier(modelId);
      if (!normalizedModelId && teamCredentialModel === undefined) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const externalRequest = Boolean(context?.externalActionCredential || context?.externalActionExecutionAuthorization);
      const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }>) =>
        resolveServerRequestHeaders(context, 'session.model.set', request);
      if (externalRequest && (!params.externalActionMachineInstallationId || !params.externalActionMachineRequestPrivateKey
        || !resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const { setSessionModel } = await import("@/session/services/setSessionModel");
      const mutate = async () => setSessionModel({
        credentials,
        serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
        idOrPrefix: sessionId,
        serverId: projectHomeId,
        ...(applyTiming ? { applyTiming } : {}),
        ...(captureBefore !== undefined ? { captureBefore } : {}),
        ...(expected ? { expected } : {}),
        ...(normalizedModelId ? { modelId: normalizedModelId } : {}),
        ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
        ...(teamCredentialModel !== undefined ? { teamCredentialModel } : {}),
        ...(teamVisibilityGrantConsent !== undefined ? { teamVisibilityGrantConsent } : {}),
        ...(callerInputConstraints ? { callerInputConstraints } : {}),
        ...(externalRequest ? { resolveAuthorizationHeaders } : {}),
        ...(externalRequest && context && params.externalActionMachineInstallationId && params.externalActionMachineRequestPrivateKey ? {
          externalAction: { context, effectActionId: 'session.model.set',
            installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey },
        } : {}),
      });
      const res = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!res.ok) {
        const errorCode = 'code' in res ? res.code : res.status;
        return {
          ok: false,
          errorCode,
          error: errorCode === 'restart_required'
            ? 'This model change requires a runner restart. Create a new Session with happier session create using the requested model and Provider.'
            : errorCode,
          ...('candidates' in res && res.candidates ? { candidates: res.candidates } : {}),
          ...('status' in res
            ? {
                details: res,
              }
            : {}),
        };
      }
      if (res.status === 'intent_updated') {
        return {
          ok: true,
          status: res.status,
          sessionId: res.sessionId,
          modelId: 'ref' in res.selection ? res.selection.ref.modelId : res.selection.modelId,
          selection: res.selection,
          updatedAt: res.updatedAt,
          ...('reversal' in res && res.reversal ? { reversal: res.reversal } : {}),
        };
      }
      return {
        ...res,
        modelId: res.activeSelection.modelId,
      };
    },
  };
}
