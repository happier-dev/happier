import { randomUUID } from 'node:crypto';

import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { writeSessionStateFieldWithMetadataPortBestEffort } from '@/agent/runtime/state/writeSessionStateFieldWithMetadataPort';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import type {
  SessionStateApplyReason,
  SessionStateFieldWriteValue,
  RuntimeOutboundTranscriptDispatchFacetV1,
  RuntimeOutboundTranscriptDispatchPlanV1,
  RuntimeOutboundTranscriptPostSendEffectV1,
  RuntimeOutboundTranscriptToolTraceEventV1,
} from '@happier-dev/agents';
import {
  readRuntimeDescriptorV1FromMetadata,
  SessionStateFieldIdSchema,
  type SessionStateFieldId,
} from '@happier-dev/protocol';

import type { Metadata } from '../../types';
import { buildLegacyUsageReportFromUsageObservation, type UsageObservation } from '../../../usage/usageObservation';
import { buildAcpAgentMessageEnvelope } from '../acpMessageEnvelope';
import type {
  ACPMessageData,
  ACPProvider,
} from '../sessionMessageTypes';
import { normalizeAcpSessionMessageBody } from '../sessionOutboundMessageNormalization';
import { resolveAcpSessionMessageRole } from '../messageRole';
import { extractAssistantTextSnapshotFromSessionContent } from '../turns/extractAssistantTextSnapshot';
import type { PostSendReactionPort } from '../client/reactions/providers/postSendReactionPort';
import { publishTokenCountUsageObservation } from '../client/reactions/usagePublishing';
import type { SessionClientTranscriptSendPort } from '../client/transcript/sendMessages';
import { readSidechainId } from './shared';

export class RuntimeOutboundTranscriptDispatchUnavailableError extends Error {
  readonly code = 'runtime_outbound_transcript_dispatch_unavailable';
  readonly backendId: string | null;

  constructor(params: Readonly<{ backendId: string | null }>) {
    super(params.backendId
      ? `Runtime backend "${params.backendId}" does not expose an outbound transcript dispatch facet.`
      : 'Session runtime metadata does not expose a selected runtime backend for outbound transcript dispatch.');
    this.name = 'RuntimeOutboundTranscriptDispatchUnavailableError';
    this.backendId = params.backendId;
  }
}

export type TranscriptDispatchToolMaps = Readonly<{
  toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
  permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
  toolCallInputByProviderAndId: Map<string, unknown>;
}>;

export type RuntimeOutboundTranscriptDispatchFacetResolution = Readonly<{
  backendId: string;
  facet: RuntimeOutboundTranscriptDispatchFacetV1;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readRuntimeOutboundTranscriptDispatchBackendId(metadata: unknown): string | null {
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const providerExtra = asRecord(descriptor?.provider.providerExtra);
  const runtimeHandle = asRecord(providerExtra?.runtimeHandle);
  return readNonEmptyString(runtimeHandle?.backendId);
}

export async function resolveRuntimeOutboundTranscriptDispatchFacet(params: Readonly<{
  metadata: Metadata | null;
}>): Promise<RuntimeOutboundTranscriptDispatchFacetResolution | null> {
  const backendId = readRuntimeOutboundTranscriptDispatchBackendId(params.metadata);
  if (!backendId) return null;

  const resolution = await resolveBackendEngineAdapterResolution(backendId);
  const facet = resolution?.engineAdapter.facets?.transcriptDispatch;
  return facet ? { backendId, facet } : null;
}

export function prepareAcpTranscriptDispatch(params: Readonly<{
  provider: ACPProvider;
  body: ACPMessageData;
  meta?: Record<string, unknown>;
  localId?: string;
}> & TranscriptDispatchToolMaps): Readonly<{
  normalizedBody: ACPMessageData;
  content: ReturnType<typeof buildAcpAgentMessageEnvelope>;
  localId: string;
  sidechainId: string | null;
}> {
  const normalizedBody = normalizeAcpSessionMessageBody({
    provider: params.provider,
    body: params.body,
    toolCallCanonicalNameByProviderAndId: params.toolCallCanonicalNameByProviderAndId,
    permissionToolCallRawInputByProviderAndId: params.permissionToolCallRawInputByProviderAndId,
    toolCallInputByProviderAndId: params.toolCallInputByProviderAndId,
  });
  const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();
  const sidechainId = readSidechainId(normalizedBody.sidechainId);
  const content = buildAcpAgentMessageEnvelope({
    provider: params.provider,
    body: normalizedBody,
    meta: params.meta,
  });

  return {
    normalizedBody,
    content,
    localId,
    sidechainId,
  };
}

export function commitRuntimeOutboundTranscriptDispatchPlan(
  port: SessionClientTranscriptSendPort,
  plan: RuntimeOutboundTranscriptDispatchPlanV1,
): void {
  for (const log of plan.outboundShapeLogs ?? []) {
    port.outboundShapeLogger.log(log.label, log.payload);
  }
  for (const log of plan.debugLargeJsonLogs ?? []) {
    port.debugLargeJson(log.message, log.data);
  }
  if (plan.disconnectedLog) {
    port.logSendWhileDisconnected(plan.disconnectedLog.context, plan.disconnectedLog.details);
  }

  const payload = port.buildOutboundSessionMessagePayload(plan.content);
  port.commitSessionMessageBestEffort({
    message: payload,
    localId: plan.localId,
    sidechainId: plan.sidechainId,
    messageRole: plan.messageRole,
    logErrorMessage: plan.logErrorMessage,
  });

  const extracted = extractAssistantTextSnapshotFromSessionContent(plan.content);
  if (extracted) {
    port.turnAssistantTextSnapshotStore?.observe({
      text: extracted.text,
      provider: extracted.provider,
      sidechainId: extracted.sidechainId,
      localId: plan.localId,
      source: 'provider-dispatch',
    });
  }
}

function isDisplayTitleValue(value: unknown): value is Readonly<{ title: string; updatedAt: number }> {
  const record = asRecord(value);
  return typeof record?.title === 'string'
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt);
}

function readSessionStateApplyReason(value: unknown): SessionStateApplyReason {
  return value === 'user-mutation' || value === 'spawn' || value === 'reconciliation'
    ? value
    : 'reconciliation';
}

function applyMetadataFieldEffect(
  port: PostSendReactionPort,
  effect: Extract<RuntimeOutboundTranscriptPostSendEffectV1, { type: 'metadataField' }>,
): void {
  const parsedFieldId = SessionStateFieldIdSchema.safeParse(effect.fieldId);
  if (!parsedFieldId.success) {
    return;
  }
  const fieldId = parsedFieldId.data;

  if (fieldId === 'display.title' && !isDisplayTitleValue(effect.value)) {
    return;
  }

  writeSessionStateFieldWithMetadataPortBestEffort({
    sessionId: port.sessionId,
    fieldId,
    value: effect.value as SessionStateFieldWriteValue<SessionStateFieldId>,
    updateMetadata: port.updateMetadata,
    reason: readSessionStateApplyReason(effect.reason),
    metadataReason: effect.metadataReason ?? 'runtime_outbound_transcript_dispatch',
  });
}

function applyUsageObservationEffect(
  port: PostSendReactionPort,
  effect: Extract<RuntimeOutboundTranscriptPostSendEffectV1, { type: 'usageObservation' }>,
): void {
  try {
    logger.debugLargeJson('[SOCKET] Sending usage data:', buildLegacyUsageReportFromUsageObservation({
      sessionId: port.sessionId,
      observation: effect.observation as UsageObservation,
    }));
    void port.usageObservationPublisher.publish({
      sessionId: port.sessionId,
      observation: effect.observation as UsageObservation,
      backendMode: effect.backendMode ?? null,
      externalKey: effect.externalKey ?? null,
    }).catch((error) => {
      logger.debug('[SOCKET] Failed to send usage data:', serializeAxiosErrorForLog(error));
    });
  } catch (error) {
    logger.debug('[SOCKET] Failed to send usage data:', serializeAxiosErrorForLog(error));
  }
}

export function applyRuntimeOutboundTranscriptPostSendEffects(
  port: PostSendReactionPort,
  effects: readonly RuntimeOutboundTranscriptPostSendEffectV1[] | undefined,
): void {
  for (const effect of effects ?? []) {
    switch (effect.type) {
      case 'usageObservation':
        applyUsageObservationEffect(port, effect);
        break;
      case 'tokenCountUsageObservation':
        void publishTokenCountUsageObservation({
          sessionId: port.sessionId,
          publisher: port.usageObservationPublisher,
          provider: effect.provider,
          body: effect.body,
          backendMode: effect.backendMode ?? null,
          externalKey: effect.externalKey ?? null,
        });
        break;
      case 'metadataField':
        applyMetadataFieldEffect(port, effect);
        break;
    }
  }
}

export function recordRuntimeOutboundTranscriptToolTraceEvents(
  sessionId: string,
  events: readonly RuntimeOutboundTranscriptToolTraceEventV1[] | undefined,
): void {
  for (const event of events ?? []) {
    recordToolTraceEvent({
      direction: 'outbound',
      sessionId,
      protocol: event.protocol,
      provider: event.provider,
      kind: event.kind,
      payload: event.payload,
      localId: event.localId,
    });
  }
}

export function buildAcpRuntimeOutboundTranscriptDispatchPlan(params: Readonly<{
  provider: ACPProvider;
  body: ACPMessageData;
  meta?: Record<string, unknown>;
  localId?: string;
}> & TranscriptDispatchToolMaps): RuntimeOutboundTranscriptDispatchPlanV1 & Readonly<{
  normalizedBody: ACPMessageData;
}> {
  const prepared = prepareAcpTranscriptDispatch(params);
  return {
    normalizedBody: prepared.normalizedBody,
    content: prepared.content,
    localId: prepared.localId,
    sidechainId: prepared.sidechainId,
    messageRole: resolveAcpSessionMessageRole(prepared.normalizedBody),
    logErrorMessage: '[SOCKET] Failed to commit agent message (non-fatal)',
    outboundShapeLogs: [{
      label: `acp:${params.provider}:${prepared.normalizedBody.type}`,
      payload: prepared.normalizedBody,
    }],
    disconnectedLog: {
      context: `${params.provider} ACP message`,
      details: { type: prepared.normalizedBody.type },
    },
  };
}
