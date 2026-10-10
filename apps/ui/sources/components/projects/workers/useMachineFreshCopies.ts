import * as React from 'react';
import { useProjectAccountRows } from '@/sync/store/hooks';
import { readMachineFreshCopies } from '@/sync/store/domains/projectAccountRows';
import type { MachineFreshCopyRow } from '@/sync/store/domains/projectAccountRows';
import { executeProjectWorkerActionV1, ProjectWorkerActionError } from '@/sync/ops/actions/projectWorkerActions';
import { t } from '@/text';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ProjectWorkerCopyRetireInputV1 } from '@happier-dev/protocol';
import { ProjectWorkerDependencyV1Schema, type ProjectWorkerDependencyV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getWorkspaceSyncCommittedCopyPreview, listWorkspaceSyncStatuses, type WorkspaceSyncCommittedCopyReviewResult } from '@/sync/ops/workspaceSync';

type CopyFacts = Readonly<{ lastCleanSyncAtMs: number | null; sizeBytes: number | null; review: WorkspaceSyncCommittedCopyReviewResult | null }>;
export type MachineFreshCopy = MachineFreshCopyRow & CopyFacts & Readonly<{ name: string; sourceRefId: string; sourceMachineId: string }>;
export type MachineFreshCopyNotice = Readonly<{
  relationshipId: string;
  kind: 'saving' | 'approval' | 'unknown' | 'in_use' | 'failed';
  text: string;
  errorCode?: string;
  details?: unknown;
  /** Typed work the executor reported as still using this copy (in_use, or alongside an unknown result). */
  dependencies?: readonly ProjectWorkerDependencyV1[];
  /** File removal was attempted and its outcome is unknown; the definition may already be retired. */
  filesUnknown?: boolean;
}>;

/** Mounted Machine detail model. Sync owns copy identity, facts and retirement; Actions own consent. */
export function useMachineFreshCopies(serverId: string, machineId: string) {
  const rows = useProjectAccountRows();
  const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
  const accountId = binding?.isCurrent() ? binding.accountId : null;
  const loading = resolution.kind === 'resolving' || Boolean(accountId && (!rows
    || (rows.scope.serverId === serverId && rows.scope.accountId === accountId
      && (rows.status === 'idle' || rows.status === 'loading'))));
  const key = JSON.stringify([serverId, machineId, accountId, binding?.revision]);
  const lifetime = React.useMemo(() => new AbortController(), [binding, key]);
  React.useEffect(() => {
    const retirement = binding?.onRetire(() => lifetime.abort());
    return () => { retirement?.dispose(); lifetime.abort(); };
  }, [binding, lifetime]);
  const rawCopies = React.useMemo(() => {
    if (!rows || !accountId) return null;
    return readMachineFreshCopies({ projectAccountRows: rows }, {
      scope: { accountId, serverId }, machineId,
    });
  }, [accountId, machineId, serverId, rows?.scope, rows?.status, rows?.coverage, rows?.workspaceRefs, rows?.relationships]);
  const [readToken, setReadToken] = React.useState(0);
  const refresh = React.useCallback(() => setReadToken(token => token + 1), []);
  const [facts, setFacts] = React.useState<Readonly<{ key: string; values: ReadonlyMap<MachineFreshCopyRow['relationship'], CopyFacts> }> | null>(null);
  const reviewCopy = React.useCallback((copy: MachineFreshCopyRow, signal: AbortSignal) => {
    if (!accountId || !binding?.isCurrent()) throw new Error('Fresh-copy Account is unavailable');
    return getWorkspaceSyncCommittedCopyPreview({ accountId, signal, request: {
      kind: 'preview', workspace: { serverId, refId: copy.source.id },
      machineId: copy.relationship.controllerMachineId, expectedRelationship: copy.relationship,
      targetMachineId: copy.target.machineId, targetWorkspaceRefId: copy.target.id,
    } });
  }, [accountId, binding, serverId]);
  React.useEffect(() => {
    if (!binding || !rawCopies || lifetime.signal.aborted) return;
    const observation = new AbortController();
    const abort = () => observation.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    void (async () => {
      // One status census per controller; committed root inspection has an exact-copy RPC boundary.
      const controllers = [...new Set(rawCopies.map(copy => copy.relationship.controllerMachineId))];
      const [statusResults, previews] = await Promise.all([
        Promise.allSettled(controllers.map(controllerMachineId => listWorkspaceSyncStatuses({ serverId, controllerMachineId, signal: observation.signal }))),
        Promise.allSettled(rawCopies.map(copy => reviewCopy(copy, observation.signal))),
      ]);
      if (observation.signal.aborted || !binding.isCurrent()) return;
      const values = new Map<MachineFreshCopyRow['relationship'], CopyFacts>();
      rawCopies.forEach((copy, index) => {
        const statusResult = statusResults[controllers.indexOf(copy.relationship.controllerMachineId)];
        const status = statusResult?.status === 'fulfilled' ? statusResult.value.find(status =>
          status.relationshipId === copy.relationship.relationshipId && status.controllerMachineId === copy.relationship.controllerMachineId) : null;
        const preview = previews[index];
        const review = preview?.status === 'fulfilled' ? preview.value : null;
        values.set(copy.relationship, { lastCleanSyncAtMs: status?.lastCleanSyncAtMs ?? null,
          sizeBytes: review?.ok ? review.preview.sizeBytes ?? null : null, review });
      });
      setFacts({ key, values });
    })();
    return () => { observation.abort(); lifetime.signal.removeEventListener('abort', abort); };
  }, [binding, key, lifetime, rawCopies, readToken, reviewCopy, serverId]);
  const [retired, setRetired] = React.useState<Readonly<{ key: string; definitions: ReadonlySet<MachineFreshCopyRow['relationship']> }> | null>(null);
  const copies = React.useMemo(() => rawCopies?.filter(row => retired?.key !== key || !retired.definitions.has(row.relationship)).map(row => {
    const observed = facts?.key === key ? facts.values.get(row.relationship) : null;
    return { ...row, lastCleanSyncAtMs: observed?.lastCleanSyncAtMs ?? null, sizeBytes: observed?.sizeBytes ?? null,
      review: observed?.review ?? null,
      name: row.source.label ?? row.source.rootPath.split(/[\\/]+/).filter(Boolean).at(-1) ?? row.source.rootPath,
      sourceRefId: row.source.id, sourceMachineId: row.source.machineId };
  }) ?? null, [facts, key, rawCopies, retired]);
  const [scopedNotice, setNotice] = React.useState<Readonly<{ key: string; value: MachineFreshCopyNotice | null }> | null>(null);
  // Read the same pending interaction synchronously, before React commits a second click.
  const noticeRef = React.useRef(scopedNotice);
  const keyRef = React.useRef(key);
  keyRef.current = key;
  const copiesRef = React.useRef(copies);
  copiesRef.current = copies;
  const approval = useActionApprovalContinuation({ scopeKey: key, serverId, onExecuted: () => {} });
  const requestApprovalRef = React.useRef(approval.requestApproval);
  requestApprovalRef.current = approval.requestApproval;
  const remove = async (copy: MachineFreshCopy, choice?: Readonly<{ removeFiles?: boolean }>): Promise<void> => {
    const isCurrent = () => Boolean(binding?.isCurrent() && keyRef.current === key && !lifetime.signal.aborted);
    const isCurrentCopy = () => copiesRef.current?.some(row => row.relationship === copy.relationship
      && row.source.id === copy.source.id && row.target.id === copy.target.id);
    if (!accountId || !isCurrent() || !isCurrentCopy()) return;
    const pendingNotice = noticeRef.current?.key === key ? noticeRef.current.value : null;
    if (pendingNotice?.kind === 'saving' || pendingNotice?.kind === 'approval') return;
    const publishNotice = (value: MachineFreshCopyNotice | null) => {
      if (!isCurrent()) return;
      noticeRef.current = { key, value };
      setNotice(noticeRef.current);
    };
    publishNotice({ relationshipId: copy.relationship.relationshipId, kind: 'saving', text: t('projectWorkers.saving') });
    try {
      const input: ProjectWorkerCopyRetireInputV1 = {
        workspace: { serverId, refId: copy.sourceRefId }, machineId: copy.relationship.controllerMachineId,
        expectedRelationship: copy.relationship,
      };
      if (choice?.removeFiles === true) {
        const review = await reviewCopy(copy, lifetime.signal);
        if (!isCurrent() || !isCurrentCopy()) return;
        if (!review.ok) throw new ProjectWorkerActionError(review.errorCode);
        input.removeTargetCopy = review.retirementInput.removeTargetCopy;
      }
      const result = await executeProjectWorkerActionV1('projects.worker.copy.retire', input, {
        expectedAccountId: accountId, signal: lifetime.signal,
        onApprovalPending: registration => {
          if (!isCurrent()) return;
          publishNotice({ relationshipId: copy.relationship.relationshipId, kind: 'approval', text: t('projectWorkers.approvalPending') });
          requestApprovalRef.current(registration);
        },
      });
      if (!isCurrent()) return;
      if (result.status === 'retired') {
        setRetired(current => ({ key, definitions: new Set([
          ...(current?.key === key ? current.definitions : []), copy.relationship,
        ]) }));
        publishNotice(null);
      }
    } catch (error) {
      const code = error instanceof ProjectWorkerActionError ? error.errorCode : '';
      const details = error instanceof ProjectWorkerActionError ? error.details : undefined;
      const detailRecord = details !== null && typeof details === 'object' ? details : null;
      const kind = detailRecord && Reflect.get(detailRecord, 'kind') === 'outcomeUnknown'
        || code === 'outcome_unknown' || code === 'outcomeUnknown' ? 'unknown'
        : code === 'workspace_sync_relationship_in_use' || (detailRecord && Array.isArray(Reflect.get(detailRecord, 'dependencies')))
          ? 'in_use' : 'failed';
      const dependencies = ProjectWorkerDependencyV1Schema.array().safeParse(detailRecord ? Reflect.get(detailRecord, 'dependencies') : undefined);
      const filesUnknown = kind === 'unknown' && code === 'workspace_copy_removal_unknown';
      publishNotice({ relationshipId: copy.relationship.relationshipId, kind, errorCode: code, details,
        ...(dependencies.success && dependencies.data.length > 0 ? { dependencies: dependencies.data } : {}),
        ...(filesUnknown ? { filesUnknown } : {}),
        text: t(filesUnknown ? 'projectWorkers.removeFilesUnknown' : kind === 'unknown' ? 'projectWorkers.removeUnknown' : kind === 'in_use' ? 'projectWorkers.removeInUse' : 'projectWorkers.removeFailed') });
    } finally {
      // Observation only, including unknown/in-use; never repeat an effect to refresh a row.
      if (isCurrent()) refresh();
    }
  };
  const notice = scopedNotice?.key === key ? scopedNotice.value : null;
  return { copies, loading, remove, notice, refresh, approvalId: approval.approvalId, approvalPending: approval.approvalPending,
    refreshApproval: approval.refresh, busy: notice?.kind === 'saving' || notice?.kind === 'approval' };
}
