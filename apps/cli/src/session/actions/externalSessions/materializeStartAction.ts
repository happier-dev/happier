import {
  ExternalSessionMaterializeStartInputV1Schema,
  projectExternalSessionOperationProgressV1,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationAuthorIntentV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSemanticRequestV1,
} from '@happier-dev/protocol';

import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  resolveLinkedExternalSessionQualifiedIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentity';
import {
  resolveCurrentExternalSessionAgentIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { readStoredCredentials } from '@/persistence';

import type {
  ExternalSessionMaterializeActionExecutor,
} from './materializeAction';
import {
  ExternalSessionOperationRecordReadError,
  resolveExternalSessionOperationAdmissionAccountScope,
  resolveExternalSessionOperationStartAdmission,
  type ExternalSessionOperationAccountScope,
} from './operationRecordStore';
import {
  readExternalSessionOperationSharedPresentation,
} from './operationProgressPublisher';
import {
  resolveGenerationBoundExternalSessionFollowSurface,
} from './providerOpsResolution';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';

type MaterializeStartIntent = Readonly<{
  v: 1;
  idempotencyKey: string;
  sessionId: string;
  plan: 'materialize';
  targetStorageMode: 'external-linked';
  targetRuntimeMode: null;
}>;
type MaterializeSemanticRequest = Extract<
  ExternalSessionOperationSemanticRequestV1,
  { plan: 'materialize' }
>;

export type ExternalSessionPluginMaterializeStart = (
  input: Readonly<{
    sessionId: string;
    durableIdempotencyKey: string;
    authorIntent: Extract<
      ExternalSessionOperationAuthorIntentV1,
      { kind: 'materialize' }
    >;
    signal?: AbortSignal;
  }>,
) => Promise<ExternalSessionOperationActionResponseV1>;

type MaterializeStartDependencies = Readonly<{
  resolveAdmission(
    intent: MaterializeStartIntent,
    authorIntent?: Extract<
      ExternalSessionOperationAuthorIntentV1,
      { kind: 'materialize' }
    >,
    /**
     * Pinned authenticated Account scope captured at admission. When the
     * provider supplies it, admission resolves inside that Account's
     * partition, and the pin is carried into the materialize executor so
     * every record/staging effect verifies the ambient Account still
     * matches (A→B rotation fails closed).
     */
    accountScope?: ExternalSessionOperationAccountScope | null,
  ): ReturnType<typeof resolveExternalSessionOperationStartAdmission>;
  /**
   * Captures the exact authenticated Account scope at the admission boundary.
   * Captured once per Start call and shared by admission resolution and the
   * carried executor effects.
   */
  resolveAdmissionAccountScope?(): Promise<ExternalSessionOperationAccountScope | null>;
  describeSession(intent: MaterializeStartIntent): Promise<MaterializeSemanticRequest>;
  startSemanticRequest:
    ExternalSessionMaterializeActionExecutor['start'];
}>;

export type ExternalSessionMaterializeStartActionExecutor = Readonly<{
  start(
    input: unknown,
    context?: Readonly<{
      signal?: AbortSignal;
      authorIntent?: Extract<
        ExternalSessionOperationAuthorIntentV1,
        { kind: 'materialize' }
      >;
    }>,
  ): Promise<ExternalSessionOperationActionResponseV1>;
  startPluginMaterialize: ExternalSessionPluginMaterializeStart;
}>;

function failure(
  code: Extract<ExternalSessionOperationActionResponseV1, { ok: false }>['error']['code'],
  message: string,
): ExternalSessionOperationActionResponseV1 {
  return { ok: false, error: { code, message } };
}

function success(
  record: ExternalSessionOperationRecordV1,
): ExternalSessionOperationActionResponseV1 {
  return {
    ok: true,
    progress: projectExternalSessionOperationProgressV1(record),
  };
}

function publicIntentForSemanticRequest(
  request: MaterializeSemanticRequest,
): MaterializeStartIntent {
  const { source: _source, ...intent } = request;
  return intent;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createExternalSessionMaterializeStartActionExecutor(
  dependencies: MaterializeStartDependencies,
): ExternalSessionMaterializeStartActionExecutor {
  /**
   * Admits the durable materialization operation and answers with its public
   * operation reference. The durable operation owns the historical import and
   * outlives this call, so the caller follows it through the operation status
   * and progress owners instead of waiting for the import to finish.
   */
  const admitDurableOperation = async (
    request: MaterializeSemanticRequest,
    context?: Readonly<{
      signal?: AbortSignal;
      authorIntent?: Extract<
        ExternalSessionOperationAuthorIntentV1,
        { kind: 'materialize' }
      >;
    }>,
    accountScope?: ExternalSessionOperationAccountScope | null,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    let admit!: (record: ExternalSessionOperationRecordV1) => void;
    const admitted = new Promise<ExternalSessionOperationRecordV1>((resolve) => {
      admit = resolve;
    });
    const operation = dependencies.startSemanticRequest({ request }, {
      ...(context?.signal ? { signal: context.signal } : {}),
      ...(context?.authorIntent ? { authorIntent: context.authorIntent } : {}),
      ...(accountScope ? { accountScope } : {}),
      onAdmitted: admit,
    });
    return await Promise.race([
      admitted.then((record) => success(record)),
      operation,
    ]);
  };

  const start: ExternalSessionMaterializeStartActionExecutor['start'] =
    async (raw, context) => {
      const parsed = ExternalSessionMaterializeStartInputV1Schema.safeParse(raw);
      if (!parsed.success) {
        return failure('invalid_state', 'Invalid materialization request.');
      }
      const intent = parsed.data.request as unknown as MaterializeStartIntent;
      let request: MaterializeSemanticRequest;
      try {
        // Source authorization intentionally precedes receipt/conflict lookup:
        // receipt identity is Account-private and must not be observable to a
        // caller that cannot currently read this linked Session.
        request = await dependencies.describeSession(intent);
      } catch (error) {
        if (
          error instanceof Error
          && error.message === 'linked_session_reconciliation_required'
        ) {
          return failure(
            'reconciliation_required',
            'Linked external session metadata requires reconciliation.',
          );
        }
        return failure(
          'source_unavailable',
          'Linked external session identity changed.',
        );
      }
      if (!sameValue(publicIntentForSemanticRequest(request), intent)) {
        return failure(
          'source_unavailable',
          'Linked external session identity changed.',
        );
      }
      // Capture the exact authenticated Account at the admission boundary, once
      // per Start call. Both the admission resolution below and the carried
      // executor effects use this pin, so a rotation after admission can never
      // let one call resolve into two different Account partitions.
      const admissionAccountScope = dependencies.resolveAdmissionAccountScope
        ? await dependencies.resolveAdmissionAccountScope()
        : null;
      let admission: Awaited<ReturnType<
        MaterializeStartDependencies['resolveAdmission']
      >>;
      try {
        admission = await dependencies.resolveAdmission(
          intent,
          context?.authorIntent,
          admissionAccountScope ?? undefined,
        );
      } catch (error) {
        if (
          error instanceof ExternalSessionOperationRecordReadError
          && (
            error.reason === 'account_scope_unavailable'
            || error.reason === 'legacy_unscoped'
          )
        ) {
          return failure(
            'source_unavailable',
            'Materialization operation identity is unavailable.',
          );
        }
        return failure(
          'internal_error',
          'Materialization operation record could not be read.',
        );
      }
      if (admission.kind === 'conflict') {
        return failure(
          'operation_conflict',
          'Materialization idempotency request changed.',
        );
      }
      if (admission.kind === 'legacy_unavailable') {
        return failure(
          'source_unavailable',
          'A legacy materialization operation cannot be safely resumed.',
        );
      }
      if (admission.kind === 'terminal_receipt') {
        return failure(
          'invalid_state',
          'The settled materialization no longer has private recovery state.',
        );
      }
      if (admission.kind === 'existing_record') {
        const existing = admission.record.request;
        if (
          existing.plan !== 'materialize'
          || !sameValue(publicIntentForSemanticRequest(existing), intent)
        ) {
          return failure(
            'operation_conflict',
            'Materialization idempotency request changed.',
          );
        }
        return await admitDurableOperation(existing, context, admissionAccountScope);
      }

      return await admitDurableOperation(request, context, admissionAccountScope);
    };

  return Object.freeze({
    start,
    async startPluginMaterialize(input) {
      return await start({
        request: {
          v: 1,
          idempotencyKey: input.durableIdempotencyKey,
          sessionId: input.sessionId,
          plan: 'materialize',
          targetStorageMode: 'external-linked',
          targetRuntimeMode: null,
        },
      }, {
        authorIntent: input.authorIntent,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
  });
}

export function createDefaultExternalSessionMaterializeStartActionExecutor(
  input: Readonly<{
    activeServerDir: string;
    machineId?: string;
    materialize: ExternalSessionMaterializeActionExecutor;
    nowMs?: () => number;
  }>,
): ExternalSessionMaterializeStartActionExecutor {
  const nowMs = input.nowMs ?? Date.now;
  return createExternalSessionMaterializeStartActionExecutor({
    resolveAdmissionAccountScope: async () =>
      await resolveExternalSessionOperationAdmissionAccountScope(
        input.activeServerDir,
      ),
    resolveAdmission: async (intent, authorIntent, accountScope) =>
      await resolveExternalSessionOperationStartAdmission({
        activeServerDir: input.activeServerDir,
        durableIdempotencyKey: intent.idempotencyKey,
        intent,
        ...(authorIntent ? { authorIntent } : {}),
        ...(accountScope ? { accountScope } : {}),
        nowMs: nowMs(),
        readSelectedPresentation:
          readExternalSessionOperationSharedPresentation,
      }),
    describeSession: async (intent) => {
      const credentials = await readStoredCredentials();
      if (!credentials) {
        throw new Error('external_session_materialize_start_unauthenticated');
      }
      const loaded = await loadLinkedExternalSession({
        credentials,
        sessionId: intent.sessionId,
        ...(input.machineId ? { machineId: input.machineId } : {}),
      });
      if (!loaded.ok) {
        if (loaded.error === 'linked_session_reconciliation_required') {
          throw new Error('linked_session_reconciliation_required');
        }
        throw new Error('external_session_materialize_start_source_unavailable');
      }
      const linked = loaded.session;
      const persisted = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(linked.metadata);
      if (!persisted?.qualifiedIdentity) {
        throw new Error('external_session_materialize_start_source_unavailable');
      }
      const qualified = await resolveLinkedExternalSessionQualifiedIdentity(
        persisted,
        {
          resolveCurrentAgent: resolveCurrentExternalSessionAgentIdentity,
        },
      );
      if (!qualified.ok || qualified.writeForwardRequired) {
        throw new Error('external_session_materialize_start_source_unavailable');
      }
      const qualifiedIdentity = qualified.link.qualifiedIdentity;
      if (!qualifiedIdentity) {
        throw new Error('external_session_materialize_start_source_unavailable');
      }
      const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
        linked.agentId,
        linked.linkGeneration,
      );
      if (
        resolved.resource.retirementSignal?.aborted
        || !resolved.providerOps.pageTranscript
      ) {
        throw new Error('external_session_materialize_start_source_unavailable');
      }
      const firstPage = await resolved.providerOps.pageTranscript({
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
        direction: 'older',
        maxBytes: 512 * 1024,
        maxItems: 1,
      });
      if (resolved.resource.retirementSignal?.aborted) {
        throw new Error('external_session_materialize_start_source_changed');
      }
      const sourceSnapshotEvidenceRef = JSON.stringify({
        qualifiedIdentity,
        tailCursor: firstPage.tailCursor,
      });
      return {
        ...intent,
        source: {
          machineId: linked.machineId,
          remoteSessionId: linked.remoteSessionId,
          qualifiedIdentity,
          linkGeneration: linked.linkGeneration,
          sourceGeneration:
            createExternalSessionSourceGenerationAnchor(sourceSnapshotEvidenceRef),
          contributionGeneration: resolved.resource.pluginGeneration,
        },
      };
    },
    startSemanticRequest: input.materialize.start,
  });
}
