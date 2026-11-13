import { ExternalSessionMaterializeStartInputV1Schema } from '@happier-dev/protocol/sessions/external/operationActionSchemasV1';
import { readNonAuthoritativeLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionOperationActionResponseV1, ExternalSessionOperationAuthorIntentV1, ExternalSessionOperationSemanticRequestV1 } from '@happier-dev/protocol';

import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  resolveLinkedExternalSessionQualifiedIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentity';
import {
  resolveCurrentExternalSessionAgentIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';

import type {
  ExternalSessionMaterializeActionExecutor,
  ExternalSessionMaterializeAccountAdmission,
  ExternalSessionMaterializeSourceAdmission,
} from './materializeAction';
import {
  ExternalSessionOperationRecordReadError,
  captureExternalSessionOperationAccountAdmission,
  resolveExternalSessionOperationStartAdmission,
  type ExternalSessionOperationAccountScope,
} from './operationRecordStore';
import {
  resolveOccurrenceBoundExternalSessionFollowSurface,
} from './providerOpsResolution';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';
import { acknowledgeExternalSessionOperationAdmission } from './operationAdmission';

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
     * every admitted record/staging effect stays in the captured partition.
     */
    accountScope?: ExternalSessionOperationAccountScope | null,
  ): ReturnType<typeof resolveExternalSessionOperationStartAdmission>;
  describeSession(intent: MaterializeStartIntent, accountAdmission?: ExternalSessionMaterializeAccountAdmission): Promise<Readonly<{
    request: MaterializeSemanticRequest;
    accountScope?: ExternalSessionOperationAccountScope;
    sourceAdmission?: ExternalSessionMaterializeSourceAdmission;
  }>>;
  startSemanticRequest:
    ExternalSessionMaterializeActionExecutor['start'];
}>;

export type ExternalSessionMaterializeStartActionExecutor = Readonly<{
  start(
    input: unknown,
    context?: Readonly<{
      signal?: AbortSignal;
      accountAdmission?: ExternalSessionMaterializeAccountAdmission;
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
      accountAdmission?: ExternalSessionMaterializeAccountAdmission;
      authorIntent?: Extract<
        ExternalSessionOperationAuthorIntentV1,
        { kind: 'materialize' }
      >;
    }>,
    accountScope?: ExternalSessionOperationAccountScope | null,
    sourceAdmission?: ExternalSessionMaterializeSourceAdmission,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    return await acknowledgeExternalSessionOperationAdmission((onAdmitted) =>
      dependencies.startSemanticRequest({ request }, {
        ...(context?.signal ? { signal: context.signal } : {}),
        ...(context?.authorIntent ? { authorIntent: context.authorIntent } : {}),
        ...(context?.accountAdmission ? { accountAdmission: context.accountAdmission } : {}),
        ...(accountScope ? { accountScope } : {}),
        ...(sourceAdmission ? { sourceAdmission } : {}),
        onAdmitted,
      }), 'materialize.start');
  };

  const start: ExternalSessionMaterializeStartActionExecutor['start'] =
    async (raw, context) => {
      const parsed = ExternalSessionMaterializeStartInputV1Schema.safeParse(raw);
      if (!parsed.success) {
        return failure('invalid_state', 'Invalid materialization request.');
      }
      const intent = parsed.data.request as unknown as MaterializeStartIntent;
      let request: MaterializeSemanticRequest;
      let admissionAccountScope: ExternalSessionOperationAccountScope | undefined;
      let sourceAdmission: ExternalSessionMaterializeSourceAdmission | undefined;
      try {
        // Source authorization intentionally precedes receipt/conflict lookup:
        // receipt identity is Account-private and must not be observable to a
        // caller that cannot currently read this linked Session.
        ({ request, accountScope: admissionAccountScope, sourceAdmission } =
          await dependencies.describeSession(intent, context?.accountAdmission));
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
        return await admitDurableOperation(existing, context, admissionAccountScope, sourceAdmission);
      }

      return await admitDurableOperation(request, context, admissionAccountScope, sourceAdmission);
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
    materialize: Pick<ExternalSessionMaterializeActionExecutor, 'start'>;
  }>,
): ExternalSessionMaterializeStartActionExecutor {
  return createExternalSessionMaterializeStartActionExecutor({
    resolveAdmission: async (intent, authorIntent, accountScope) =>
      await resolveExternalSessionOperationStartAdmission({
        activeServerDir: input.activeServerDir,
        durableIdempotencyKey: intent.idempotencyKey,
        intent,
        ...(authorIntent ? { authorIntent } : {}),
        ...(accountScope ? { accountScope } : {}),
      }),
    describeSession: async (intent, accountAdmission) => {
      const admission = accountAdmission ?? await captureExternalSessionOperationAccountAdmission(input.activeServerDir);
      if (!admission) {
        throw new Error('external_session_materialize_start_unauthenticated');
      }
      const { credentials, accountScope } = admission;
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
      const resolved = await resolveOccurrenceBoundExternalSessionFollowSurface(
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
      const sourceSnapshotEvidenceRef = JSON.stringify({
        qualifiedIdentity,
        tailCursor: firstPage.tailCursor,
      });
      return {
        ...(accountScope ? { accountScope } : {}),
        sourceAdmission: { credentials, linked, ...(accountScope ? { accountScope } : {}) },
        request: {
          ...intent,
          source: {
            machineId: linked.machineId,
            remoteSessionId: linked.remoteSessionId,
            qualifiedIdentity,
            linkGeneration: linked.linkGeneration,
            sourceGeneration:
              createExternalSessionSourceGenerationAnchor(sourceSnapshotEvidenceRef),
            sourceCustody: resolved.sourceCustody,
          },
        },
      };
    },
    startSemanticRequest: input.materialize.start,
  });
}
