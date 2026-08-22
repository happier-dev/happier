import {
  buildComposerAttachmentDedupeKeyV1,
  ComposerAttachmentDraftV1Schema,
  ComposerAttachmentInputV1Schema,
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HappierStructuredInputV1Schema,
  RawIngressStructuredInputV1Schema,
  readHappierStructuredInputV1FromMeta,
  sanitizeSessionUserMessageSendMeta,
  SessionMediaMessageMetaV1Schema,
  type ComposerAttachmentDraftV1,
  type ComposerAttachmentInputV1,
  type HappierStructuredInputV1,
  type SessionMediaItemV1,
} from '@happier-dev/protocol';

type MetadataRecord = Record<string, unknown>;

export type SessionStructuredInputAdmissionErrorCode =
  | 'session_structured_input_attachment_invalid'
  | 'session_structured_input_attachment_preparation_required'
  | 'session_structured_input_attachment_preparation_incomplete'
  | 'session_structured_input_attachment_preparation_unexpected'
  | 'session_structured_input_session_media_invalid'
  | 'session_structured_input_dispatch_resolution_forbidden';

/**
 * Typed, pre-persistence rejection from the one Session structured-input admission owner.
 * Callers use this distinction to preserve a draft's stable local identity for correction/retry.
 */
export class SessionStructuredInputAdmissionError extends Error {
  constructor(readonly code: SessionStructuredInputAdmissionErrorCode) {
    super(code);
    this.name = 'SessionStructuredInputAdmissionError';
  }
}

/** Trusted ingress authorization retained for existing local-image references. */
export type SessionStructuredInputAdmissionPolicyV1 = Readonly<{
  allowedLocalImagePaths?: ReadonlySet<string>;
}>;

export type AdmittedSessionStructuredInputV1 = Readonly<{
  text: string;
  meta: MetadataRecord;
  structuredInput: HappierStructuredInputV1 | null;
}>;

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MetadataRecord
    : null;
}

function throwAdmissionFailure(code: SessionStructuredInputAdmissionErrorCode): never {
  throw new SessionStructuredInputAdmissionError(code);
}

function readSelectedRawAttachments(meta: MetadataRecord): readonly ComposerAttachmentDraftV1[] {
  if (
    Object.prototype.hasOwnProperty.call(meta, HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1)
    && !RawIngressStructuredInputV1Schema.safeParse(meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]).success
  ) {
    // The generic normalizer deliberately drops malformed elements for legacy callers. At the
    // Message admission boundary, a supplied structured envelope is authored input and must not
    // become an empty/text-only prompt merely because one of its fields is invalid or exceeds the
    // shared aggregate attachment budget.
    //
    // Ingress is the pre-finalizer shape, so it is parsed with the raw envelope schema: an
    // attachment may still carry a staged-media claim here. The finalizer replaces that claim
    // with a durable SessionMedia reference before the persisted finalized-only envelope is
    // built below, and the instance/aggregate budgets are the same refinement in both.
    throwAdmissionFailure('session_structured_input_attachment_invalid');
  }
  const rawEnvelope = asRecord(meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
  if (rawEnvelope?.resolvedComposerAttachments !== undefined) {
    throwAdmissionFailure('session_structured_input_dispatch_resolution_forbidden');
  }
  if (!rawEnvelope || !Object.prototype.hasOwnProperty.call(rawEnvelope, 'composerAttachments')) {
    return [];
  }
  if (rawEnvelope.v !== 1 || !Array.isArray(rawEnvelope.composerAttachments)) {
    throwAdmissionFailure('session_structured_input_attachment_invalid');
  }
  const rawAttachments = rawEnvelope.composerAttachments;
  if (rawAttachments.length === 0) return [];

  const selected: ComposerAttachmentDraftV1[] = [];
  const instanceIds = new Set<string>();
  const semanticAttachmentKeys = new Set<string>();
  for (const rawAttachment of rawAttachments) {
    const parsed = ComposerAttachmentDraftV1Schema.safeParse(rawAttachment);
    if (!parsed.success) {
      throwAdmissionFailure('session_structured_input_attachment_invalid');
    }
    const semanticKey = buildComposerAttachmentDedupeKeyV1(parsed.data.attachment, parsed.data.key);
    if (instanceIds.has(parsed.data.instanceId) || semanticAttachmentKeys.has(semanticKey)) {
      throwAdmissionFailure('session_structured_input_attachment_invalid');
    }
    instanceIds.add(parsed.data.instanceId);
    semanticAttachmentKeys.add(semanticKey);
    selected.push(parsed.data);
  }
  return selected;
}

function validatePreparedAttachments(params: Readonly<{
  selected: readonly ComposerAttachmentDraftV1[];
  prepared: readonly ComposerAttachmentInputV1[] | undefined;
}>): readonly ComposerAttachmentInputV1[] {
  if (params.selected.length === 0) {
    if ((params.prepared?.length ?? 0) > 0) {
      throwAdmissionFailure('session_structured_input_attachment_preparation_unexpected');
    }
    return [];
  }
  if (!params.prepared) {
    throwAdmissionFailure('session_structured_input_attachment_preparation_required');
  }
  if (params.prepared.length !== params.selected.length) {
    throwAdmissionFailure('session_structured_input_attachment_preparation_incomplete');
  }

  const selectedByInstanceId = new Map(params.selected.map((attachment) => [attachment.instanceId, attachment]));
  const prepared: ComposerAttachmentInputV1[] = [];
  const preparedInstanceIds = new Set<string>();
  for (const rawPrepared of params.prepared) {
    const parsed = ComposerAttachmentInputV1Schema.safeParse(rawPrepared);
    if (!parsed.success) {
      throwAdmissionFailure('session_structured_input_attachment_preparation_incomplete');
    }
    const preparedAttachment = parsed.data;
    const selected = selectedByInstanceId.get(preparedAttachment.instanceId);
    if (
      !selected
      || preparedInstanceIds.has(preparedAttachment.instanceId)
      || selected.attachment.pluginId !== preparedAttachment.attachment.pluginId
      || selected.attachment.localId !== preparedAttachment.attachment.localId
      || selected.key !== preparedAttachment.key
    ) {
      throwAdmissionFailure('session_structured_input_attachment_preparation_incomplete');
    }
    preparedInstanceIds.add(preparedAttachment.instanceId);
    prepared.push(preparedAttachment);
  }
  if (preparedInstanceIds.size !== selectedByInstanceId.size) {
    throwAdmissionFailure('session_structured_input_attachment_preparation_incomplete');
  }
  return prepared;
}

function readSessionMediaMetadata(meta: MetadataRecord): readonly unknown[] {
  return ['happier', 'happierMedia']
    .map((key) => asRecord(meta[key]))
    .filter((candidate): candidate is MetadataRecord => candidate?.kind === 'session_media.v1');
}

export type AdmittedSessionMediaInputForDispatchReadResult = Readonly<
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'admitted'; media: readonly SessionMediaItemV1[] }
>;

function readPreparedSessionMediaReferences(params: Readonly<{
  meta: MetadataRecord;
  prepared: readonly ComposerAttachmentInputV1[];
}>): AdmittedSessionMediaInputForDispatchReadResult {
  const mediaRefs = params.prepared.flatMap((attachment) => (
    attachment.content?.kind === 'sessionMedia' ? [attachment.content.mediaId] : []
  ));
  if (mediaRefs.length === 0) return { status: 'absent' };

  const envelopes = readSessionMediaMetadata(params.meta);
  if (envelopes.length !== 1) return { status: 'invalid' };
  const envelope = SessionMediaMessageMetaV1Schema.safeParse(envelopes[0]);
  if (!envelope.success) return { status: 'invalid' };

  const referencedIds = new Set<string>();
  for (const mediaId of mediaRefs) {
    if (referencedIds.has(mediaId)) return { status: 'invalid' };
    referencedIds.add(mediaId);
  }
  const mediaById = new Map<string, SessionMediaItemV1>();
  for (const item of envelope.data.payload.media) {
    if (
      mediaById.has(item.id)
      || item.role !== 'input'
      || item.category !== 'attachment'
      || item.origin.source !== 'user-upload'
      || typeof item.sha256 !== 'string'
    ) {
      return { status: 'invalid' };
    }
    mediaById.set(item.id, item);
  }
  if (mediaById.size !== referencedIds.size) return { status: 'invalid' };

  const media: SessionMediaItemV1[] = [];
  for (const mediaId of mediaRefs) {
    const item = mediaById.get(mediaId);
    if (!item) return { status: 'invalid' };
    media.push(item);
  }
  return { status: 'admitted', media: Object.freeze(media) };
}

/**
 * A SessionMedia attachment ref is admitted only alongside the single durable
 * SessionMedia envelope the finalizer created for this Message. This stops a
 * caller from turning an arbitrary media id into a Message attachment or from
 * smuggling a second competing media envelope into the persisted metadata.
 */
function validatePreparedSessionMediaReferences(params: Readonly<{
  meta: MetadataRecord;
  prepared: readonly ComposerAttachmentInputV1[];
}>): void {
  if (readPreparedSessionMediaReferences(params).status === 'invalid') {
    throwAdmissionFailure('session_structured_input_session_media_invalid');
  }
}

/**
 * Dispatch reads the exact item set Message admission proved against the
 * Composer refs. It is a reader only: no local path is re-authorized here.
 */
export function readAdmittedSessionMediaInputForDispatchV1(params: Readonly<{
  meta: unknown;
  structuredInput: HappierStructuredInputV1;
}>): AdmittedSessionMediaInputForDispatchReadResult {
  const meta = asRecord(params.meta);
  if (!meta) {
    return (params.structuredInput.composerAttachments ?? []).some(
      (attachment) => attachment.content?.kind === 'sessionMedia',
    )
      ? { status: 'invalid' }
      : { status: 'absent' };
  }
  return readPreparedSessionMediaReferences({
    meta,
    prepared: params.structuredInput.composerAttachments ?? [],
  });
}

/**
 * Early ingress guard for the RPC boundary. It deliberately performs no preparation or durable
 * normalization: that remains at `admitSessionStructuredInputV1` immediately before persistence.
 * Its sole job is to reject malformed authored structured input (including forged attachment
 * identity/resolved data) before a caller allocates or reserves a pending local id.
 */
export function validateSessionStructuredInputIngressV1(params: Readonly<{
  meta: MetadataRecord;
}>): readonly ComposerAttachmentDraftV1[] {
  return readSelectedRawAttachments(params.meta);
}

/**
 * Generic session-input transforms may change text and unrelated metadata, but
 * Composer attachments remain authored Message input until this admission
 * owner validates their prepared result. Re-apply the source selection here
 * so a transform cannot erase, replace, or inject an attachment route.
 */
export function preserveComposerAttachmentSelectionAcrossSessionInputTransformV1(params: Readonly<{
  sourceMeta: MetadataRecord;
  transformedMeta: MetadataRecord | null;
}>): MetadataRecord | null {
  const selected = readSelectedRawAttachments(params.sourceMeta);
  const sourceEnvelope = asRecord(params.sourceMeta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
  const transformedEnvelope = params.transformedMeta
    ? asRecord(params.transformedMeta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1])
    : null;

  // Dispatch-only values are never a raw transform result. Keep the existing
  // fail-closed ingress contract even when a generic hook produced the bytes.
  if (transformedEnvelope?.resolvedComposerAttachments !== undefined) {
    throwAdmissionFailure('session_structured_input_dispatch_resolution_forbidden');
  }

  const sourceHasComposerAttachments = sourceEnvelope
    && Object.prototype.hasOwnProperty.call(sourceEnvelope, 'composerAttachments');
  const transformedHasComposerAttachments = transformedEnvelope
    && Object.prototype.hasOwnProperty.call(transformedEnvelope, 'composerAttachments');
  if (!sourceHasComposerAttachments && !transformedHasComposerAttachments) {
    return params.transformedMeta;
  }

  if (!sourceHasComposerAttachments) {
    // A generic hook has no Composer attachment-selection authority. Preserve
    // all of its other structured-input work while dropping the injected arm.
    const { composerAttachments: _discardedComposerAttachments, ...transformedWithoutComposerAttachments } =
      transformedEnvelope ?? {};
    return {
      ...(params.transformedMeta ?? {}),
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: transformedWithoutComposerAttachments,
    };
  }

  return {
    ...(params.transformedMeta ?? {}),
    [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
      ...(transformedEnvelope ?? {}),
      v: 1,
      composerAttachments: selected,
    },
  };
}

/**
 * The single pre-persistence structured-input admission owner. Runtime preparation and trusted
 * local-path authorization stay with their canonical owners; this function validates their
 * correspondence and emits the canonical envelope that the queue may later consume without
 * re-admission.
 */
export function admitSessionStructuredInputV1(params: Readonly<{
  text: string;
  meta: MetadataRecord;
  admissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
  preparedComposerAttachments?: readonly ComposerAttachmentInputV1[];
}>): AdmittedSessionStructuredInputV1 {
  const rawMeta = { ...params.meta };
  const selected = readSelectedRawAttachments(rawMeta);
  const prepared = validatePreparedAttachments({
    selected,
    prepared: params.preparedComposerAttachments,
  });
  validatePreparedSessionMediaReferences({ meta: rawMeta, prepared });
  const sanitizedMeta = sanitizeSessionUserMessageSendMeta(rawMeta, {
    ...(params.admissionPolicy?.allowedLocalImagePaths
      ? { allowedLocalImagePaths: params.admissionPolicy.allowedLocalImagePaths }
      : {}),
    text: params.text,
  });
  const sanitizedInput = readHappierStructuredInputV1FromMeta(sanitizedMeta, {
    ...(params.admissionPolicy?.allowedLocalImagePaths
      ? { allowedLocalImagePaths: params.admissionPolicy.allowedLocalImagePaths }
      : {}),
  });

  if (selected.length === 0) {
    if (sanitizedInput) {
      sanitizedMeta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1] = sanitizedInput;
    }
    return {
      text: params.text,
      meta: sanitizedMeta,
      structuredInput: sanitizedInput,
    };
  }
  if (!sanitizedInput) {
    // A selected attachment cannot vanish through generic sanitization.
    throwAdmissionFailure('session_structured_input_attachment_invalid');
  }
  const structuredInput = HappierStructuredInputV1Schema.parse({
    ...sanitizedInput,
    composerAttachments: prepared,
  });
  return {
    text: params.text,
    meta: {
      ...sanitizedMeta,
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: structuredInput,
    },
    structuredInput,
  };
}
