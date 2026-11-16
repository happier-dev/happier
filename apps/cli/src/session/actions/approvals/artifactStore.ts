import { randomUUID } from 'node:crypto';
import { setApprovalTraceArtifactId, timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildExecutionRunHostActionApprovalArtifactHeaderV1, listApprovalArtifactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import type { ApprovalRequest, ExecutionRunHostActionApprovalRequestV1, TargetActionApprovalRequestV1, PromptLibraryArtifactStore } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import {
  createConnectedServiceCredentialApi,
  type AccountEncryptionModeReadOptions,
  type ConnectedServiceAccountEncryptionMode,
} from '@/api/client/connectedServiceCredentialApi';
import { createAccountArtifactStore, type AccountArtifact, type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { requesterAccountEncryptionMode } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { configuration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ArtifactFolderActionPortV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import type { SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { readAccountPluginSkills } from '@/prompts/skills/library/readAccountPluginSkills';
import type { SkillActionPortV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

import { createCliApprovalCreation, type WorkflowDiscussionReplyApprovalSubject } from './creation';
import { createTargetActionApprovalLifecycle } from './targetActionLifecycle';
import { recoverExecutingApprovals } from './recoverExecuting';
import {
  executionRunHostActionApprovalRequestsEqual,
  executionRunHostActionApprovalSubjectsEqual,
} from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';

/** One adaptation of an already-readable Account Artifact for the Prompt owner. */
export function projectAccountArtifactToPromptLibraryStoredArtifact(artifact: AccountArtifact | null): PromptLibraryStoredArtifact | null {
  if (!artifact || typeof artifact.body !== 'string') return null;
  return { id: artifact.artifactId, revision: artifact.revision, header: artifact.header, body: artifact.body,
    ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
    owned: artifact.access === 'owner', access: artifact.access };
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

function readExecutionRunHostActionApprovalArtifact(header: Record<string, unknown>, body: unknown): ExecutionRunHostActionApprovalRequestV1 | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'execution_run_host_action' ? parsed.request : null;
}

export function createCliApprovalsArtifactStore(params: Readonly<{
  credentials: StoredCredentials;
  serverId?: string;
  serverHttpBaseUrl?: string;
  operationContext?: SavedSecretOperationContextV1;
  getAccountEncryptionMode?: (options?: AccountEncryptionModeReadOptions) => Promise<ConnectedServiceAccountEncryptionMode>;
  approvalAuthorizationHeaders?: ArtifactRequestAuthorizationHeaders;
}>): Readonly<{
  approvalsList: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsList']>;
  approvalsCreate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsCreate']>;
  approvalsGet: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsGet']>;
  approvalsUpdate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsUpdate']>;
  findWorkflowDiscussionReplyApproval(subject: WorkflowDiscussionReplyApprovalSubject,
    options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ artifactId: string }> | null>;
  readPluginChangeApprovalRetirement: ReturnType<typeof createCliApprovalCreation>['readPluginChangeApprovalRetirement'];
  targetActionApprovalsCreate(args: Readonly<{ request: TargetActionApprovalRequestV1;
    onReady?: (created: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>) => void;
  }>): Promise<Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>>;
  targetActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<TargetActionApprovalRequestV1 | null>;
  targetActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  approvalsRecoverExecuting(args: Readonly<{ machineId: string }>): ReturnType<typeof recoverExecutingApprovals>;
  executionRunHostActionApprovalsCreate(args: Readonly<{ request: ExecutionRunHostActionApprovalRequestV1;
    onReady?: (created: Readonly<{ artifactId: string; request: ExecutionRunHostActionApprovalRequestV1 }>) => void;
  }>): Promise<Readonly<{ artifactId: string }>>;
  executionRunHostActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<ExecutionRunHostActionApprovalRequestV1 | null>;
  executionRunHostActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: ExecutionRunHostActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  promptLibraryStore: PromptLibraryArtifactStore;
  promptLibraryStoreForAuthorization: (authorizationHeaders: ArtifactRequestAuthorizationHeaders) => PromptLibraryArtifactStore;
  skillRules: SkillRulesActionPortV1;
  skillRulesForAuthorization: (authorizationHeaders: ArtifactRequestAuthorizationHeaders) => SkillRulesActionPortV1;
  readPluginSkills: NonNullable<SkillActionPortV1['readPluginSkills']>;
}> {
  const accountModeApi = params.getAccountEncryptionMode
    ? null
    : createConnectedServiceCredentialApi(params.credentials);
  const getAccountEncryptionMode = params.getAccountEncryptionMode
    ?? ((options?: AccountEncryptionModeReadOptions) => accountModeApi!.getAccountEncryptionMode(options));
  const rawAccountArtifactStore = createAccountArtifactStore({
    credentials: params.credentials,
    resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl() }),
    getAccountEncryptionMode: options => timeWebLatencyPhase('approval.account_mode', () => getAccountEncryptionMode(options)),
  });
  const accountArtifactStore = { ...rawAccountArtifactStore,
    read: (...args: Parameters<typeof rawAccountArtifactStore.read>) => timeWebLatencyPhase('approval.artifact.read', () => rawAccountArtifactStore.read(...args)),
    update: (...args: Parameters<typeof rawAccountArtifactStore.update>) => timeWebLatencyPhase('approval.artifact.update', () => rawAccountArtifactStore.update(...args)),
    readForUpdate: async (artifactId: string, options?: Parameters<typeof rawAccountArtifactStore.readForUpdate>[1]) => {
      const current = await timeWebLatencyPhase('approval.artifact.read', () =>
        rawAccountArtifactStore.readForUpdate(artifactId, { ...options, prepareRecipients: false }));
      return current ? { ...current,
        update: (content: Parameters<typeof current.update>[0]) => timeWebLatencyPhase('approval.artifact.update', () => current.update(content)) } : null;
    },
  };
  // Decisions read current content under the Artifact's normal access/mode
  // checks. Recipient repair is a separate write, owned by creation/rejoin and
  // the explicit requester-recipient preparation below, not decision authority.
  const readApprovalArtifact = (artifactId: string) => accountArtifactStore.read(artifactId, { prepareRecipients: false,
    ...(params.approvalAuthorizationHeaders ? { authorizationHeaders: params.approvalAuthorizationHeaders } : {}) });
  const prepareRequesterRecipient = async (artifactId: string,
    subject: import('@happier-dev/protocol/approvals/approvalRequestV1').ApprovalRequesterConfirmationV1 | undefined): Promise<void> => {
    if (subject) await accountArtifactStore.prepareApprovalRequesterRecipient({ artifactId,
      requesterAccountId: subject.requesterAccountId, sessionId: subject.personaSessionRef.sessionId });
  };
  const creation = createCliApprovalCreation({ accountArtifactStore: {
    read: (artifactId, options) => accountArtifactStore.read(artifactId, { ...options,
      ...(params.approvalAuthorizationHeaders ? { authorizationHeaders: params.approvalAuthorizationHeaders } : {}) }),
    create: input => accountArtifactStore.create({ ...input,
      ...(params.approvalAuthorizationHeaders ? { authorizationHeaders: params.approvalAuthorizationHeaders } : {}) }),
  }, prepareRequesterRecipient,
    getAccountId: () => readAccountIdFromToken(params.credentials.token) });
  const folderBaseUrl = params.operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const folderStore = runWithServerHttpBaseUrl(folderBaseUrl,
    () => createCliPromptLibraryStore({ credentials: params.credentials, operationContext: params.operationContext }));
  const folderScopeKey = runWithServerHttpBaseUrl(folderBaseUrl,()=>resolveAccountSettingsScopeKey(params.credentials));
  const folderLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const readPluginSkills: NonNullable<SkillActionPortV1['readPluginSkills']> = (signal, skillIds) => readAccountPluginSkills({
    credentials: params.credentials, serverHttpBaseUrl: folderBaseUrl, signal, skillIds, availableOnly: true,
    settings: (params.operationContext ? params.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot())?.settings,
    isCurrent: async () => { folderStore.assertCurrent(); return params.operationContext ? params.operationContext.isCurrent() : true; },
  });
  const organization: ArtifactFolderActionPortV1 = {
    serverId: params.serverId ?? configuration.activeServerId,
    assertCurrent: folderStore.assertCurrent,
    readCatalog: async (signal, key = 'folders') => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
      folderStore.assertCurrent(); signal?.throwIfAborted();
      const projection = await folderStore.readCatalog(signal, key);
      folderStore.assertCurrent(); signal?.throwIfAborted();
      return projection;
    }),
    writeRecord: async (input, signal) => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
      folderStore.assertCurrent(); signal?.throwIfAborted();
      const transport = createCliPromptLibraryStore({ credentials: params.credentials, signal, operationContext: params.operationContext });
      const result = await transport.writeRecord(input);
      if (result.status === 'updated') {
        try {
          const { refreshActivePromptLibraryCatalogAfterChange,prepareActivePromptLibraryRecord } = await import('@/settings/prompts/hydratePromptLibraryCatalog');
          if(params.operationContext)await prepareActivePromptLibraryRecord({credentials:params.credentials,scopeKey:folderScopeKey,
            lifetimeToken:folderLifetimeToken,key:input.record.key,operationContext:params.operationContext});
          else await refreshActivePromptLibraryCatalogAfterChange({ credentials: params.credentials, scopeKey: folderScopeKey,
            lifetimeToken: folderLifetimeToken });
        } catch { /* A durable row receipt survives publication failure or caller cancellation. */ }
      }
      return result;
    }),
    readArtifactHeader: async (artifactId, signal) => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
      folderStore.assertCurrent(); signal?.throwIfAborted();
      const artifact = await accountArtifactStore.readHeader(artifactId, { signal, prepareRecipients: false });
      folderStore.assertCurrent(); signal?.throwIfAborted();
      return artifact ? { header: artifact.header, owned: artifact.access === 'owner' } : null;
    }),
  };

  const readAuthorizationAccountMode = (authorizationHeaders: ArtifactRequestAuthorizationHeaders) => async () => {
    const headers = await authorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' });
    return headers[requesterAccountEncryptionMode] ?? 'unknown';
  };
  const createPromptLibraryStore = (authorizationHeaders?: ArtifactRequestAuthorizationHeaders): PromptLibraryArtifactStore => ({
      organization,
      list: async (options) => {
        const page = await accountArtifactStore.list(options,
          authorizationHeaders ? readAuthorizationAccountMode(authorizationHeaders) : undefined, authorizationHeaders);
        return { items: page.items.map((artifact) => ({ id: artifact.artifactId, header: artifact.header, updatedAtMs: artifact.updatedAt, owned: artifact.access === 'owner',
          ...(artifact.bodyVersion === undefined ? {} : { revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } }),
          ...(artifact.provenance ? { provenance: artifact.provenance } : {}) })),
          coverage: page.coverage, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      },
      read: async (artifactId, options) => {
        const artifact = await accountArtifactStore.read(artifactId, { ...options,
          ...(authorizationHeaders ? { authorizationHeaders } : {}) });
        return projectAccountArtifactToPromptLibraryStoredArtifact(artifact);
      },
      readHeadersByIds: async (ids, options) => {
        const readHeader = accountArtifactStore.createHeaderReader({ ...options, prepareRecipients: false,
          ...(authorizationHeaders ? { authorizationHeaders } : {}) });
        return Promise.allSettled(ids.map(async id => {
          const artifact = await readHeader(id);
          if (!artifact) return null;
          if (artifact.bodyVersion === undefined) throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
          return { id: artifact.artifactId, header: artifact.header, body: null,
            revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
            ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
            owned: artifact.access === 'owner', access: artifact.access };
        }));
      },
      create: async ({ header, body, savedBy, memoryDecisionSource, signal }) => {
        const created = await accountArtifactStore.create({ header, body, savedBy, memoryDecisionSource, signal,
          ...(authorizationHeaders ? { authorizationHeaders } : {}) });
        return created;
      },
      update: async ({ artifactId, expectedRevision, header, body, savedBy, memoryDecisionSource, signal }) => {
        const updated = await accountArtifactStore.update({ artifactId,
          expectedRevision, header, body, savedBy, memoryDecisionSource, signal,
          ...(authorizationHeaders ? { authorizationHeaders } : {}) });
        if (!updated.ok) throw Object.assign(new Error(updated.error), { code: updated.errorCode });
        return { revision: updated.revision };
      },
      delete: async ({ artifactId, expectedRevision, signal }) => {
        const deleted = await accountArtifactStore.delete(artifactId, { expectedRevision, signal,
          ...(authorizationHeaders ? { authorizationHeaders } : {}) });
        if (!deleted.ok) throw Object.assign(new Error(deleted.error), { code: deleted.errorCode });
      },
    });
  const createSkillRules = (authorizationHeaders?: ArtifactRequestAuthorizationHeaders): SkillRulesActionPortV1 => ({
    ...organization,
    listSkills: (signal, skillIds) => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
      folderStore.assertCurrent(); signal?.throwIfAborted();
      const artifactStore = authorizationHeaders ? {
        ...accountArtifactStore,
        read: (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) =>
          accountArtifactStore.read(artifactId, { ...options, authorizationHeaders }),
        list: (options: Parameters<typeof accountArtifactStore.list>[0]) =>
          accountArtifactStore.list(options, readAuthorizationAccountMode(authorizationHeaders), authorizationHeaders),
      } : accountArtifactStore;
      const skills = await readSkillLibraryCatalog({ ...artifactStore, readPluginSkills }, signal, skillIds);
      folderStore.assertCurrent(); signal?.throwIfAborted();
      return skills;
    }),
    ruleWriteContext: () => ({ nowMs: Date.now(), newId: randomUUID }),
  });
  const store: ReturnType<typeof createCliApprovalsArtifactStore> = {
    promptLibraryStore: createPromptLibraryStore(),
    promptLibraryStoreForAuthorization: createPromptLibraryStore,
    readPluginSkills,
    skillRules: createSkillRules(),
    skillRulesForAuthorization: createSkillRules,
    executionRunHostActionApprovalsCreate: async ({ request, onReady }) => {
      const artifactId = randomUUID();
      onReady?.({ artifactId, request });
      const res = await accountArtifactStore.create({ artifactId,
        header: buildExecutionRunHostActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return { artifactId: res.artifactId };
    },
    executionRunHostActionApprovalsGet: async ({ artifactId }) => {
      const artifact = await readApprovalArtifact(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      const parsed = readExecutionRunHostActionApprovalArtifact(header, artifact.body);
      if (!parsed) return null;
      return parsed;
    },
    executionRunHostActionApprovalsUpdate: async ({ artifactId, request }) => {
      const current = await accountArtifactStore.readForUpdate(artifactId);
      if (!current) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const { artifact } = current;
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
      const updated = await current.update({
        header: buildExecutionRunHostActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return updated.ok ? { ok: true } : updated;
    },
    ...createTargetActionApprovalLifecycle({ accountArtifactStore, newId: randomUUID,
      getAccountId: () => readAccountIdFromToken(params.credentials.token), prepareRequesterRecipient }),
    approvalsRecoverExecuting: ({ machineId }) => recoverExecutingApprovals({ machineId, accountArtifactStore,
      approvalsUpdate: store.approvalsUpdate, targetActionApprovalsUpdate: store.targetActionApprovalsUpdate }),
    approvalsList: args => listApprovalArtifactsV1({ ...args,
      readPage: options => accountArtifactStore.list(options),
      read: artifactId => accountArtifactStore.read(artifactId),
    }),

    ...creation,

    approvalsGet: async ({ artifactId, serverId }) => {
      setApprovalTraceArtifactId(artifactId);
      const artifact = await readApprovalArtifact(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      if (!header) return null;
      const body = artifact.body;
      if (typeof body !== 'string') return null;

      const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
      if (parsed?.family === 'built_in' && parsed.request.v === 1
        && !approvalArtifactMatchesServerScope(header, normalizeArtifactServerId(serverId))) {
        return null;
      }
      return parsed?.request ?? null;
    },

    approvalsUpdate: async ({ artifactId, request, serverId, expectedStatus }) => {
      setApprovalTraceArtifactId(artifactId);
      const current = await accountArtifactStore.readForUpdate(artifactId, { authorizationHeaders: params.approvalAuthorizationHeaders });
      if (!current) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found', writeCommitted: false as const };
      const { artifact } = current;
      const existingHeader = artifact.header;
      if (!existingHeader) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found', writeCommitted: false as const };
      }

      const existingBody = artifact.body;
      const existing = readBuiltInApprovalArtifact(existingHeader, existingBody);
      if (existing?.v === 1 && !approvalArtifactMatchesServerScope(existingHeader, normalizeArtifactServerId(serverId))) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found', writeCommitted: false as const };
      }
      if (!existing) {
        return {
          ok: false,
          errorCode: 'subject_mismatch',
          error: 'approval_request_subject_mismatch',
          writeCommitted: false as const,
        };
      }
      // The Protocol subject/transition owner is shared with the UI adapter:
      // immutable subject (settlements may only apply the Action's declared
      // input projection), the lifecycle edges, and the refusal of a repeated
      // `executing` claim. This store only commits against the revision it read.
      const transition = decideApprovalRequestTransition(existing, request, { expectedStatus });
      if (!transition.ok) return { ...transition, writeCommitted: false as const };
      if (!transition.changed) return { ok: true };

      // V1's Home marker belongs to retained history, not replay authority or
      // the deciding caller's routing hint. Keep this validated CAS basis's index.
      const header = buildApprovalRequestArtifactHeaderV1(request, {
        legacyServerId: existing.v === 1 ? normalizeArtifactServerId(existingHeader.serverId) : null,
      });
      const updated = await current.update({
        header, body: JSON.stringify(request) });

      if (updated.ok) return { ok: true };
      return updated;
    },
  };
  return store;
}
