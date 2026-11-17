import { join, resolve } from 'node:path';
import type { ApiMachineClient } from '@/api/apiMachine';
import { readScmAccountScope, readScmExecutionAuthorization, resolveScmAccountStorageKey, runWithScmAccountScope } from '../accountScope';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import * as comparison from '../comparisons/captureScmComparison';
import type { ScmComparisonOperations } from '../comparisons/comparisonOperations';
import type { StoredScmComparison } from '../comparisons/comparisonStorage';
import { executeScmCommitPlanAction, type ScmCommitPlanResultStore } from '../commitPlans/executeScmCommitPlanAction';
import { createWorkspaceEffectScmRegistry, type AdmittedScmEffect } from '@/workspaces/activation/workspaceEffect';
import { runMemberScmEffect } from './memberScmRead';
import { buildScmComparisonIdentity, ScmComparisonSourceSchema } from '@happier-dev/protocol/scm/comparison';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { resolveCwd } from '../runtime';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { readRepositoryCheckpointTranscriptEvidence } from '../checkpoints/recoverRepositoryCheckpointEvidence';

type Native = Pick<Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>>, 'agentIsolation' | 'requesterIdentity' | 'memberIdentity'>;
type ComparisonInput = Parameters<ScmComparisonOperations['read']>[0];
type CaptureInput = Omit<Parameters<ScmComparisonOperations['capture']>[0], 'registry' | 'signal' | 'captureCommitTarget' | 'readTranscriptPage' | 'readPullRequestComparisonPage'>;
type CommitInput = Omit<Parameters<ScmComparisonOperations['commitPlan']>[0], 'registry' | 'signal' | 'store'>;
export type MemberScmComparisonEffect = Readonly<{
  kind: 'scm_comparison'; workspaceRoot: string; scm: AdmittedScmEffect;
}> & (
  | { operation: 'capture'; input: CaptureInput }
  | { operation: 'read' | 'index'; input: ComparisonInput }
  | { operation: 'page'; input: Parameters<ScmComparisonOperations['page']>[0] }
  | { operation: 'file'; input: Parameters<ScmComparisonOperations['file']>[0] }
  | { operation: 'investigate'; input: Parameters<ScmComparisonOperations['investigate']>[0] }
  | { operation: 'delete'; input: Parameters<ScmComparisonOperations['delete']>[0] }
  | { operation: 'commitPlan'; input: CommitInput }
);

export type MemberScmComparisonServices = Readonly<{
  comparisonShelf: comparison.ScmComparisonShelf;
  comparisonTranscriptPage?: Parameters<ScmComparisonOperations['capture']>[0]['readTranscriptPage'];
  comparisonPullRequestPage?: Parameters<ScmComparisonOperations['capture']>[0]['readPullRequestComparisonPage'];
  comparisonCommitStore?: ScmCommitPlanResultStore;
}>;

const unavailable = () => Object.assign(new Error('Captured comparison evidence is unavailable'), { code: 'DIFF_UNAVAILABLE' });

/** Host custody stays here; only the requested capture/result is exposed to one finite member effect. */
export function createMemberScmComparisonOperations(binding: Readonly<{ native: Native; signal: AbortSignal }>): ScmComparisonOperations {
  const accountId = readScmAccountScope();
  const executionAuthorization = readScmExecutionAuthorization();
  const member = binding.native.memberIdentity;
  const identity = binding.native.requesterIdentity;
  if (!accountId || !member || identity.kind !== 'isolated') throw unavailable();
  const refNamespace = resolveScmAccountStorageKey(accountId);
  const inAccount = <T>(effect: () => T) => runWithScmAccountScope(accountId, effect, executionAuthorization);
  const run = async <T>(operation: Omit<MemberScmComparisonEffect, 'kind' | 'workspaceRoot' | 'scm'>,
    services: MemberScmComparisonServices): Promise<T> => runMemberScmEffect<T>({
      agentIsolation: binding.native.agentIsolation, requesterIdentity: identity, workspaceRoot: member.workspaceRoot,
      signal: binding.signal, effect: scm => ({ ...operation, kind: 'scm_comparison', workspaceRoot: member.workspaceRoot, scm }),
      services,
    });
  const shelf = (scope: Readonly<{ comparisonId: string; sessionId?: string }>, remove = false): comparison.ScmComparisonShelf => {
    let legacy: StoredScmComparison | undefined;
    const check = (candidate: typeof scope) => {
      if (candidate.comparisonId !== scope.comparisonId || candidate.sessionId !== scope.sessionId) throw unavailable();
    };
    return {
      refNamespace,
      materializeEndpoints: (candidate, writer) => { check(candidate);
        return inAccount(() => comparison.hostScmComparisonShelf.materializeEndpoints(scope, writer)); },
      withStored: (candidate, consume) => {
        check(candidate);
        return inAccount(() => comparison.hostScmComparisonShelf.withStored(scope, (reader, sessionId) => {
          legacy = reader.legacy ? reader.stored : undefined;
          return consume(reader, sessionId);
        }));
      },
      // The only read-side write is the canonical legacy upgrade: retain the host's original bytes.
      write: candidate => { check(candidate); if (!legacy) throw unavailable();
        return inAccount(() => comparison.hostScmComparisonShelf.write(scope, legacy!)); },
      remove: (candidate, stored) => { check(candidate); if (!remove) throw unavailable();
        return inAccount(() => comparison.hostScmComparisonShelf.remove(scope, stored)); },
    };
  };
  return {
    capture: async input => {
      const { registry: _registry, signal: _signal, captureCommitTarget: _target, readTranscriptPage, readPullRequestComparisonPage, ...request } = input;
      const source = ScmComparisonSourceSchema.parse(request.source);
      const sessionId = request.sessionId ?? ('sessionId' in source && typeof source.sessionId === 'string' ? source.sessionId : undefined);
      let saved: Readonly<{ scope: Parameters<comparison.ScmComparisonShelf['write']>[0]; stored: StoredScmComparison;
        identity: Parameters<comparison.ScmComparisonShelf['write']>[2] }> | undefined;
      const captured = await run<Awaited<ReturnType<ScmComparisonOperations['capture']>>>({ operation: 'capture', input: request }, {
        comparisonShelf: {
          refNamespace,
          materializeEndpoints: async () => { throw unavailable(); },
          withStored: async () => { throw unavailable(); }, remove: async () => { throw unavailable(); },
          write: async (scope, stored, identity) => { saved = { scope, stored, identity }; },
        },
        ...(readTranscriptPage && sessionId && (source.kind === 'session' || source.kind === 'turnCheckpoint') ? {
          comparisonTranscriptPage: (candidate: Parameters<NonNullable<typeof readTranscriptPage>>[0]) => {
            const scopeId = candidate.scopeId;
            const rootPath = scopeId?.startsWith(`${sessionId}:`) ? scopeId.slice(sessionId.length + 1) : undefined;
            if (candidate.sessionId !== sessionId || !scopeId || !rootPath
              || !isCanonicalAbsolutePathInsideRoot(member.workspaceRoot, rootPath)
              || !isCanonicalAbsolutePathInsideRoot(rootPath, resolve(request.cwd))) throw unavailable();
            return inAccount(() => readRepositoryCheckpointTranscriptEvidence({
              readTranscriptPage, sessionId, scopeId, afterSeq: candidate.afterSeq,
              ...(source.kind === 'turnCheckpoint' ? {
                turnId: source.turnId ?? request.turnId,
                checkpointReceiptId: source.checkpointReceiptId ?? request.checkpointReceiptId,
              } : {}),
            }));
          },
        } : {}),
        ...(readPullRequestComparisonPage && source.kind === 'pullRequest' && source.locator.sourceAction ? {
          comparisonPullRequestPage: (candidate: Parameters<NonNullable<typeof readPullRequestComparisonPage>>[0]) =>
            inAccount(() => readPullRequestComparisonPage({ sourceAction: source.locator.sourceAction!,
              ...(candidate.continuation ? { continuation: candidate.continuation } : {}) })),
        } : {}),
      });
      // The child can publish only the newly returned capture, never select an Account shelf path.
      if (!saved?.identity || saved.scope.comparisonId !== captured.comparison.id || saved.stored.comparison.id !== captured.comparison.id
        || saved.scope.sessionId !== saved.stored.sessionId
        || saved.scope.sessionId !== sessionId
        || !isCanonicalAbsolutePathInsideRoot(member.workspaceRoot, saved.stored.comparison.repository.rootPath)
        || !isCanonicalAbsolutePathInsideRoot(saved.stored.comparison.repository.rootPath, resolve(request.cwd))
        || buildScmComparisonIdentity({ ...saved.identity, source, sessionId,
          ...(source.kind === 'turnCheckpoint' ? {
            turnId: source.turnId ?? request.turnId ?? saved.identity.turnId,
            checkpointReceiptId: source.checkpointReceiptId ?? request.checkpointReceiptId,
            turnEvidenceMode: source.evidenceMode ?? request.turnEvidenceMode ?? 'checkpoint',
          } : {}),
          repositoryRootPath: saved.stored.comparison.repository.rootPath,
          beforeOid: saved.stored.comparison.endpoints.before, afterOid: saved.stored.comparison.endpoints.after }) !== captured.comparison.id) throw unavailable();
      await inAccount(() => comparison.hostScmComparisonShelf.write(saved!.scope, saved!.stored));
      return captured;
    },
    read: input => run({ operation: 'read', input }, { comparisonShelf: shelf(input) }),
    index: input => run({ operation: 'index', input }, { comparisonShelf: shelf(input) }),
    page: input => run({ operation: 'page', input }, { comparisonShelf: shelf(input) }),
    file: input => run({ operation: 'file', input }, { comparisonShelf: shelf(input) }),
    investigate: input => {
      const runtimeHome = binding.native.agentIsolation.read()?.launch?.runtimeHome;
      if (!runtimeHome) throw unavailable();
      return run({ operation: 'investigate', input: { ...input,
        directory: join(runtimeHome, 'scm', input.comparisonId) } }, { comparisonShelf: shelf(input) });
    },
    delete: input => run({ operation: 'delete', input }, { comparisonShelf: shelf(input, true) }),
    commitPlan: async input => {
      const { registry: _registry, signal: _signal, store = scmDiffSummaryResultStore, ...request } = input;
      const resultId = input.input && typeof input.input === 'object' ? Reflect.get(input.input, 'resultId') : undefined;
      if (typeof resultId !== 'string') throw unavailable();
      const scope = { cwd: input.cwd, resultId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
      const saved = await inAccount(() => store.readStoredScope(scope));
      const comparisonId = saved?.result.output.comparison?.id;
      if (!comparisonId) return { success: false, errorCode: 'result_not_found', error: 'Saved result is unavailable in this repository/session.' };
      const check = (candidate: typeof scope) => {
        if (candidate.resultId !== scope.resultId || resolve(candidate.cwd) !== resolve(scope.cwd) || candidate.sessionId !== scope.sessionId) throw unavailable();
      };
      return run({ operation: 'commitPlan', input: request }, { comparisonShelf: shelf({ comparisonId, sessionId: saved.sessionId }),
        comparisonCommitStore: {
          read: candidate => { check(candidate); return inAccount(() => store.read(scope)); },
          readStoredScope: candidate => { check(candidate); return inAccount(() => store.readStoredScope(scope)); },
          beginApplication: candidate => { check(candidate); return inAccount(() => store.beginApplication({ ...candidate, ...scope })); },
          mutateApplication: (candidate, transition) => { check(candidate); return inAccount(() => store.mutateApplication(scope, transition)); },
        } });
    },
  };
}

/** Every Git command and direct filesystem operation runs under the actual member UID. */
export async function executeMemberScmComparison(effect: MemberScmComparisonEffect, signal: AbortSignal,
  services: MemberScmComparisonServices): Promise<unknown> {
  const folder = resolveCwd(effect.input.cwd, effect.workspaceRoot, { kind: 'restrictedRoots', roots: [effect.workspaceRoot] });
  if (!folder.ok) throw new PluginError({ code: SCM_OPERATION_ERROR_CODES.INVALID_PATH, message: folder.error });
  const registry = await createWorkspaceEffectScmRegistry(effect.scm, {});
  try {
    return await comparison.runWithScmComparisonShelf(services.comparisonShelf, async () => {
      switch (effect.operation) {
        case 'capture': return comparison.captureScmComparison({ ...effect.input, registry: registry.registry, signal,
          ...(services.comparisonTranscriptPage ? { readTranscriptPage: services.comparisonTranscriptPage } : {}),
          ...(services.comparisonPullRequestPage ? { readPullRequestComparisonPage: services.comparisonPullRequestPage } : {}) });
        case 'read': return comparison.readCapturedScmComparison(effect.input);
        case 'index': return comparison.readCapturedScmComparisonIndex(effect.input);
        case 'page': return comparison.readCapturedScmComparisonPage(effect.input);
        case 'file': return comparison.readCapturedScmComparisonFile(effect.input);
        case 'investigate': return comparison.prepareCapturedScmComparisonInvestigation(effect.input);
        case 'delete': return comparison.deleteCapturedScmComparison(effect.input);
        case 'commitPlan': {
          if (!services.comparisonCommitStore) throw unavailable();
          return executeScmCommitPlanAction({ ...effect.input, registry: registry.registry, signal, store: services.comparisonCommitStore });
        }
      }
    });
  } finally { await registry.dispose(); }
}
