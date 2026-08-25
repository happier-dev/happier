import {
  ExternalSessionOperationAuthorIntentV1Schema,
  ExternalSessionRefSchema,
  ExternalSessionTakeoverStartInputV1Schema,
  type ExternalSessionOperationAuthorIntentV1,
  type ExternalSessionOperationReferenceV1,
  type ExternalSessionTakeoverStartInputV1,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
  type PluginAgentExternalLinkedTakeoverWriterSafetyV1,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
  resolveExternalSessionPluginOperationPreflightAdmission,
  type ExternalSessionPluginOperationPreflightAdmission,
} from '@/session/actions/externalSessions/operationRecordStore';
import type { ExternalSessionPluginTakeoverStartActionExecutor } from '@/session/actions/externalSessions/takeoverStartAction';

import type { HostExternalSessionRef } from './privateContract';
import { deriveExternalSessionPluginOperationDurableKey } from './pluginOperationDurableKey';

export type ContextualExternalSessionTakeoverRequest = Readonly<{
  targetStorageMode: 'external-linked' | 'persisted';
  idempotencyKey: string;
}>;

export type ContextualExternalSessionTakeoverResolution = Readonly<{
  source: ExternalSessionsSource;
  /**
   * Static Agent-leaf evidence for the continuing single-writer contract of an
   * external-linked takeover (C2). It is resolved with the source because both
   * are facts of the same current configured source, and it must be known
   * before any link or durable Start effect: an `unsupported` Agent may never
   * reach the admitting phase runner with a committed link behind it.
   */
  externalLinkedTakeoverWriterSafety:
    PluginAgentExternalLinkedTakeoverWriterSafetyV1;
}>;

export type ContextualExternalSessionTakeoverAdapter = Readonly<{
  takeover(
    ref: HostExternalSessionRef,
    request: ContextualExternalSessionTakeoverRequest,
    options?: ContextualExternalSessionTakeoverOptions,
  ): Promise<ExternalSessionOperationReferenceV1>;
}>;

export type ContextualExternalSessionTakeoverOptions = Readonly<{
  signal?: AbortSignal;
  retirementSignal?: AbortSignal;
  isCurrent?: () => boolean;
}>;

export type ContextualExternalSessionTakeoverDependencies = Readonly<{
  activeServerDir: string;
  pluginId: string;
  resolveCurrentSource(
    ref: HostExternalSessionRef,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ContextualExternalSessionTakeoverResolution>;
  ensureLink(input: Readonly<{
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ sessionId: string }>>;
  /**
   * Projects one durable `{pluginId, localId}` Agent identity onto the host
   * routing id public refs carry. The derived private request names the Agent
   * by its durable identity while `ref.agentId` is the routing id, and only
   * the plugin registry relates them: an installed Agent is routed by its
   * qualified key while a bundled one keeps its unqualified released id.
   * Comparing the two directly silently only ever matched bundled Agents.
   */
  resolveAgentRoutingId(
    agent: PluginContributionIdentityV1,
  ): Promise<ExternalSessionsAgentId | null>;
  deriveTakeoverStartRequest(input: Readonly<{
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    sessionId: string;
    targetStorageMode: 'external-linked' | 'persisted';
    durableIdempotencyKey: string;
    signal?: AbortSignal;
  }>): Promise<ExternalSessionTakeoverStartInputV1['request']>;
  startDurableTakeover:
    ExternalSessionPluginTakeoverStartActionExecutor['startPluginTakeover'];
  nowMs?: () => number;
}>;

export function createContextualExternalSessionTakeoverAdapter(
  dependencies: ContextualExternalSessionTakeoverDependencies,
): ContextualExternalSessionTakeoverAdapter {
  const nowMs = dependencies.nowMs ?? Date.now;

  const resolvePreflight = async (
    durableIdempotencyKey: string,
    authorIntent: ContextualExternalSessionTakeoverAuthorIntent,
  ) => await resolveExternalSessionPluginOperationPreflightAdmission({
    activeServerDir: dependencies.activeServerDir,
    durableIdempotencyKey,
    authorIntent,
    nowMs: nowMs(),
  });

  return Object.freeze({
    async takeover(rawRef, rawRequest, options) {
      const ref = readStableRef(rawRef);
      const request = readTakeoverRequest(rawRequest);
      assertAdmissionCurrent(options);
      const operationSignal = combineTakeoverSignals(options);
      const durableIdempotencyKey =
        deriveExternalSessionPluginOperationDurableKey({
          pluginId: dependencies.pluginId,
          callerKey: request.idempotencyKey,
        });
      const authorIntent = ExternalSessionOperationAuthorIntentV1Schema.parse({
        v: 1,
        surface: 'plugin',
        kind: 'takeover',
        agentId: ref.agentId,
        sourceId: ref.sourceId,
        remoteSessionId: ref.remoteSessionId,
        targetStorageMode: request.targetStorageMode,
      }) as ContextualExternalSessionTakeoverAuthorIntent;

      let preflight: ExternalSessionPluginOperationPreflightAdmission;
      try {
        preflight = await resolvePreflight(
          durableIdempotencyKey,
          authorIntent,
        );
      } catch (error) {
        throw pluginFailure(
          'plugin_external_takeover_failed',
          error,
        );
      }
      const replay = referenceFromPreflight(preflight);
      if (replay) return replay;
      if (preflight.kind === 'conflict') {
        throw pluginFailure(
          'plugin_external_takeover_idempotency_conflict',
        );
      }

      const resolved = await runWhileAdmissionCurrent(
        options,
        async () => await dependencies.resolveCurrentSource(
          ref,
          operationSignal ? { signal: operationSignal } : undefined,
        ),
      );
      // Writer safety is a precondition of the requested storage mode, not a
      // late phase-runner check. Resolving it here keeps an unsupported
      // external-linked takeover from committing a canonical link and a
      // durable operation it can never legally admit.
      if (
        request.targetStorageMode === 'external-linked'
        && resolved.externalLinkedTakeoverWriterSafety !== 'native_prevention'
      ) {
        throw pluginFailure(
          'plugin_external_takeover_writer_safety_unsupported',
        );
      }
      const linked = await runWhileAdmissionCurrent(
        options,
        async () => await dependencies.ensureLink({
          ref,
          source: resolved.source,
          ...(operationSignal ? { signal: operationSignal } : {}),
        }),
      );
      const sessionId = readCanonicalBoundedString(
        linked.sessionId,
        191,
        'plugin_external_takeover_link_invalid',
      );
      // A committed canonical link is independently idempotent and is not
      // rolled back if cancellation or durable Start fails after this point.
      const derived = await runWhileAdmissionCurrent(
        options,
        async () => await dependencies.deriveTakeoverStartRequest({
          ref,
          source: resolved.source,
          sessionId,
          targetStorageMode: request.targetStorageMode,
          durableIdempotencyKey,
          ...(operationSignal ? { signal: operationSignal } : {}),
        }),
      );
      const parsedStart = ExternalSessionTakeoverStartInputV1Schema.safeParse({
        request: derived,
      });
      // The derived request names the Agent by its durable identity, so the
      // ref's routing id is compared against the routing id that identity
      // currently resolves to. An identity the catalog no longer contributes
      // resolves to null and is refused.
      const derivedAgentRoutingId = parsedStart.success
        ? await runWhileAdmissionCurrent(
            options,
            async () => await dependencies.resolveAgentRoutingId(
              parsedStart.data.request.source.qualifiedIdentity.agent,
            ),
          )
        : null;
      if (
        !parsedStart.success
        || parsedStart.data.request.plan !== 'takeover'
        || parsedStart.data.request.sessionId !== sessionId
        || parsedStart.data.request.idempotencyKey !== durableIdempotencyKey
        || derivedAgentRoutingId !== ref.agentId
        || parsedStart.data.request.source.remoteSessionId
          !== ref.remoteSessionId
        || parsedStart.data.request.targetStorageMode
          !== request.targetStorageMode
      ) {
        throw pluginFailure('plugin_external_takeover_private_request_invalid');
      }

      assertAdmissionCurrent(options);
      try {
        const started = await dependencies.startDurableTakeover(
          parsedStart.data,
          {
            authorIntent,
            ...(operationSignal ? { signal: operationSignal } : {}),
          },
        );
        if (started.ok) return started.operation;
        throw pluginFailure(
          started.error.code === 'operation_conflict'
            ? 'plugin_external_takeover_idempotency_conflict'
            : 'plugin_external_takeover_failed',
        );
      } catch (error) {
        // Start is the commit boundary. If its response is lost, cancellation
        // wins late, or publication fails after the record write, return the
        // canonical committed reference instead of replaying source/link work.
        try {
          const admitted = await resolvePreflight(
            durableIdempotencyKey,
            authorIntent,
          );
          const committed = referenceFromPreflight(admitted);
          if (committed) return committed;
          if (admitted.kind === 'conflict') {
            throw pluginFailure(
              'plugin_external_takeover_idempotency_conflict',
            );
          }
        } catch (readError) {
          if (isPluginError(readError)) throw readError;
        }
        if (isPluginError(error)) throw error;
        assertAdmissionCurrent(options);
        throw pluginFailure('plugin_external_takeover_failed', error);
      }
    },
  });
}

export type ContextualExternalSessionTakeoverAuthorIntent = Extract<
  ExternalSessionOperationAuthorIntentV1,
  { kind: 'takeover' }
>;

function pluginFailure(code: string, cause?: unknown): PluginError {
  return new PluginError(
    { code, message: code },
    cause instanceof Error ? { cause } : undefined,
  );
}

function assertAdmissionCurrent(
  options: ContextualExternalSessionTakeoverOptions | undefined,
): void {
  if (options?.signal?.aborted) {
    throw pluginFailure('plugin_operation_aborted');
  }
  let current = true;
  try {
    current = options?.isCurrent?.() ?? true;
  } catch {
    current = false;
  }
  if (options?.retirementSignal?.aborted || !current) {
    throw pluginFailure('plugin_generation_retired');
  }
}

function combineTakeoverSignals(
  options: ContextualExternalSessionTakeoverOptions | undefined,
): AbortSignal | undefined {
  if (options?.signal && options.retirementSignal) {
    return AbortSignal.any([options.signal, options.retirementSignal]);
  }
  return options?.signal ?? options?.retirementSignal;
}

async function runWhileAdmissionCurrent<T>(
  options: ContextualExternalSessionTakeoverOptions | undefined,
  effect: () => Promise<T>,
): Promise<T> {
  assertAdmissionCurrent(options);
  try {
    const result = await effect();
    assertAdmissionCurrent(options);
    return result;
  } catch (error) {
    assertAdmissionCurrent(options);
    throw error;
  }
}

function readCanonicalBoundedString(
  value: unknown,
  max: number,
  code: string,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > max
    || value !== value.trim()
  ) {
    throw pluginFailure(code);
  }
  return value;
}

function readStableRef(value: unknown): HostExternalSessionRef {
  const record = readInputObject(value, 'plugin_external_ref_invalid');
  const parsed = ExternalSessionRefSchema.safeParse(record);
  if (!parsed.success) {
    throw pluginFailure('plugin_external_ref_invalid');
  }
  return Object.freeze(parsed.data);
}

function readTakeoverRequest(
  value: unknown,
): ContextualExternalSessionTakeoverRequest {
  const record = readStrictInputRecord(
    value,
    ['targetStorageMode', 'idempotencyKey'],
    'plugin_external_takeover_request_invalid',
  );
  if (
    record.targetStorageMode !== 'external-linked'
    && record.targetStorageMode !== 'persisted'
  ) {
    throw pluginFailure('plugin_external_takeover_request_invalid');
  }
  return Object.freeze({
    targetStorageMode: record.targetStorageMode,
    idempotencyKey: readCanonicalBoundedString(
      record.idempotencyKey,
      256,
      'plugin_external_takeover_idempotency_key_invalid',
    ),
  });
}

function readInputObject(
  value: unknown,
  code: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw pluginFailure(code);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readStrictInputRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: string,
): Readonly<Record<string, unknown>> {
  const record = readInputObject(value, code);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw pluginFailure(code);
  }
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw pluginFailure(code);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw pluginFailure(code);
    }
  }
  return record;
}

function referenceFromPreflight(
  preflight: ExternalSessionPluginOperationPreflightAdmission,
): ExternalSessionOperationReferenceV1 | null {
  if (preflight.kind === 'terminal_receipt') {
    return preflight.receipt.reference;
  }
  if (preflight.kind === 'existing_record') {
    return {
      sessionId: preflight.record.request.sessionId,
      operationId: preflight.record.operationId,
      revision: preflight.record.revision,
    };
  }
  return null;
}
