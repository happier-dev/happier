import type {
  SessionContextUsageSnapshotV1,
  SessionMessageRole,
  UsageObservationScope,
  ProviderTranscriptDispatchRequestV1,
} from '@happier-dev/protocol';

export type RuntimeOutboundTranscriptToolProtocolV1 = 'acp' | 'claude' | 'codex';

export type RuntimeOutboundTranscriptToolNormalizationV1 = Readonly<{
  normalizeToolCallV2: (params: Readonly<{
    protocol: RuntimeOutboundTranscriptToolProtocolV1;
    provider: string;
    toolName: string;
    rawInput: unknown;
    callId?: string;
  }>) => Readonly<{
    canonicalToolName: string;
    input: unknown;
  }>;
  normalizeToolResultV2: (params: Readonly<{
    protocol: RuntimeOutboundTranscriptToolProtocolV1;
    provider: string;
    rawToolName: string;
    canonicalToolName: string;
    rawOutput: unknown;
  }>) => unknown;
}>;

export type RuntimeOutboundTranscriptDispatchInputV1 = Readonly<{
  body: ProviderTranscriptDispatchRequestV1['body'];
  meta?: ProviderTranscriptDispatchRequestV1['meta'];
  metadata?: Record<string, unknown> | null;
  /**
   * Happier session id for the dispatch. Optional and provider-agnostic; a provider facet may use it
   * to consult per-session runtime state (e.g. the Claude CWF4 workflow-owned work-state registry)
   * without re-deriving identity from metadata.
   */
  sessionId?: string;
  now?: () => number;
  randomId?: () => string;
  debug?: (message: string, data?: unknown) => void;
  debugLargeJson?: (message: string, data?: unknown) => void;
  toolCallCanonicalNameByProviderAndId?: Map<string, { rawToolName: string; canonicalToolName: string }>;
  permissionToolCallRawInputByProviderAndId?: Map<string, unknown>;
  toolCallInputByProviderAndId?: Map<string, unknown>;
  toolNormalization?: RuntimeOutboundTranscriptToolNormalizationV1;
}>;

export type RuntimeOutboundTranscriptUsageObservationV1 = Readonly<{
  provider: string;
  source: string;
  scope: UsageObservationScope;
  key: string | null;
  modelId: string | null;
  tokens: Readonly<{
    total: number;
    [key: string]: number;
  }> | null;
  cost: Readonly<{
    total: number;
    breakdown?: Readonly<Record<string, number>>;
    [key: string]: number | string | Readonly<Record<string, number>> | undefined;
  }> | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  contextSnapshot?: SessionContextUsageSnapshotV1;
}>;

export type RuntimeOutboundTranscriptPostSendEffectV1 =
  | Readonly<{
    type: 'usageObservation';
    observation: RuntimeOutboundTranscriptUsageObservationV1;
    backendMode?: string | null;
    externalKey?: string | null;
  }>
  | Readonly<{
    type: 'tokenCountUsageObservation';
    provider: string;
    body: unknown;
    backendMode?: string | null;
    externalKey?: string | null;
  }>
  | Readonly<{
    type: 'metadataField';
    fieldId: string;
    value: unknown;
    reason?: string;
    metadataReason?: string;
  }>;

export type RuntimeOutboundTranscriptToolTraceEventV1 = Readonly<{
  protocol: RuntimeOutboundTranscriptToolProtocolV1;
  provider: string;
  kind: string;
  payload: unknown;
  localId?: string;
}>;

export type RuntimeOutboundTranscriptDispatchPlanV1 = Readonly<{
  content: unknown;
  localId: string;
  sidechainId: string | null;
  messageRole: SessionMessageRole;
  logErrorMessage: string;
  outboundShapeLogs?: readonly Readonly<{
    label: string;
    payload: unknown;
  }>[];
  debugLargeJsonLogs?: readonly Readonly<{
    message: string;
    data?: unknown;
  }>[];
  disconnectedLog?: Readonly<{
    context: string;
    details?: Record<string, unknown>;
  }>;
  postSendEffects?: readonly RuntimeOutboundTranscriptPostSendEffectV1[];
  toolTraceEvents?: readonly RuntimeOutboundTranscriptToolTraceEventV1[];
}>;

export type RuntimeOutboundTranscriptDispatchFacetV1 = Readonly<{
  prepareDispatch: (
    input: RuntimeOutboundTranscriptDispatchInputV1,
  ) => RuntimeOutboundTranscriptDispatchPlanV1;
}>;
