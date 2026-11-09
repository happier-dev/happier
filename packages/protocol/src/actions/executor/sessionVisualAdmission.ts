import { ACCOUNT_SETTING_DEFINITIONS } from '../../account/settings/accountSettings.js';
import { SessionSurfaceItemV1Schema, isSessionSurfaceItemIdentityCorrespondingV1, type SessionSurfaceItemV1 } from '../../sessions/board/item.js';
import { readSessionVisualHtmlBodyV1 as readHtmlBody, usesInheritedSessionWidgetNetworkV1 as usesInheritedWidgetNetwork,
  readSessionVisualCapabilitiesV1 as readCapabilities, persistSessionVisualEffectivePolicyV1 as persistEffectivePolicy,
  resolveSessionVisualEffectiveCapabilitiesV1,
} from '../../sessions/board/visualPolicy.js';
import { SessionBoardGetResultV1Schema, SessionBoardItemUpsertInputV1Schema, SessionBoardAuthoredItemUpsertInputV1Schema,
  type SessionBoardItemUpsertInputV1 } from '../../sessions/board/actions.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionHomeEquivalence } from './coreInvocation.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import { formatUiSurfaceActionRequestV1, uiSurfaceNetworkAccessWidensV1 } from '../../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';

export type SessionVisualAdmissionV1 = Readonly<{
  input: SessionBoardItemUpsertInputV1;
  effectiveItem: SessionSurfaceItemV1;
  effectiveNetwork?: Readonly<{ network: 'none' | 'origins' | 'open'; networkOrigins: readonly string[] }>;
  networkCreationApprovalRequired: boolean;
  networkOffNotice: boolean;
  expandsVisualAuthority: boolean;
}>;

async function readVisualAtRevision(deps: ActionExecutorDeps, context: ActionExecutorContext, input: Readonly<{
  sessionId: string; itemId: string; expectedItemRevision: string;
}>, sameHome: ActionHomeEquivalence): Promise<SessionSurfaceItemV1 | ActionExecuteFailure> {
  if (!deps.sessionBoardAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
  const raw = await deps.sessionBoardAction({ actionId: 'session.board.get',
    input: { sessionId: input.sessionId, itemIds: [input.itemId] }, context,
    ...(context.signal ? { signal: context.signal } : {}) });
  if ('ok' in raw && raw.ok === false) return raw;
  const read = SessionBoardGetResultV1Schema.safeParse(raw);
  if (!read.success || context.serverId && !sameHome(read.data.serverId, context.serverId) || read.data.sessionId !== input.sessionId
    || !read.data.capabilities.readTranscript || read.data.incomplete) return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' };
  const row = read.data.items.find(entry => entry.itemId === input.itemId);
  if (!row?.item || !isSessionSurfaceItemIdentityCorrespondingV1(input.itemId, row.item)) return { ok: false, errorCode: 'session_board_item_not_found', error: 'session_board_item_not_found' };
  if (row.revision !== input.expectedItemRevision) return { ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict' };
  return row.item;
}

/** Prepare exact visual content and capability facts; the shared Action policy owns approval. */
export async function readSessionVisualAdmissionV1(
  deps: ActionExecutorDeps, input: SessionBoardItemUpsertInputV1, context: ActionExecutorContext, sameHome: ActionHomeEquivalence, hostReviewedInput = false,
): Promise<SessionVisualAdmissionV1 | ActionExecuteFailure> {
  const incoming = input;
  const copySource = incoming.copySource;
  let normalized = incoming;
  // Authored bytes alongside a copy source are host-materialized input, never
  // proof supplied by the caller. Replay keeps both exact bytes and source scope.
  if (copySource && 'item' in incoming && !hostReviewedInput) {
    return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  }
  if (copySource && !('item' in incoming)) {
    const source = copySource;
    const sessionId = incoming.sessionId ?? context.defaultSessionId;
    if (!sessionId || source.sessionId === sessionId) return { ok: false, errorCode: 'session_board_invalid', error: 'Same-Session visuals use layout Pin instead of a copy' };
    if (!context.serverId || !sameHome(source.serverId, context.serverId)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    const sourceItem = await readVisualAtRevision(deps, context, source, sameHome);
    if ('ok' in sourceItem) return sourceItem;
    const copiedItem = sourceItem.source.kind !== 'widget' ? sourceItem : {
      ...sourceItem, source: { ...sourceItem.source, instance: { ...sourceItem.source.instance, id: incoming.itemId,
        definition: sourceItem.source.instance.definition.kind === 'inline' ? { ...sourceItem.source.instance.definition,
          definition: { ...sourceItem.source.instance.definition.definition, id: incoming.itemId } } : sourceItem.source.instance.definition,
      } },
    };
    normalized = SessionBoardItemUpsertInputV1Schema.parse({ ...incoming, item: { ...copiedItem, destination: incoming.destination } });
  }
  let request = SessionBoardAuthoredItemUpsertInputV1Schema.parse(normalized);
  if (request.item.source.kind === 'hostedHtml' && 'publicationSource' in request.item.source) {
    if (!deps.sessionBoardPrepareItem) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const prepared = await deps.sessionBoardPrepareItem({ input: request, context, ...(context.signal ? { signal: context.signal } : {}) });
    if ('ok' in prepared) return prepared;
    request = SessionBoardAuthoredItemUpsertInputV1Schema.parse(SessionBoardItemUpsertInputV1Schema.parse(prepared));
  }
  const item = SessionSurfaceItemV1Schema.safeParse(request.item);
  if (!item.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  const htmlSource = item.data.source.kind === 'hostedHtml' ? item.data.source.source : readHtmlBody(item.data)?.source;
  if (htmlSource) {
    try {
      // The renderer's bundle owner also validates referenced assets and UTF-8.
      // Refuse an unrenderable executable before it acquires approval custody.
      const { buildArtifactHtmlDocumentV1 } = await import('../../artifacts/artifactHtmlDocumentV1.js');
      buildArtifactHtmlDocumentV1(htmlSource);
    } catch {
      return { ok: false, errorCode: 'invalid_parameters', error: 'Invalid HTML source or bundle assets',
        details: { reason: 'source_invalid', field: 'item.source' } };
    }
  }
  const capabilities = readCapabilities(item.data);
  if (!capabilities) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  const executable = item.data.source.kind === 'hostedHtml' || readHtmlBody(item.data) !== null;
  // Unwired Account reads fail closed. An omitted preference from a proven
  // Account owner uses its canonical ratified default; malformed data uses ask.
  const settingDefinition = ACCOUNT_SETTING_DEFINITIONS.agentHtmlNetworkPolicy;
  const readsCreationPolicy = executable && request.expectedItemRevision === null && !copySource && !hostReviewedInput;
  const rawSetting = readsCreationPolicy && deps.readAgentHtmlNetworkPolicy ? await deps.readAgentHtmlNetworkPolicy({ context }) : undefined;
  const networkSetting = readsCreationPolicy ? deps.readAgentHtmlNetworkPolicy
    ? settingDefinition.schema.parse(rawSetting === undefined ? settingDefinition.default : rawSetting) : 'ask' : null;
  const isCreate = request.expectedItemRevision === null;
  const networkRequested = capabilities.network !== 'none';
  const effective = resolveSessionVisualEffectiveCapabilitiesV1(capabilities, { isCreate, networkSetting });
  const effectiveItem = persistEffectivePolicy(item.data, effective);
  // A copy gains its destination's host access. Existing visuals Ask by default
  // only when adding network reach or host Actions, not for reversible edits.
  // These are facts for the shared policy; its explicit Action waiver still wins.
  let expandsVisualAuthority = Boolean(copySource) || isCreate && effective.actions.length > 0;
  if (!hostReviewedInput && !copySource && request.expectedItemRevision !== null
    && (effective.network !== 'none' || effective.actions.length > 0 || usesInheritedWidgetNetwork(item.data))) {
    const sessionId = request.sessionId ?? context.defaultSessionId;
    if (!sessionId) return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' };
    const previous = await readVisualAtRevision(deps, context, { sessionId, itemId: request.itemId,
      expectedItemRevision: request.expectedItemRevision }, sameHome);
    if ('ok' in previous) return previous;
    const previousCapabilities = readCapabilities(previous);
    if (!previousCapabilities) return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' };
    const previousActions = new Set(previousCapabilities.actions.map(formatUiSurfaceActionRequestV1));
    expandsVisualAuthority = effective.actions.some(action => !previousActions.has(formatUiSurfaceActionRequestV1(action)))
      || effective.actions.length > 0 && effective.hostMethods.includes('executeAction') && !previousCapabilities.hostMethods.includes('executeAction')
      || usesInheritedWidgetNetwork(item.data) && !usesInheritedWidgetNetwork(previous)
      || uiSurfaceNetworkAccessWidensV1(effective, previousCapabilities);
  }
  return { input: { ...request, item: effectiveItem }, effectiveItem,
    ...(usesInheritedWidgetNetwork(item.data) ? {} : { effectiveNetwork: { network: effective.network, networkOrigins: effective.networkOrigins } }),
    networkCreationApprovalRequired: isCreate && networkSetting === 'ask' && networkRequested,
    networkOffNotice: isCreate && networkSetting === 'off' && networkRequested, expandsVisualAuthority };
}
