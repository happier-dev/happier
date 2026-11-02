import { ACCOUNT_SETTING_DEFINITIONS } from '../../account/settings/accountSettings.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import type { NormalizedUiSurfaceCapabilityRequestV1 } from '../../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { createUiSurfaceExecutableSecurityFingerprintV1, createUiSurfaceRequestedCapabilitiesDigestV1,
  UI_SURFACE_ISOLATION_PROFILE_VERSION_V1 } from '../../plugins/contributions/ui/executableSurfaceApprovalV1.js';
import { SessionSurfaceItemV1Schema, isSessionSurfaceItemIdentityCorrespondingV1, type SessionSurfaceItemV1 } from '../../sessions/board/item.js';
import { readSessionVisualHtmlBodyV1 as readHtmlBody, usesInheritedSessionWidgetNetworkV1 as usesInheritedWidgetNetwork,
  readSessionVisualCapabilitiesV1 as readCapabilities, persistSessionVisualEffectivePolicyV1 as persistEffectivePolicy,
  resolveSessionVisualEffectiveCapabilitiesV1,
} from '../../sessions/board/visualPolicy.js';
import { SessionBoardGetResultV1Schema, SessionBoardItemUpsertInputV1Schema, SessionBoardAuthoredItemUpsertInputV1Schema,
  type SessionBoardItemUpsertInputV1, type SessionVisualReviewedAdmissionV1 } from '../../sessions/board/actions.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionHomeEquivalence } from './coreInvocation.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';

export type SessionVisualAdmissionV1 = Readonly<{
  input: SessionBoardItemUpsertInputV1;
  safety: 'safe' | 'danger';
  effectiveItem: SessionSurfaceItemV1;
  effectiveNetwork?: Readonly<{ network: 'none' | 'origins' | 'open'; networkOrigins: readonly string[] }>;
  networkOffNotice: boolean;
}>;

function reviewedCapabilitiesDigest(item: SessionSurfaceItemV1, capabilities: NormalizedUiSurfaceCapabilityRequestV1) {
  const digest = createUiSurfaceRequestedCapabilitiesDigestV1(capabilities);
  return item.source.kind === 'widget'
    ? computeCanonicalDomainSeparatedDigest('happier:session-visual:widget-capability-review:v1',
        [digest, usesInheritedWidgetNetwork(item) ? 'inherit' : 'explicit'])
    : digest;
}

function executableFingerprint(item: SessionSurfaceItemV1 | null, capabilities: NormalizedUiSurfaceCapabilityRequestV1 | null): string | null {
  if (!item || !capabilities) return null;
  const source = item.source.kind === 'hostedHtml' ? item.source.source : readHtmlBody(item)?.source;
  return source ? createUiSurfaceExecutableSecurityFingerprintV1({ source, isolationProfileVersion: UI_SURFACE_ISOLATION_PROFILE_VERSION_V1,
    network: capabilities.network === 'origins' ? undefined : capabilities.network,
    networkOrigins: capabilities.networkOrigins }) : null;
}

/** Consequence facts for the existing contextualSafety seam, not an approval dispatcher. */
export async function readSessionVisualAdmissionV1(
  deps: ActionExecutorDeps, input: unknown, context: ActionExecutorContext, sameHome: ActionHomeEquivalence, hostReviewedInput = false,
): Promise<SessionVisualAdmissionV1 | ActionExecuteFailure> {
  const incoming = SessionBoardItemUpsertInputV1Schema.parse(input);
  const copySource = 'copySource' in incoming ? incoming.copySource
    : hostReviewedInput ? incoming.reviewedVisual?.copySource : undefined;
  let normalized = incoming;
  if ('copySource' in incoming) {
    const source = incoming.copySource;
    const sessionId = incoming.sessionId ?? context.defaultSessionId;
    if (!sessionId || source.sessionId === sessionId) return { ok: false, errorCode: 'session_board_invalid', error: 'Same-Session visuals use layout Pin instead of a copy' };
    if (!context.serverId || !sameHome(source.serverId, context.serverId)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    if (!deps.sessionBoardAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const raw = await deps.sessionBoardAction({ actionId: 'session.board.get',
      input: { sessionId: source.sessionId, itemIds: [source.itemId] }, context,
      ...(context.signal ? { signal: context.signal } : {}) });
    if ('ok' in raw && raw.ok === false) return raw;
    const read = SessionBoardGetResultV1Schema.safeParse(raw);
    if (!read.success || !sameHome(read.data.serverId, source.serverId) || read.data.sessionId !== source.sessionId
      || !read.data.capabilities.readTranscript || read.data.incomplete) return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' };
    const row = read.data.items.find(entry => entry.itemId === source.itemId);
    if (!row?.item || !isSessionSurfaceItemIdentityCorrespondingV1(source.itemId, row.item)) return { ok: false, errorCode: 'session_board_item_not_found', error: 'session_board_item_not_found' };
    if (row.revision !== source.expectedItemRevision) return { ok: false, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict' };
    const sourceItem = row.item;
    const copiedItem = sourceItem.source.kind !== 'widget' ? sourceItem : {
      ...sourceItem, source: { ...sourceItem.source, instance: { ...sourceItem.source.instance, id: incoming.itemId,
        definition: sourceItem.source.instance.definition.kind === 'inline' ? { ...sourceItem.source.instance.definition,
          definition: { ...sourceItem.source.instance.definition.definition, id: incoming.itemId } } : sourceItem.source.instance.definition,
      } },
    };
    const { copySource: _source, ...operands } = incoming;
    normalized = SessionBoardItemUpsertInputV1Schema.parse({ ...operands, item: { ...copiedItem, destination: incoming.destination } });
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
  const sessionId = request.sessionId ?? context.defaultSessionId;
  let previous: { revision: string; item?: SessionSurfaceItemV1; creator: SessionVisualReviewedAdmissionV1['creator'] } | undefined;
  if (request.expectedItemRevision !== null) {
    if (!deps.sessionBoardAction || !sessionId) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const raw = await deps.sessionBoardAction({ actionId: 'session.board.get', input: { sessionId, itemIds: [request.itemId] }, context,
      ...(context.signal ? { signal: context.signal } : {}) });
    if ('ok' in raw && raw.ok === false) return raw;
    const read = SessionBoardGetResultV1Schema.safeParse(raw);
    if (!read.success || read.data.sessionId !== sessionId || !sameHome(read.data.serverId, context.serverId) || read.data.incomplete) {
      return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' };
    }
    previous = read.data.items.find(entry => entry.itemId === request.itemId);
  }
  const executable = item.data.source.kind === 'hostedHtml' || readHtmlBody(item.data) !== null;
  // Unwired Account reads fail closed. An omitted preference from a proven
  // Account owner uses its canonical ratified default; malformed data uses ask.
  const settingDefinition = ACCOUNT_SETTING_DEFINITIONS.agentHtmlNetworkPolicy;
  const rawSetting = executable && !copySource && deps.readAgentHtmlNetworkPolicy ? await deps.readAgentHtmlNetworkPolicy({ context }) : undefined;
  const networkSetting = executable && !copySource ? deps.readAgentHtmlNetworkPolicy
    ? settingDefinition.schema.parse(rawSetting === undefined ? settingDefinition.default : rawSetting) : 'ask' : null;
  const beforeCapabilities = previous?.item ? readCapabilities(previous.item) : null;
  const reviewed: SessionVisualReviewedAdmissionV1 = {
    networkSetting, recordRevision: previous?.revision ?? null, creator: previous?.creator ?? { kind: 'unknown' },
    previousCapabilitiesDigest: previous?.item && beforeCapabilities ? reviewedCapabilitiesDigest(previous.item, beforeCapabilities) : null,
    previousExecutableFingerprint: executableFingerprint(previous?.item ?? null, beforeCapabilities),
    ...(copySource ? { copySource } : {}),
  };
  if (request.reviewedVisual && !sameStrictJsonValue(request.reviewedVisual, reviewed)) {
    return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
  }
  const isCreate = request.expectedItemRevision === null;
  const ownSession = context.actionCaller?.kind === 'session' && context.actionCaller.sessionId === sessionId;
  const ownCreated = isCreate || previous?.creator.kind === 'session' && context.actionCaller?.kind === 'session'
    && previous.creator.sessionId === context.actionCaller.sessionId;
  const networkChanged = !isCreate && (!beforeCapabilities
    || previous?.item && usesInheritedWidgetNetwork(item.data) !== usesInheritedWidgetNetwork(previous.item)
    || capabilities.network !== beforeCapabilities.network
    || !sameStrictJsonValue(capabilities.networkOrigins, beforeCapabilities.networkOrigins));
  const networkRequested = capabilities.network !== 'none';
  const effective = resolveSessionVisualEffectiveCapabilitiesV1(capabilities, { isCreate, networkSetting });
  const safety = !copySource && ownSession && ownCreated && (isCreate || previous?.revision === request.expectedItemRevision)
    && item.data.source.kind !== 'walkthrough' && capabilities.actions.length === 0 && !networkChanged
    && !(isCreate && networkRequested && networkSetting === 'ask') ? 'safe' : 'danger';
  return { input: { ...request, reviewedVisual: reviewed }, safety,
    effectiveItem: persistEffectivePolicy(item.data, effective),
    ...(usesInheritedWidgetNetwork(item.data) ? {} : { effectiveNetwork: { network: effective.network, networkOrigins: effective.networkOrigins } }),
    networkOffNotice: isCreate && networkSetting === 'off' && networkRequested };
}
