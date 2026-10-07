import axios from 'axios';
import { applySessionBoardItemPlacementV1, applySessionBoardLayoutOperationV1, resolveSessionBoardItemPlacementDestinationV1, removeSessionBoardItemPlacementsV1 } from '@happier-dev/protocol/sessions/board/layoutOperations';
import { isSessionSurfaceItemSourceCompatible, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board/item';
import { bindSessionBoardMutationRequestV1, classifySessionBoardMutationTransportResultV1, createSessionBoardFailureV1, createSessionBoardOutcomeUnknownFailureV1, projectSessionBoardActionFailureV1, projectSessionBoardAdapterFailureV1, SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1, SessionBoardGetInputV1Schema, SessionBoardItemRemoveInputV1Schema, SessionBoardLayoutUpdateInputV1Schema, SessionBoardItemUpsertInputV1Schema, SessionBoardMutationActionResultV1Schema, projectSessionBoardGetResultV1 } from '@happier-dev/protocol/sessions/board/actions';
import { projectSessionBoardFeatureDecisionFailureV1 } from '@happier-dev/protocol/sessions/board/errors';
import { SessionBoardLayoutV1Schema } from '@happier-dev/protocol/sessions/board/layout';
import { SessionBoardMutationV1Schema } from '@happier-dev/protocol/sessions/board/mutations';
import type { SessionBoardItemPlacementParticipantV1, SessionBoardLayoutV1, SessionBoardReadProjectionEntryV1, SessionBoardActionIdV1 } from '@happier-dev/protocol/sessions/board';
import { SessionSystemRecordListQuerySchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveCliFeatureDecision, resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { readSessionSystemRecordV1, listSessionSystemRecordsV1 } from '@/session/transport/http/sessionSystemRecordsHttp';
import { openSessionSystemRecord, sealSessionSystemRecordContent, validateSessionSystemRecordOpenedContent } from '@/session/systemRecords/sessionSystemRecordCodec';
import {
  resolveExactSessionOrCredentialCryptoContext,
  type SessionTransportEncryptionMaterial,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveExternalActionServerRequestHeaders, type ExternalActionHomeBinding } from '@/api/externalActionExecutionAuthorization';

/** This carrier's issuance witness only: whether axios itself coded the failure. */
function readAxiosFailureCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as Readonly<{ code?: unknown }>).code;
  return typeof code === 'string' ? code.trim().toUpperCase() : null;
}

function didAxiosRequestEnterTransport(error: unknown): boolean {
  return axios.isAxiosError(error) && error.request !== undefined && error.request !== null;
}

type SessionBoardActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

export function createSessionBoardActionDeps(options: Readonly<{
  credentials: StoredCredentials;
  /** Exact Home snapshot already owned by the caller's runtime/connection; never fetched here. */
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  /**
   * Stored-content material this composition already holds for one exact Session.
   *
   * A Runner runs under a Session-scoped runtime principal, so its credentials
   * carry no Account encryption material and the Session key it was bootstrapped
   * with is the only thing that can open its own Board. The provider is asked
   * per Session id and answers `null` for any other Session, so possession never
   * widens beyond the one Session; when it answers, that material decides, and
   * material that does not match the Session's mode still fails closed.
   */
  resolveExactSessionEncryptionMaterial?: (sessionId: string) => SessionTransportEncryptionMaterial | null;
}> & ExternalActionHomeBinding & SessionBoardActionFixedHome): Pick<ActionExecutorDeps, 'sessionBoardAction'> {
  if (
    (options.serverId === undefined) !== (options.serverHttpBaseUrl === undefined)
    || (options.serverId !== undefined && options.serverId.trim().length === 0)
    || (options.serverHttpBaseUrl !== undefined && options.serverHttpBaseUrl.trim().length === 0)
  ) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  const serverId = options.serverId ?? configuration.activeServerId;
  const serverUrl = options.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  async function put(
    actionId: SessionBoardActionIdV1,
    sessionId: string,
    input: unknown,
    intent: unknown,
    context: Parameters<NonNullable<ActionExecutorDeps['sessionBoardAction']>>[0]['context'],
    signal?: AbortSignal,
  ) {
    if (actionId === 'session.board.get') return createSessionBoardFailureV1('unsupported_action');
    const declared = bindSessionBoardMutationRequestV1({ sessionId, mutation: SessionBoardMutationV1Schema.parse(input) });
    const mutation = declared.body;
    const body = JSON.stringify(mutation);
    const path = declared.path;
    const authorization = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId,
      method: declared.method, path, body: mutation, daemonToken: options.credentials.token, serverIdentityId: options.serverIdentityId,
      ...(options.externalActionMachineRequestPrivateKey ? { privateKey: options.externalActionMachineRequestPrivateKey } : {}),
      ...(options.externalActionMachineInstallationId ? { installationId: options.externalActionMachineInstallationId } : {}),
    });
    if (!authorization.ok) return createSessionBoardFailureV1('not_authenticated');
    if (signal?.aborted) return createSessionBoardFailureV1('cancelled');
    let response;
    try { response = await axios.request<unknown>({ url: `${serverUrl}${path}`, method: declared.method,
      data: body, headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorization.headers, 'Content-Type': 'application/json' },
      timeout: configuration.sessionControlHttpTimeoutMs, validateStatus: () => true, signal,
    }); } catch (error) {
      // This carrier owns only its axios witness; whether an issued mutation may have committed
      // is the Protocol seam owner's single decision, shared with the browser carrier, so one
      // sealed mutation cannot mean "offline" here and "outcome unknown" there.
      const code = readAxiosFailureCode(error);
      const issued = didAxiosRequestEnterTransport(error) || (code !== null && code !== 'ERR_CANCELED');
      const disposition = classifyHomeDomainHttpMutationFailureV1({ error, issued, aborted: signal?.aborted === true });
      if (disposition !== 'outcome_unknown') {
        return projectSessionBoardAdapterFailureV1(error, disposition === 'cancelled' ? 'cancelled' : 'offline');
      }
      return createSessionBoardOutcomeUnknownFailureV1({
        actionId, serverId, sessionId, requestBody: body, mutationRequest: mutation, intent,
      });
    }
    const settlement = classifySessionBoardMutationTransportResultV1({
      actionId,
      serverId,
      sessionId,
      intent,
      requestBody: body,
      mutationRequest: mutation,
      status: response.status,
      body: response.data,
    });
    return settlement.kind === 'applied'
      ? { ok: true as const, result: settlement.result }
      : settlement.result;
  }
  const sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']> = async ({ actionId, input, context, signal }) => {
    if (context.serverId && context.serverId !== serverId) return createSessionBoardFailureV1('server_target_mismatch');
    if (signal?.aborted) return createSessionBoardFailureV1('cancelled');
    const parsed = SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
    if (!parsed.success) return createSessionBoardFailureV1('session_board_invalid');
    const common = parsed.data;
    const sessionId = common.sessionId ?? context.defaultSessionId;
    if (!sessionId) return createSessionBoardFailureV1('session_board_invalid');
    const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET'; path: string }>) => {
      const authorization = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId,
        method: request.method, path: request.path, daemonToken: options.credentials.token, serverIdentityId: options.serverIdentityId,
        ...(options.externalActionMachineRequestPrivateKey ? { privateKey: options.externalActionMachineRequestPrivateKey } : {}),
        ...(options.externalActionMachineInstallationId ? { installationId: options.externalActionMachineInstallationId } : {}),
      });
      return authorization.ok ? authorization.headers : null;
    };
    // Exact-Home decision first: only a positive sessions.board decision from the caller's
    // already-owned Home snapshot may widen detail to accessProjectionVersion=1 via the
    // canonical fetchSessionById owner. Missing/malformed/unsupported snapshots retain the
    // released bare owner/direct request; this host never probes here when a resolver exists.
    let decision: Awaited<ReturnType<typeof resolveCliFeatureDecisionForServer>>['decision'];
    let serverSnapshot: CliServerFeaturesSnapshot | undefined;
    if (typeof options.resolveServerFeaturesSnapshot === 'function') {
      try {
        serverSnapshot = await options.resolveServerFeaturesSnapshot();
      } catch {
        serverSnapshot = undefined;
      }
      decision = resolveCliFeatureDecision({
        featureId: 'sessions.board',
        env: process.env,
        ...(serverSnapshot ? { serverSnapshot } : {}),
      });
    } else {
      const resolved = await resolveCliFeatureDecisionForServer({
        featureId: 'sessions.board',
        env: process.env,
        serverUrl,
        ...(context.externalActionCredential ? { resolveAuthorizationHeaders } : {}),
      });
      decision = resolved.decision;
      serverSnapshot = resolved.serverSnapshot;
    }
    if (decision.state !== 'enabled') return projectSessionBoardFeatureDecisionFailureV1(actionId, decision);
    const rawSession = await fetchSessionById({
      token: options.credentials.token,
      serverUrl,
      sessionId,
      ...(serverSnapshot ? { serverFeaturesSnapshot: serverSnapshot } : {}),
      resolveAuthorizationHeaders,
      signal,
    });
    if (!rawSession || rawSession.id !== sessionId) return createSessionBoardFailureV1('session_board_forbidden');
    const capabilities = rawSession.effectiveAccess?.capabilities;
    if (!capabilities?.readTranscript || (actionId !== 'session.board.get' && !capabilities.editSessionRecords)) return createSessionBoardFailureV1('session_board_forbidden');
    const crypto = resolveExactSessionOrCredentialCryptoContext({
      credentials: options.credentials,
      ...(options.resolveExactSessionEncryptionMaterial
        ? { resolveExactSessionEncryptionMaterial: options.resolveExactSessionEncryptionMaterial }
        : {}),
    }, sessionId, rawSession);
    if (!crypto) return createSessionBoardFailureV1('encryption_material_unavailable');
    const transport = { token: options.credentials.token, serverUrl, sessionId, signal, resolveAuthorizationHeaders };
    const layoutAddress = { owner: 'host' as const, namespace: 'surface' as const, kind: 'layout.v1' as const, localId: 'layout' };
    const readLayout = async () => {
      const stored = await readSessionSystemRecordV1({ ...transport, address: layoutAddress });
      return stored ? { revision: stored.revision, document: SessionBoardLayoutV1Schema.parse(openSessionSystemRecord(crypto, stored).content) } : null;
    };
    if (actionId === 'session.board.get') {
      const args = SessionBoardGetInputV1Schema.parse(common);
      const layout = await readLayout();
      const page = args.itemIds === undefined ? await listSessionSystemRecordsV1({ ...transport,
        query: SessionSystemRecordListQuerySchema.parse({ owner: 'host', namespace: 'surface', kind: 'item.v1', limit: args.limit, cursor: args.cursor }),
      }) : null;
      const records = page ? page.records : await Promise.all([...new Set(args.itemIds)].map((localId) => readSessionSystemRecordV1({ ...transport,
        address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId },
      })));
      const entries: SessionBoardReadProjectionEntryV1[] = [];
      for (const record of records) {
        if (!record) { entries.push({ status: 'unavailable' }); continue; }
        try {
          const item = SessionSurfaceItemV1Schema.parse(openSessionSystemRecord(crypto, record).content);
          entries.push({ status: 'ready', itemId: record.address.localId, revision: record.revision, item });
        } catch { entries.push({ status: 'unavailable' }); }
      }
      return projectSessionBoardGetResultV1({ serverId, sessionId, layout, entries,
        ...(args.itemIds !== undefined ? { requestedItemIds: args.itemIds } : {}),
        incomplete: page?.hasNext === true,
        capabilities: { readTranscript: capabilities.readTranscript, editSessionRecords: capabilities.editSessionRecords },
        page: { cursor: page?.nextCursor ?? null, hasNext: page?.hasNext ?? false },
      });
    }
    if (actionId === 'session.board.layout.update' || actionId === 'session.board.item.remove') {
      const args = actionId === 'session.board.layout.update' ? SessionBoardLayoutUpdateInputV1Schema.parse(common) : SessionBoardItemRemoveInputV1Schema.parse(common);
      const current = await readLayout();
      if ((current?.revision ?? null) !== args.expectedLayoutRevision) {
        return projectSessionBoardActionFailureV1({
          error: 'session_board_revision_conflict',
          currentLayoutRevision: current?.revision ?? null,
        });
      }
      const layout = current?.document ?? { v: 1 as const, tabs: [] };
      const edit = 'operation' in args ? applySessionBoardLayoutOperationV1(layout, args.operation) : removeSessionBoardItemPlacementsV1(layout, args.itemId);
      if (!edit.ok) return createSessionBoardFailureV1(edit.error);
      let itemPlacementParticipant: SessionBoardItemPlacementParticipantV1 | undefined;
      if ('operation' in args && args.operation.op === 'item.place') {
        const participant = await readSessionSystemRecordV1({
          ...transport,
          address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: args.operation.itemId },
        });
        if (!participant) return createSessionBoardFailureV1('session_board_item_not_found');
        itemPlacementParticipant = {
          itemId: args.operation.itemId,
          expectedItemRevision: participant.revision,
        };
      }
      const result = await put(actionId, sessionId, { operation: 'operation' in args ? 'update_layout' : 'remove_item', expectedLayoutRevision: args.expectedLayoutRevision,
        layoutContent: sealSessionSystemRecordContent(crypto, validateSessionSystemRecordOpenedContent(layoutAddress, edit.layout, 'plugin_session_record_invalid_request')),
        ...(itemPlacementParticipant ? { itemPlacementParticipant } : {}),
        ...('itemId' in args ? { itemId: args.itemId, expectedItemRevision: args.expectedItemRevision } : {}),
      }, args, context, signal);
      if (!result.ok) return result;
      return SessionBoardMutationActionResultV1Schema.parse({ v: 1, serverId, sessionId, result: result.result, destination: null });
    }
    const args = SessionBoardItemUpsertInputV1Schema.parse(common);
    const itemAddress = { owner: 'host' as const, namespace: 'surface' as const, kind: 'item.v1' as const, localId: args.itemId };
    const current = await readSessionSystemRecordV1({ ...transport, address: itemAddress });
    if ((current?.revision ?? null) !== args.expectedItemRevision) {
      return projectSessionBoardActionFailureV1({
        error: 'session_board_revision_conflict',
        currentItemRevision: current?.revision ?? null,
      });
    }
    if (current) {
      const previous = SessionSurfaceItemV1Schema.parse(openSessionSystemRecord(crypto, current).content);
      if (!isSessionSurfaceItemSourceCompatible(previous, args.item)) return createSessionBoardFailureV1('session_board_source_conflict');
    }
    let layout: SessionBoardLayoutV1 | null = null;
    let expectedLayoutRevision: string | null = null;
    if (args.placement) {
      const currentLayout = await readLayout();
      const document = currentLayout?.document ?? { v: 1 as const, tabs: [] };
      expectedLayoutRevision = currentLayout?.revision ?? null;
      if (args.expectedLayoutRevision !== undefined && args.expectedLayoutRevision !== expectedLayoutRevision) {
        return projectSessionBoardActionFailureV1({ error: 'session_board_revision_conflict', currentLayoutRevision: expectedLayoutRevision });
      }
      const edited = applySessionBoardItemPlacementV1(document, { itemId: args.itemId, placement: args.placement });
      if (!edited.ok) return createSessionBoardFailureV1(edited.error);
      layout = edited.layout;
    }
    const itemContent = sealSessionSystemRecordContent(crypto, validateSessionSystemRecordOpenedContent(itemAddress, args.item, 'plugin_session_record_invalid_request'));
    const request = SessionBoardMutationV1Schema.parse({ operation: 'upsert_item', itemId: args.itemId, expectedItemRevision: args.expectedItemRevision, itemContent,
      ...(layout ? { placement: { expectedLayoutRevision, layoutContent: sealSessionSystemRecordContent(crypto,
        validateSessionSystemRecordOpenedContent(layoutAddress, layout, 'plugin_session_record_invalid_request')) } } : {}),
    });
    const result = await put(actionId, sessionId, request, args, context, signal);
    if (!result.ok) return result;
    return SessionBoardMutationActionResultV1Schema.parse({ v: 1, serverId, sessionId, result: result.result,
      destination: layout && args.placement
        ? resolveSessionBoardItemPlacementDestinationV1(layout, { itemId: args.itemId, placement: args.placement })
        : null,
      preview: { title: args.item.title, sourceKind: args.item.source.kind },
    });
  };
  return { sessionBoardAction: async (args) => {
    try {
      return await sessionBoardAction(args);
    } catch (error) {
      // Record reads reach here too. The shared projection already knows the producer's typed
      // codes, the connection-establishment codes that mean `offline`, and the feature refusal
      // that must carry its operation, so this host adds no second failure table.
      return projectSessionBoardAdapterFailureV1(
        error,
        args.signal?.aborted === true ? 'cancelled' : 'invalid_response',
        args.actionId,
      );
    }
  } };
}
