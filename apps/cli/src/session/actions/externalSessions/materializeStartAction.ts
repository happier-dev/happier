import {
  ExternalSessionMaterializeStartInputV1Schema,
  readLinkedExternalSessionV1FromMetadata,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationSemanticRequestV1,
} from '@happier-dev/protocol';

import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  resolveLinkedExternalSessionQualifiedIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentity';
import {
  resolveCurrentExternalSessionAgentIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { readCredentials } from '@/persistence';

import type {
  ExternalSessionMaterializeActionExecutor,
} from './materializeAction';
import {
  externalSessionOperationIdForRequest,
  readExternalSessionOperationRecord,
} from './operationRecordStore';
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

type MaterializeStartDependencies = Readonly<{
  readExistingRequest(operationId: string): Promise<MaterializeSemanticRequest | null>;
  describeSession(intent: MaterializeStartIntent): Promise<MaterializeSemanticRequest>;
  startSemanticRequest:
    ExternalSessionMaterializeActionExecutor['start'];
}>;

export type ExternalSessionMaterializeStartActionExecutor = Readonly<{
  start(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
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
  return Object.freeze({
    async start(raw) {
      const parsed = ExternalSessionMaterializeStartInputV1Schema.safeParse(raw);
      if (!parsed.success) {
        return failure('invalid_state', 'Invalid materialization request.');
      }
      const intent = parsed.data.request as unknown as MaterializeStartIntent;
      const operationId = externalSessionOperationIdForRequest(intent);
      let existing: MaterializeSemanticRequest | null;
      try {
        existing = await dependencies.readExistingRequest(operationId);
      } catch {
        return failure(
          'internal_error',
          'Materialization operation record could not be read.',
        );
      }
      if (existing) {
        if (!sameValue(publicIntentForSemanticRequest(existing), intent)) {
          return failure(
            'operation_conflict',
            'Materialization idempotency request changed.',
          );
        }
        return await dependencies.startSemanticRequest({ request: existing });
      }

      let request: MaterializeSemanticRequest;
      try {
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
      return await dependencies.startSemanticRequest({ request });
    },
  });
}

export function createDefaultExternalSessionMaterializeStartActionExecutor(
  input: Readonly<{
    activeServerDir: string;
    machineId?: string;
    materialize: ExternalSessionMaterializeActionExecutor;
  }>,
): ExternalSessionMaterializeStartActionExecutor {
  return createExternalSessionMaterializeStartActionExecutor({
    readExistingRequest: async (operationId) => {
      const existing = await readExternalSessionOperationRecord(
        // The materializer and operation-store owner share the configured daemon
        // directory; the semantic start remains private to that owner.
        input.activeServerDir,
        operationId,
      );
      return existing?.request.plan === 'materialize'
        ? existing.request
        : null;
    },
    describeSession: async (intent) => {
      const credentials = await readCredentials();
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
      const persisted = readLinkedExternalSessionV1FromMetadata(linked.metadata);
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
