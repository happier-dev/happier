import axios from '@/api/client/credentialAxios';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { isSessionTargetPreparationAction } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveSessionFollowActionRequest, parseSessionFollowActionResponse } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { ListSessionFollowSourcesResponseSchema, SessionFollowSourcesErrorResponseSchema, SetSessionFollowSourceResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { DeliveryMuteErrorResponseV1Schema, FollowReceiverRefV1Schema } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { ListAccountSessionFollowsResponseV1Schema, ReplaceSessionVoiceInclusionsResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { projectSessionFollowSourceKeyPreparationAfterSetV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { FollowRuleSetActionInputV1Schema, SessionFollowActionInputSchemasV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { equalFollowRuleReceiverV1, GetSessionFollowRuleResponseV1Schema, ListSessionFollowRulesResponseV1Schema,
  SessionFollowRuleErrorResponseV1Schema,
  SessionFollowRuleDefinitionV1Schema, SetSessionFollowRuleResponseV1Schema, SESSION_FOLLOW_RULES_ROUTE_V1,
  type SessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { openSessionFollowRuleContentV1, sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import type { SessionFollowSourceKeyPreparationResultV1, ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import {
  resolveExternalActionServerRequestHeaders,
  type ExternalActionHomeBinding,
} from './externalActionExecutionAuthorization';

type SessionFollowActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

/** One endpoint and credential are captured for the lifetime of this executor. */
export function createSessionFollowActionDeps(input: Readonly<{
  token: string;
  credentials?: StoredCredentials;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  serverHttpBaseUrl?: string;
  /** Lane 09 supplies this only after Lane 13 verifies the scoped Machine carrier. */
  prepareSourceKeyAfterSet?: (input: Readonly<{
    sourceSessionId: string;
    destinationSessionId: string;
    context: Parameters<NonNullable<ActionExecutorDeps['sessionFollowAction']>>[0]['context'];
    signal?: AbortSignal;
  }>) => Promise<SessionFollowSourceKeyPreparationResultV1>;
}> & ExternalActionHomeBinding & SessionFollowActionFixedHome): Pick<ActionExecutorDeps, 'sessionFollowAction' | 'readSessionFollowRules'> & Readonly<{
  replaceSessionVoiceInclusions: (args: Readonly<{
    context: Parameters<NonNullable<ActionExecutorDeps['sessionTargetTrackedSet']>>[0]['context'];
    sessionIds: readonly string[];
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ ok: true; sessionIds: readonly string[] }> | Readonly<{ ok: false }>>;
}> {
  if (
    (input.serverId === undefined) !== (input.serverHttpBaseUrl === undefined)
    || (input.serverId !== undefined && input.serverId.trim().length === 0)
    || (input.serverHttpBaseUrl !== undefined && input.serverHttpBaseUrl.trim().length === 0)
  ) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  const serverHttpBaseUrl = input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const serverId = input.serverId ?? configuration.activeServerId;
  const ruleAccess = (context: ActionExecutorContext, effectActionId: string, privateRuleOperation: boolean, signal?: AbortSignal) => {
    const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
    const root = ActionIdSchema.safeParse(context.externalActionExecutionAuthorization?.binding.actionId);
    const readActionId = root.success && isSessionTargetPreparationAction(root.data) ? root.data : effectActionId;
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      if (privateRuleOperation && (requester ? !await requester.isCurrent() : input.isCredentialCurrent && !await input.isCredentialCurrent())) {
        throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
      }
    };
    const authorize = (request: Readonly<{ method: 'GET' | 'PUT' | 'DELETE'; path: string; body?: unknown }>) => resolveExternalActionServerRequestHeaders({
      context, effectActionId: request.method === 'GET' ? readActionId : effectActionId, method: request.method, path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      daemonToken: input.token, serverIdentityId: input.serverIdentityId,
      ...(input.externalActionMachineRequestPrivateKey ? { privateKey: input.externalActionMachineRequestPrivateKey } : {}),
      ...(input.externalActionMachineInstallationId ? { installationId: input.externalActionMachineInstallationId } : {}),
    });
    const captureRuleStorage = async (usage: 'identity' | 'fresh-authority' = 'fresh-authority') => {
      await assertCurrent();
      const credentials = requester?.credentials ?? input.credentials;
      const requesterAccountId = context.externalActionExecutionAuthorization?.binding.accountId;
      if (!credentials || context.externalActionCredential && !requester
        || context.runtimeAccountId && readAccountIdFromToken(credentials.token) !== context.runtimeAccountId
        || (requesterAccountId ? !requester || readAccountIdFromToken(credentials.token) !== requesterAccountId
        || requester.serverHttpBaseUrl.replace(/\/+$/, '') !== serverHttpBaseUrl.replace(/\/+$/, '')
        : credentials.token !== input.token)) {
        throw Object.assign(new Error('follow_rule_account_scope_unavailable'), { code: 'follow_rule_account_scope_unavailable' });
      }
      const authorization = authorize({ method: 'GET', path: '/v1/account/encryption/currentness' });
      if (!authorization.ok) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      const admitted = await resolveCliAccountStorageContext({ credentials, serverBaseUrl: serverHttpBaseUrl,
        usage, authorizationHeaders: authorization.headers, ...(signal ? { signal } : {}) });
      await assertCurrent();
      return admitted;
    };
    const openRule = ({ content, ...rule }: SessionFollowRuleV1, admitted: Awaited<ReturnType<typeof captureRuleStorage>>) => {
      const opened = openSessionFollowRuleContentV1({ ruleId: rule.ruleId, receiver: rule.receiver,
        content, mode: admitted.mode, material: admitted.material });
      if (opened.status !== 'opened') throw Object.assign(new Error(opened.reason), { code: opened.reason });
      return { ...rule, definition: opened.definition };
    };
    const readRules = async () => {
      const admitted = await captureRuleStorage('identity');
      const authorization = authorize({ method: 'GET', path: SESSION_FOLLOW_RULES_ROUTE_V1 });
      if (!authorization.ok) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      await assertCurrent();
      const response = await axios.request<unknown>({ url: `${serverHttpBaseUrl}${SESSION_FOLLOW_RULES_ROUTE_V1}`, method: 'GET',
        headers: authorization.headers, ...(signal ? { signal } : {}), validateStatus: () => true });
      await assertCurrent();
      if (response.status < 200 || response.status >= 300) throw createHttpStatusError(response.status, 'Follow rule list failed');
      const rules = ListSessionFollowRulesResponseV1Schema.parse(response.data).rules.map(rule => openRule(rule, admitted));
      const current = await captureRuleStorage();
      if (current.mode !== admitted.mode) throw Object.assign(new Error('account-mode-mismatch'), { code: 'account-mode-mismatch' });
      return rules;
    };
    return { assertCurrent, authorize, captureRuleStorage, openRule, readRules };
  };
  return {
    readSessionFollowRules: async ({ context, serverId: requestedServerId, signal }) => {
      if (!await isServerProfileHomeIdentity(serverId, requestedServerId)
        || context.serverId && !await isServerProfileHomeIdentity(serverId, context.serverId)) return { kind: 'unavailable' };
      try {
        const access = ruleAccess(context, 'follow.list', true, signal);
        return { kind: 'complete', rules: await access.readRules() };
      } catch {
        signal?.throwIfAborted();
        return { kind: 'unavailable' };
      }
    },
    replaceSessionVoiceInclusions: async ({ context, sessionIds, signal }) => {
      const path = SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions;
      const body = { sessionIds: [...sessionIds] };
      const authorization = resolveExternalActionServerRequestHeaders({
        context,
        effectActionId: 'session.target.tracked.set',
        method: 'PUT',
        path,
        body,
        daemonToken: input.token,
        serverIdentityId: input.serverIdentityId,
        ...(input.externalActionMachineRequestPrivateKey ? { privateKey: input.externalActionMachineRequestPrivateKey } : {}),
        ...(input.externalActionMachineInstallationId ? { installationId: input.externalActionMachineInstallationId } : {}),
      });
      if (!authorization.ok) return { ok: false };
      const response = await axios.request<unknown>({
        url: `${serverHttpBaseUrl}${path}`,
        method: 'PUT',
        data: body,
        headers: { ...authorization.headers, 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {}),
        validateStatus: () => true,
      });
      const parsed = ReplaceSessionVoiceInclusionsResponseSchema.safeParse(response.data);
      return response.status >= 200 && response.status < 300 && parsed.success
        ? { ok: true, sessionIds: parsed.data.sessionIds }
        : { ok: false };
    },
    sessionFollowAction: async ({ context, actionId, input: actionInput, serverId: requestedServerId, signal }) => {
      if ((requestedServerId && !await isServerProfileHomeIdentity(serverId, requestedServerId))
        || (context.serverId && !await isServerProfileHomeIdentity(serverId, context.serverId))) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const listInput = actionId === 'follow.list' ? SessionFollowActionInputSchemasV1['follow.list'].parse(actionInput) : null;
      const parsedInput = listInput ?? SessionFollowActionInputSchemasV1[actionId].parse(actionInput);
      const source = 'source' in parsedInput ? parsedInput.source : null;
      const privateRuleOperation = source?.kind === 'rule' || listInput?.direction === 'following';
      const { assertCurrent, authorize, captureRuleStorage, openRule, readRules } = ruleAccess(context, actionId, privateRuleOperation, signal);
      const ruleTarget = source?.kind === 'rule' && 'receiver' in parsedInput
        ? { ruleId: source.ruleId, receiver: FollowReceiverRefV1Schema.parse(parsedInput.receiver) } : null;
      const storage = ruleTarget && actionId !== 'follow.remove' ? await captureRuleStorage() : null;
      const ruleSet = ruleTarget && actionId === 'follow.set' ? FollowRuleSetActionInputV1Schema.parse(actionInput) : null;
      const ruleContent = ruleSet && storage
        ? sealSessionFollowRuleContentV1({ ruleId: ruleSet.source.ruleId, receiver: FollowReceiverRefV1Schema.parse(ruleSet.receiver),
          definition: SessionFollowRuleDefinitionV1Schema.parse({ ...ruleSet.ruleDefinition, policy: ruleSet.policy }),
          mode: storage.mode, material: storage.material }) : undefined;
      const request = resolveSessionFollowActionRequest(actionId, actionInput, { ...(ruleContent ? { ruleContent } : {}) });
      const authorization = authorize(request);
      if (!authorization.ok) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      await assertCurrent();
      const response = await axios.request<unknown>({
        url: `${serverHttpBaseUrl}${request.path}`,
        method: request.method,
        ...(request.body === undefined ? {} : { data: request.body }),
        headers: { ...authorization.headers, ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(signal ? { signal } : {}),
        validateStatus: () => true,
      });
      await assertCurrent();
      if (response.status < 200 || response.status >= 300) {
        const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, response.data);
        if (scopeDenial) return scopeDenial;
        const failure = ruleTarget ? SessionFollowRuleErrorResponseV1Schema.safeParse(response.data) : actionId.startsWith('session.delivery.mute.')
          ? DeliveryMuteErrorResponseV1Schema.safeParse(response.data)
          : SessionFollowSourcesErrorResponseSchema.safeParse(response.data);
        if (failure.success) return { ok: false, errorCode: failure.data.error, error: failure.data.error };
        if ([404, 405, 501].includes(response.status)) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        if (isAuthenticationStatus(response.status)) throw createAuthenticationHttpStatusError(response.status, 'Follow Action authentication failed');
        throw createHttpStatusError(response.status, 'Follow Action request failed');
      }
      if (ruleTarget && storage && (actionId === 'follow.get' || actionId === 'follow.set')) {
        const rule = actionId === 'follow.get' ? GetSessionFollowRuleResponseV1Schema.parse(response.data).rule
          : SetSessionFollowRuleResponseV1Schema.parse(response.data).rule;
        if (rule && (rule.ruleId !== ruleTarget.ruleId
          || !equalFollowRuleReceiverV1(rule.receiver, ruleTarget.receiver))) throw new Error('session_follow_response_target_mismatch');
        return parseSessionFollowActionResponse(actionId, actionInput, { rule: rule ? openRule(rule, storage) : null });
      }
      if (listInput?.direction === 'following') {
        const receiver = FollowReceiverRefV1Schema.parse(listInput.receiver);
        // The rule owner supplies a complete private census on the first page;
        // continuation belongs to the source list and must not repeat rules.
        const rules = listInput.cursor === undefined && listInput.sourceKinds === undefined
          ? (await readRules()).filter(rule => equalFollowRuleReceiverV1(rule.receiver, receiver)) : [];
        const rows = listInput.receiver.kind === 'account'
          ? { ...ListAccountSessionFollowsResponseV1Schema.parse(response.data), sources: [] }
          : { follows: [], ...ListSessionFollowSourcesResponseSchema.parse(response.data) };
        return parseSessionFollowActionResponse('follow.list', actionInput, { ...rows, rules,
          coverage: rows.continuation ? 'partial' : 'complete' });
      }
      const setInput = actionId === 'follow.set' ? SessionFollowActionInputSchemasV1['follow.set'].parse(actionInput) : null;
      if (setInput?.source.kind === 'session' && setInput.receiver.kind === 'session') {
        const parsed = SetSessionFollowSourceResponseSchema.parse(parseSessionFollowActionResponse(actionId, actionInput, response.data));
        const prepare = input.prepareSourceKeyAfterSet;
        if (prepare) {
          let preparation: SessionFollowSourceKeyPreparationResultV1;
          try {
            preparation = await prepare({
              sourceSessionId: setInput.source.sessionId,
              destinationSessionId: parsed.source.destinationSessionId,
              context,
              ...(signal ? { signal } : {}),
            });
          } catch {
            preparation = { kind: 'waiting', reason: 'runner_unreachable' };
          }
          return projectSessionFollowSourceKeyPreparationAfterSetV1(parsed, preparation);
        }
        return projectSessionFollowSourceKeyPreparationAfterSetV1(parsed, {
          kind: 'waiting',
          reason: 'source_key_unavailable',
        });
      }
      return parseSessionFollowActionResponse(actionId, actionInput, response.data);
    },
  };
}

/** Released tracked-target adapter. Its Set is attempt-local presentation only;
 * every eligibility write delegates to canonical exact-Home Account Follow. */
export function createSessionTrackedTargetCompatibilityDep(input: Readonly<{
  serverId: string;
  replaceSessionVoiceInclusions: ReturnType<typeof createSessionFollowActionDeps>['replaceSessionVoiceInclusions'];
}>): Pick<ActionExecutorDeps, 'sessionTargetTrackedSet'> {
  return {
    sessionTargetTrackedSet: async (targets) => {
      const requestedAddresses = ('sessionAddresses' in targets
        ? targets.sessionAddresses
        : targets.sessionIds.map((sessionId) => ({ serverId: input.serverId, sessionId })))
        .map((address) => ({ serverId: address.serverId.trim(), sessionId: address.sessionId.trim() }));
      const homes = [...new Set(requestedAddresses.map(address => address.serverId))];
      if ((await Promise.all(homes.map(home => isServerProfileHomeIdentity(input.serverId, home)))).some(admitted => !admitted)
        || (targets.context.serverId && !await isServerProfileHomeIdentity(input.serverId, targets.context.serverId))) {
        return {
          ok: false as const,
          status: 'unavailable' as const,
          error: {
            code: 'session_follow_unavailable' as const,
            message: 'Include in Voice can only be changed on this command\'s Home.',
          },
        };
      }
      const addresses = [...new Map(requestedAddresses.map((address) => [address.sessionId, address] as const)).values()]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
      const replaced = await input.replaceSessionVoiceInclusions({
        context: targets.context,
        sessionIds: addresses.map(address => address.sessionId),
        ...(targets.signal ? { signal: targets.signal } : {}),
      });
      if (!replaced.ok) return {
        ok: false as const,
        status: 'unavailable' as const,
        error: { code: 'session_follow_unavailable' as const, message: 'Include in Voice could not be updated.' },
      };
      const homeServerId = await resolveServerProfileHomeIdentityId(input.serverId) ?? input.serverId;
      return {
        ok: true as const,
        status: 'ok' as const,
        sessionIds: [...replaced.sessionIds],
        sessionAddresses: replaced.sessionIds.map(sessionId => ({ serverId: homeServerId, sessionId })),
        sessions: [],
      };
    },
  };
}
