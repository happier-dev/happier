import { randomUUID } from 'node:crypto';

import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildExecutionRunHostActionApprovalArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import type { ActionId, ApprovalQueueListItemV1, ApprovalRequest, ExecutionRunHostActionApprovalRequestV1, TargetActionApprovalRequestV1, PromptLibraryArtifactStore } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  createConnectedServiceCredentialApi,
  type ConnectedServiceAccountEncryptionMode,
} from '@/api/client/connectedServiceCredentialApi';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';

import { targetActionApprovalRequestsEqual, targetActionApprovalSubjectsEqual } from './targetActionApprovalSubject';
import {
  executionRunHostActionApprovalRequestsEqual,
  executionRunHostActionApprovalSubjectsEqual,
} from './executionRunHostActionApprovalSubject';

function parseApprovalStatus(value: unknown): ApprovalRequest['status'] | null {
  if (
    value === 'open'
    || value === 'approved'
    || value === 'executing'
    || value === 'rejected'
    || value === 'executed'
    || value === 'failed'
    || value === 'canceled'
  ) {
    return value;
  }
  return null;
}

function parseApprovalActionId(value: unknown): ActionId | null {
  return typeof value === 'string' && ActionIdSchema.safeParse(value).success ? value as ActionId : null;
}

function normalizeArtifactServerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function approvalArtifactMatchesServerScope(
  header: Record<string, unknown>,
  serverId: string | null,
): boolean {
  if (!serverId) return true;
  return normalizeArtifactServerId(header.serverId) === serverId;
}

function readBuiltInApprovalArtifact(header: Record<string, unknown>, body: unknown): ApprovalRequest | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'built_in' ? parsed.request : null;
}

function readTargetActionApprovalArtifact(header: Record<string, unknown>, body: unknown): TargetActionApprovalRequestV1 | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'target_action' ? parsed.request : null;
}

function readExecutionRunHostActionApprovalArtifact(header: Record<string, unknown>, body: unknown): ExecutionRunHostActionApprovalRequestV1 | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'execution_run_host_action' ? parsed.request : null;
}

export function createCliApprovalsArtifactStore(params: Readonly<{
  credentials: StoredCredentials;
  getAccountEncryptionMode?: () => Promise<ConnectedServiceAccountEncryptionMode>;
}>): Readonly<{
  approvalsList: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsList']>;
  approvalsCreate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsCreate']>;
  approvalsGet: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsGet']>;
  approvalsUpdate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsUpdate']>;
  targetActionApprovalsCreate(args: Readonly<{ request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ artifactId: string }>>;
  targetActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<TargetActionApprovalRequestV1 | null>;
  targetActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  executionRunHostActionApprovalsCreate(args: Readonly<{ request: ExecutionRunHostActionApprovalRequestV1 }>): Promise<Readonly<{ artifactId: string }>>;
  executionRunHostActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<ExecutionRunHostActionApprovalRequestV1 | null>;
  executionRunHostActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: ExecutionRunHostActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  promptLibraryStore: PromptLibraryArtifactStore;
}> {
  const accountModeApi = params.getAccountEncryptionMode
    ? null
    : createConnectedServiceCredentialApi(params.credentials);
  const getAccountEncryptionMode = params.getAccountEncryptionMode
    ?? (() => accountModeApi!.getAccountEncryptionMode());
  const accountArtifactStore = createAccountArtifactStore({
    credentials: params.credentials,
    getAccountEncryptionMode,
  });

  return {
    promptLibraryStore: {
      list: async (options) => {
        const page = await accountArtifactStore.list(options);
        return { items: page.items.map((artifact) => ({ id: artifact.artifactId, header: artifact.header, updatedAtMs: artifact.updatedAt })),
          coverage: page.coverage, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      },
      read: async (artifactId, options) => {
        const artifact = await accountArtifactStore.read(artifactId, options);
        if (!artifact) return null;
        if (typeof artifact.body !== 'string') return null;
        return {
          id: artifact.artifactId,
          revision: artifact.revision,
          header: artifact.header,
          body: artifact.body,
        };
      },
      create: async ({ header, body, signal }) => {
        const created = await accountArtifactStore.create({ header, body, signal });
        return created.artifactId;
      },
      update: async ({ artifactId, expectedRevision, header, body, signal }) => {
        const updated = await accountArtifactStore.update({ artifactId,
          expectedRevision, header, body, signal });
        if (!updated.ok) throw Object.assign(new Error(updated.error), { code: updated.errorCode });
      },
    },
    executionRunHostActionApprovalsCreate: async ({ request }) => {
      const artifactId = randomUUID();
      const res = await accountArtifactStore.create({ artifactId,
        header: buildExecutionRunHostActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return { artifactId: res.artifactId };
    },
    executionRunHostActionApprovalsGet: async ({ artifactId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      const parsed = readExecutionRunHostActionApprovalArtifact(header, artifact.body);
      if (!parsed) return null;
      return parsed;
    },
    executionRunHostActionApprovalsUpdate: async ({ artifactId, request }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const existingHeader = artifact.header;
      const existing = readExecutionRunHostActionApprovalArtifact(existingHeader, artifact.body);
      if (!existing || !executionRunHostActionApprovalSubjectsEqual(existing, request)) {
        return { ok: false, errorCode: 'subject_mismatch', error: 'execution_run_host_action_approval_subject_mismatch' };
      }
      if (executionRunHostActionApprovalRequestsEqual(existing, request)) return { ok: true };
      if (existing.status !== 'open'
        || (request.status !== 'approved' && request.status !== 'rejected' && request.status !== 'canceled')
        || request.updatedAtMs < existing.updatedAtMs) {
        return { ok: false, errorCode: 'invalid_transition', error: 'execution_run_host_action_approval_invalid_transition' };
      }
      const updated = await accountArtifactStore.update({ artifactId, expectedRevision: artifact.revision,
        header: buildExecutionRunHostActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return updated.ok ? { ok: true } : updated;
    },
    targetActionApprovalsCreate: async ({ request }) => {
      const artifactId = randomUUID();
      const res = await accountArtifactStore.create({ artifactId,
        header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return { artifactId: res.artifactId };
    },
    targetActionApprovalsGet: async ({ artifactId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      const parsed = readTargetActionApprovalArtifact(header, artifact.body);
      if (!parsed) return null;
      return parsed;
    },
    targetActionApprovalsUpdate: async ({ artifactId, request }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const existingHeader = artifact.header;
      const existingRequest = readTargetActionApprovalArtifact(existingHeader, artifact.body);
      if (!existingRequest || !targetActionApprovalSubjectsEqual(existingRequest, request)) {
        return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
      }
      if (targetActionApprovalRequestsEqual(existingRequest, request)) {
        if (existingRequest.status === 'executing') {
          return { ok: false, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' };
        }
        return { ok: true };
      }
      const isOpenDecision = existingRequest.status === 'open'
        && (request.status === 'approved' || request.status === 'rejected' || request.status === 'canceled');
      const isApprovedExecution = existingRequest.status === 'approved'
        && request.status === 'executing'
        && request.decision?.kind === 'approve'
        && request.execution === undefined;
      const isExecutingTerminal = existingRequest.status === 'executing'
        && (request.status === 'executed' || request.status === 'failed')
        && request.decision?.kind === 'approve'
        && request.execution !== undefined;
      if ((!isOpenDecision && !isApprovedExecution && !isExecutingTerminal)
        || request.updatedAtMs < existingRequest.updatedAtMs) {
        return { ok: false, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' };
      }
      const updated = await accountArtifactStore.update({ artifactId, expectedRevision: artifact.revision,
        header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return updated.ok ? { ok: true } : updated;
    },
    approvalsList: async ({ status, limit, serverId }) => {
      const items: ApprovalQueueListItemV1[] = [];
      const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
      const maxItems = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 32;
      let cursor: string | undefined;
      do {
        const page = await accountArtifactStore.list({ limit: maxItems, ...(cursor ? { cursor } : {}) });
        for (const artifact of page.items) {
          if (items.length >= maxItems) break;
          const header = artifact.header;
          if (!header || header.kind !== 'approval_request.v1') continue;
          const hydrated = await accountArtifactStore.read(artifact.artifactId);
          if (!hydrated?.body) continue;
          const request = readBuiltInApprovalArtifact(hydrated.header, hydrated.body);
          if (!request) continue;
          if (typeof status === 'string' && request.status !== status) continue;
          const headerServerId = normalizeArtifactServerId(hydrated.header.serverId);
          // V1 has no body-authoritative stable Home identity. Preserve its
          // released profile-scoped history behavior; V2 is Account-scoped and
          // validates creator profile plus Home from its strict body.
          if (request.v === 1 && !approvalArtifactMatchesServerScope(hydrated.header, normalizedServerId)) continue;

          const actionId = parseApprovalActionId(request.actionId);
          const summary = request.summary;
          const approvalStatus = parseApprovalStatus(request.status);
          if (!actionId || !summary || !approvalStatus) continue;

          items.push({
            artifactId: artifact.artifactId,
            status: approvalStatus,
            actionId,
            summary,
            ...(typeof hydrated.header.sessionId === 'string' && hydrated.header.sessionId.trim().length > 0 ? { sessionId: hydrated.header.sessionId.trim() } : {}),
            ...(headerServerId ? { serverId: headerServerId } : {}),
            updatedAtMs: Number.isFinite(hydrated.updatedAt) ? hydrated.updatedAt : 0,
          });
        }
        cursor = items.length < maxItems ? page.nextCursor : undefined;
      } while (cursor);

      return {
        items,
        queryPlan: {
          kind: 'approval_artifact_header_scan',
          backingStore: 'ArtifactStore',
          boundedBy: items.length >= maxItems ? 'requested matching approval count' : 'ArtifactStore source exhaustion',
          serverLimit: maxItems,
          hydratedTranscripts: false,
        },
      };
    },

    approvalsCreate: async ({ request, serverId }) => {
      const artifactId = randomUUID();

      const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId });
      if (request.v === 2 && typeof serverId === 'string' && serverId.trim() !== request.executionOriginV1.serverId) {
        throw new Error('approval_request_server_target_mismatch');
      }

      const res = await accountArtifactStore.create({ artifactId, header, body: JSON.stringify(request) });
      return { artifactId: res.artifactId };
    },

    approvalsGet: async ({ artifactId, serverId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      if (!header) return null;
      const body = artifact.body;
      if (!body) return null;

      const request = readBuiltInApprovalArtifact(header, body);
      if (request?.v === 1 && !approvalArtifactMatchesServerScope(header, normalizeArtifactServerId(serverId))) {
        return null;
      }
      return request;
    },

    approvalsUpdate: async ({ artifactId, request, serverId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const existingHeader = artifact.header;
      if (!existingHeader) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      }

      const existingBody = artifact.body;
      const existing = readBuiltInApprovalArtifact(existingHeader, existingBody);
      if (existing?.v === 1 && !approvalArtifactMatchesServerScope(existingHeader, normalizeArtifactServerId(serverId))) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      }
      if (!existing) {
        return {
          ok: false,
          errorCode: 'subject_mismatch',
          error: 'approval_request_subject_mismatch',
        };
      }
      // The Protocol subject/transition owner is shared with the UI adapter:
      // immutable subject (settlements may only apply the Action's declared
      // input projection), the lifecycle edges, and the refusal of a repeated
      // `executing` claim. This store only commits against the revision it read.
      const transition = decideApprovalRequestTransition(existing, request);
      if (!transition.ok) return transition;
      if (!transition.changed) return { ok: true };

      const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId });
      const updated = await accountArtifactStore.update({ artifactId, expectedRevision: artifact.revision,
        header, body: JSON.stringify(request) });

      if (updated.ok) return { ok: true };
      return { ok: false, errorCode: updated.errorCode, error: updated.error };
    },
  };
}
