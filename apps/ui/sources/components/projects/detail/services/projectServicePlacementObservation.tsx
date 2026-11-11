import * as React from 'react';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ProjectServicePlacementGetResultV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { FrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { useProjectServiceManagedMachine } from './useProjectServiceManagedMachine';
import type { ProjectServiceSource } from './ProjectServicePlacementControls';
import { useActionOperation, useProjectServiceActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors, compareProjectServiceActionOperations } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerAccountScope, useServerScopedMachine } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import { createProjectServiceStartApprovalArtifactIdsSelector } from '@/sync/domains/artifacts/approvalArtifacts';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServiceRelocationOutcome } from './serviceRelocationAction';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { invalidateLocalServiceLauncherStores } from '@/sync/domains/local/services/launch/sharedStore';
import { LocalServiceManagedServiceActionTargetV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { LocalServiceStartApprovalReviewV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { approvalArtifactBodyMatchesHeaderV1, APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useApprovalArtifact } from '@/components/approvals/useApprovalArtifact';
import { sync } from '@/sync/sync';

const pendingStartApprovals = { kinds: [APPROVAL_ARTIFACT_KINDS_V1.builtIn], approvalStates: ['approved', 'executing'] } as const;

export type ProjectServicePlacementOperationAttachment = Readonly<{
  operationId: string;
  destination: ProjectExecutionChoiceV1;
}>;

type OperationObservation = Readonly<{
  operation: ReturnType<typeof useActionOperation>;
  stop: Pick<ReturnType<typeof useActionOperationStopControl>, 'pending' | 'stopRequested' | 'requestStop'>;
}>;
type Entry = Readonly<{ attachment: ProjectServicePlacementOperationAttachment; observation?: OperationObservation; bindingObserved?: boolean }>;
type ManagedSelection = Readonly<{ scopeKey: string; draft: ManagedMachineSelectionDraft; purpose: 'start' | 'move' }>;
type ManagedContinuation = ReturnType<typeof useProjectServiceManagedMachine>;
type ApprovedStart = Readonly<{ serviceName: string; machineId: string; requestId: string }>;
type ReadyPlacement = Extract<ProjectServicePlacementGetResultV1, { status: 'ready' }>;
type ObservationContext = Readonly<{
  source: ProjectServiceSource;
  entries: ReadonlyMap<string, Entry>;
  attach: (serviceName: string, attachment: ProjectServicePlacementOperationAttachment) => void;
  clear: (serviceName: string) => void;
  acknowledgeBinding: (serviceName: string, operationId: string) => void;
  pendingRequests: ReadonlySet<string>;
  approvedStarts: ReadonlyMap<string, ApprovedStart>;
  startRequests: ReadonlyMap<string, ProjectExecutionChoiceV1 | null>;
  observedPlacements: ReadonlyMap<string, ReadyPlacement>;
  observePlacement: (name: string, placement: ReadyPlacement | null) => void;
  executeMove: (serviceName: string, destination: ProjectExecutionChoiceV1,
    execute: (signal: AbortSignal, onApprovalPending: (registration: ActionApprovalRegistration) => void) => Promise<ServiceRelocationOutcome>) => Promise<ServiceRelocationOutcome | null>;
  runtimeActionExecute?: FrontDoorRuntimeActionExecutor;
  managedSelections: ReadonlyMap<string, ManagedSelection>;
  managedContinuations: ReadonlyMap<string, ManagedContinuation>;
  selectManaged: (name: string, scopeKey: string, draft: ManagedMachineSelectionDraft | null, purpose: 'start' | 'move') => void;
  observeManaged: (name: string, scopeKey: string) => () => void;
  resolveStart: (target: LocalServiceLaunchTarget, signal?: AbortSignal) => Promise<ProjectExecutionChoiceV1 | null> | undefined;
  executeStart: (target: LocalServiceLaunchTarget, choice: ProjectExecutionChoiceV1 | undefined,
    resolveDestination: (choice?: ProjectExecutionChoiceV1) => Promise<ProjectExecutionChoiceV1 | undefined>,
    execute: (choice?: ProjectExecutionChoiceV1) => Promise<unknown>, signal?: AbortSignal) => Promise<unknown>;
}>;
const Context = React.createContext<ObservationContext | null>(null);
const StartContext = React.createContext<ObservationContext['executeStart'] | undefined>(undefined);

/** List and pushed detail can coexist; one owner retains their service's single purchase/start intent. */
function ServiceManagedMachineObserver(props: Readonly<{
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding | null;
  runtimeActionExecute?: FrontDoorRuntimeActionExecutor;
  name: string;
  selection: ManagedSelection;
  publish: (name: string, value: ManagedContinuation) => void;
}>) {
  const managed = useProjectServiceManagedMachine({ scopeKey: props.selection.scopeKey,
    serverId: props.source.serverId, binding: props.binding, runtimeActionExecute: props.runtimeActionExecute });
  React.useLayoutEffect(() => managed.select(props.selection.draft), [managed.select, props.selection.draft]);
  React.useLayoutEffect(() => props.publish(props.name, managed), [props.name, props.publish, managed]);
  return null;
}

/** One canonical operation/Cancel observer for each accepted service, shared by both row bodies. */
function ServiceOperationObserver(props: Readonly<{
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding;
  serviceName: string;
  attachment: ProjectServicePlacementOperationAttachment;
  publish: (serviceName: string, operationId: string, observation: OperationObservation) => void;
}>) {
  const record = useActionOperation({ serverId: props.source.serverId, operationId: props.attachment.operationId });
  const operation = record?.snapshot.scope.accountId === props.binding.accountId
    && (record.snapshot.actionId === 'projects.service.relocate' || record.snapshot.actionId === 'localServices.launcher.start') ? record : null;
  const active = operation?.snapshot.state === 'accepted' || operation?.snapshot.state === 'running';
  const stop = useActionOperationStopControl(active ? operation : null);
  const observation = React.useMemo(() => ({ operation,
    stop: { pending: stop.pending, stopRequested: stop.stopRequested, requestStop: stop.requestStop } }),
  [operation, stop.pending, stop.stopRequested, stop.requestStop]);
  React.useEffect(() => {
    props.publish(props.serviceName, props.attachment.operationId, observation);
  }, [observation, props.attachment.operationId, props.publish, props.serviceName]);
  const state = operation?.snapshot.state;
  React.useEffect(() => {
    if (!props.binding.isCurrent() || (state !== 'succeeded' && state !== 'failed' && state !== 'cancelled')) return;
    // Settlement is independent of inventory scan generations. Re-read native facts,
    // including absence, rather than leaving a cached Running row until page reload.
    const machines = new Set([props.source.machineId, operation!.snapshot.scope.machineId]);
    const destination = props.attachment.destination;
    if (destination.kind === 'workers' && destination.destination.kind === 'machine') machines.add(destination.destination.machineId);
    for (const machineId of machines) invalidateLocalServiceLauncherStores({ serverId: props.binding.scope.serverId, machineId,
      accountId: props.binding.accountId, credentialKey: props.binding.credentialKey });
  }, [state, props.attachment, props.binding, props.source.machineId, props.source.serverId]);
  return null;
}

/** Independent Service requests keep independent Artifact readers, even while another Ask is open. */
function ServiceMoveApprovalObserver(props: Readonly<{
  source: ProjectServiceSource;
  serviceName: string;
  registration: ActionApprovalRegistration;
}>) {
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify(['projects.service.relocate', props.source.serverId, props.source.refId, props.serviceName]),
    serverId: props.source.serverId,
    onExecuted: () => {},
  });
  React.useEffect(() => approval.requestApproval(props.registration), [approval.requestApproval, props.registration]);
  return null;
}

/** Header-only socket updates wake the existing exact-Home Artifact body reader. */
function ServiceStartApprovalObserver(props: Readonly<{
  artifactId: string;
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding;
  publish: (artifactId: string, start: ApprovedStart | null) => void;
}>) {
  const { artifact } = useApprovalArtifact({ artifactId: props.artifactId, serverId: props.source.serverId,
    scope: props.binding.scope, observeWhileUnfocused: true });
  React.useLayoutEffect(() => {
    let start: ApprovedStart | null = null;
    const parsed = artifact?.isDecrypted !== false && typeof artifact?.body === 'string'
      ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null;
    if (props.binding.isCurrent() && parsed?.family === 'built_in' && parsed.request.v === 2
      && parsed.request.actionId === 'localServices.launcher.start'
      && (parsed.request.status === 'approved' || parsed.request.status === 'executing')
      && parsed.request.executionOriginV1.accountId === props.binding.accountId
      && areServerProfileIdentifiersEquivalent(parsed.request.executionOriginV1.serverIdentityId
        ?? parsed.request.executionOriginV1.serverId, props.source.serverId)) {
      const preview = parsed.request.preview;
      const review = LocalServiceStartApprovalReviewV1Schema.safeParse(preview && typeof preview === 'object'
        && 'serviceStartReview' in preview ? preview.serviceStartReview : undefined);
      const declaration = review.success ? review.data.request.declaration : null;
      if (review.success && sameStrictJsonValue(review.data.request, parsed.request.actionArgs)
        && declaration?.selection.kind === 'manifest' && declaration.workspaceRefId === props.source.refId
        && review.data.request.workspace?.machineId === props.source.machineId
        && areServerProfileIdentifiersEquivalent(review.data.target.serverId, props.source.serverId)) {
        start = { serviceName: declaration.selection.name, machineId: review.data.target.machineId,
          requestId: parsed.request.executionOriginV1.requestId };
      }
    }
    props.publish(props.artifactId, start);
  }, [artifact, props.artifactId, props.binding, props.publish, props.source.machineId, props.source.refId, props.source.serverId]);
  React.useEffect(() => () => props.publish(props.artifactId, null), [props.artifactId, props.publish]);
  return null;
}

function ScopedObservationProvider(props: Readonly<{
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding | null;
  runtimeActionExecute?: FrontDoorRuntimeActionExecutor;
  children: React.ReactNode;
}>) {
  const [retainedEntries, setEntries] = React.useState<ReadonlyMap<string, Entry>>(() => new Map());
  const activeScope = useActiveServerAccountScope();
  React.useEffect(() => {
    if (!props.binding?.isCurrent() || !activeScope || activeScope.accountId !== props.binding.accountId
      || !areServerProfileIdentifiersEquivalent(activeScope.serverId, props.source.serverId)) return;
    return sync.observeArtifactInventory(activeScope, pendingStartApprovals, { refreshOnAdmission: true });
  }, [props.binding, activeScope?.serverId, activeScope?.accountId, props.source.serverId]);
  const [approvalObservations, setApprovalObservations] = React.useState<ReadonlyMap<string, ApprovedStart>>(() => new Map());
  const publishApproval = React.useCallback((artifactId: string, start: ApprovedStart | null) => setApprovalObservations(current => {
    const previous = current.get(artifactId);
    if (previous?.serviceName === start?.serviceName && previous?.machineId === start?.machineId
      && previous?.requestId === start?.requestId) return current;
    const next = new Map(current);
    if (start) next.set(artifactId, start); else next.delete(artifactId);
    return next;
  }), []);
  const selectApprovalIds = React.useMemo(() => createProjectServiceStartApprovalArtifactIdsSelector(props.source),
    [props.source.serverId, props.source.machineId, props.source.refId]);
  const approvalIds = storage(useShallow(state => props.binding?.isCurrent() && activeScope?.accountId === props.binding.accountId
    && areServerProfileIdentifiersEquivalent(activeScope.serverId, props.source.serverId)
    ? selectApprovalIds(state.artifacts)
    : []));
  const previousApprovedStarts = React.useRef<ReadonlyMap<string, ApprovedStart>>(new Map());
  const approvedStarts = React.useMemo(() => {
    const result = new Map<string, ApprovedStart>();
    for (const id of approvalIds) {
      const start = approvalObservations.get(id);
      if (start && !result.has(start.serviceName)) result.set(start.serviceName, start);
    }
    const previous = previousApprovedStarts.current;
    if (previous.size === result.size && [...result].every(([name, start]) => previous.get(name) === start)) return previous;
    previousApprovedStarts.current = result;
    return result;
  }, [approvalIds, approvalObservations]);
  const cleared = React.useRef(new Set<string>());
  const received = useProjectServiceActionOperations({ ...props.source, accountId: props.binding?.accountId ?? null });
  const entries = React.useMemo(() => {
      const current = retainedEntries;
      let next: Map<string, Entry> | null = null;
      // Retention bridges row remounts, not removal from the canonical operation
      // store (for example after worker history is replaced). Reconnecting records
      // remain there and keep their uncertainty; a missing record cannot own a Move.
      for (const [name, entry] of current) {
        if (actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
          serverId: props.source.serverId, operationId: entry.attachment.operationId,
        })) continue;
        next ??= new Map(current);
        next.delete(name);
      }
      for (const operation of received) {
        const { snapshot } = operation;
        const domain = snapshot.domainRef;
        if (domain?.kind !== 'projectService' || domain.declaration.selection.kind !== 'manifest'
          || cleared.current.has(snapshot.operationId)) continue;
        const name = domain.declaration.selection.name;
        const previous = (next ?? current).get(name);
        if (previous?.attachment.operationId === snapshot.operationId) continue;
        const retained = previous && actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
          serverId: props.source.serverId, operationId: previous.attachment.operationId,
        });
        if (retained && (retained.snapshot.state === 'accepted' || retained.snapshot.state === 'running')
          && compareProjectServiceActionOperations(retained, operation) <= 0) continue;
        const destination = snapshot.actionId === 'localServices.launcher.start' ? snapshot.scope
          : domain.destinationWorkspace ?? domain.workspace;
        next ??= new Map(current);
        next.set(name, { bindingObserved: snapshot.state === 'succeeded', attachment: { operationId: snapshot.operationId,
          destination: destination.machineId === props.source.machineId ? { kind: 'primary' }
            : { kind: 'workers', destination: { kind: 'machine', machineId: destination.machineId } } } });
      }
      return next ?? current;
  }, [received, retainedEntries, props.source.machineId, props.source.serverId]);
  const entriesRef = React.useRef(entries);
  entriesRef.current = entries;
  const requests = React.useRef(new Map<string, AbortController>());
  const [pendingRequests, setPendingRequests] = React.useState<ReadonlySet<string>>(() => new Set());
  const [startRequests, setStartRequests] = React.useState<ReadonlyMap<string, ProjectExecutionChoiceV1 | null>>(() => new Map());
  const observedPlacements = React.useRef(new Map<string, ReadyPlacement>());
  const observePlacement = React.useCallback((name: string, placement: ReadyPlacement | null) => {
    // Moving between Running/ready groups remounts placement controls. Their
    // initial unread state cannot erase this scope's last observed destination.
    // Start still resolves fresh placement before dispatching any native effect.
    if (placement) observedPlacements.current.set(name, placement);
  }, []);
  const [approvals, setApprovals] = React.useState<ReadonlyMap<string, ActionApprovalRegistration>>(() => new Map());
  React.useEffect(() => {
    const abort = () => { for (const request of requests.current.values()) request.abort(); requests.current.clear(); };
    const retirement = props.binding?.onRetire(abort);
    return () => { retirement?.dispose(); abort(); };
  }, [props.binding]);
  const [managedSelections, setManagedSelections] = React.useState<ReadonlyMap<string, ManagedSelection>>(() => new Map());
  const [managedContinuations, setManagedContinuations] = React.useState<ReadonlyMap<string, ManagedContinuation>>(() => new Map());
  const consumers = React.useRef(new Map<string, number>());
  const removeManaged = React.useCallback((name: string) => {
    setManagedSelections(current => { if (!current.has(name)) return current; const next = new Map(current); next.delete(name); return next; });
    setManagedContinuations(current => { if (!current.has(name)) return current; const next = new Map(current); next.delete(name); return next; });
  }, []);
  const observeManaged = React.useCallback((name: string, scopeKey: string) => {
    consumers.current.set(name, (consumers.current.get(name) ?? 0) + 1);
    setManagedSelections(current => {
      if (!current.has(name) || current.get(name)?.scopeKey === scopeKey) return current;
      const next = new Map(current); next.delete(name); return next;
    });
    return () => {
      const count = (consumers.current.get(name) ?? 1) - 1;
      if (count) consumers.current.set(name, count);
      else { consumers.current.delete(name); removeManaged(name); }
    };
  }, [removeManaged]);
  const selectManaged = React.useCallback((name: string, scopeKey: string, draft: ManagedMachineSelectionDraft | null, purpose: 'start' | 'move') => {
    if (!draft) { removeManaged(name); return; }
    setManagedSelections(current => new Map(current).set(name, { scopeKey, draft, purpose }));
  }, [removeManaged]);
  const publishManaged = React.useCallback((name: string, value: ManagedContinuation) => setManagedContinuations(current =>
    current.get(name) === value ? current : new Map(current).set(name, value)), []);
  const selectedRef = React.useRef(managedSelections);
  selectedRef.current = managedSelections;
  const managedRef = React.useRef(managedContinuations);
  managedRef.current = managedContinuations;
  const resolveStart = React.useCallback((target: LocalServiceLaunchTarget, signal?: AbortSignal) => {
    const declaration = target.declaration;
    if (!target.workspace || !declaration || declaration.selection.kind !== 'manifest'
      || declaration.workspaceRefId !== props.source.refId || target.workspace.machineId !== props.source.machineId
      || !areServerProfileIdentifiersEquivalent(target.workspace.serverId, props.source.serverId)) return undefined;
    const name = declaration.selection.name;
    const selected = selectedRef.current.get(name);
    if (selected) return selected.purpose === 'start' ? managedRef.current.get(name)?.acquire(signal) ?? Promise.resolve(null)
      : Promise.resolve(null);
    return undefined;
  }, [props.source.machineId, props.source.refId, props.source.serverId]);
  const executeStart = React.useCallback<ObservationContext['executeStart']>(async (target, choice, resolveDestination, execute, signal) => {
    const declaration = target.declaration;
    if (!target.workspace || declaration?.selection.kind !== 'manifest'
      || declaration.workspaceRefId !== props.source.refId || target.workspace.machineId !== props.source.machineId
      || !areServerProfileIdentifiersEquivalent(target.workspace.serverId, props.source.serverId)) return execute(await resolveDestination(choice));
    const name = declaration.selection.name;
    // This is the existing local Start invocation's lifetime. Native operations
    // take over its presentation as soon as they are observed.
    setStartRequests(current => new Map(current).set(name, choice ?? observedPlacements.current.get(name)?.placement.runsOn ?? null));
    try {
      const selected = choice ?? await resolveStart(target, signal);
      if (selected === null || signal?.aborted) return undefined;
      const resolved = await resolveDestination(selected);
      if (!resolved || signal?.aborted) return undefined;
      setStartRequests(current => new Map(current).set(name, resolved));
      return await execute(resolved);
    } finally {
      setStartRequests(current => { const next = new Map(current); next.delete(name); return next; });
    }
  }, [props.source.machineId, props.source.refId, props.source.serverId, resolveStart]);
  React.useEffect(() => {
    const retirement = props.binding?.onRetire(() => setEntries(new Map()));
    return () => retirement?.dispose();
  }, [props.binding]);
  const attach = React.useCallback((serviceName: string, attachment: ProjectServicePlacementOperationAttachment) => {
    if (!props.binding?.isCurrent()) return;
    const operation = actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
      serverId: props.source.serverId, operationId: attachment.operationId,
    });
    if (!operation || operation.snapshot.scope.accountId !== props.binding.accountId
      || operation.snapshot.actionId !== 'projects.service.relocate') return;
    // Exact request/Account admission is proven by executeServiceRelocationAction.
    // The domain reference is the actual old/new workspace, never a guessed Source ref.
    setEntries(current => new Map(current).set(serviceName, { attachment }));
  }, [props.binding, props.source.serverId]);
  const executeMove = React.useCallback<ObservationContext['executeMove']>(async (serviceName, destination, execute) => {
    if (!props.binding?.isCurrent() || requests.current.has(serviceName)) return null;
    const request = new AbortController();
    requests.current.set(serviceName, request);
    setPendingRequests(new Set(requests.current.keys()));
    try {
      const result = await execute(request.signal, registration => {
        if (!request.signal.aborted) setApprovals(current => new Map(current).set(serviceName, registration));
      });
      if (request.signal.aborted || !props.binding.isCurrent()) return null;
      if (result.status === 'accepted') {
        publishActionOperationObservation({ serverId: props.source.serverId, machineId: result.operation.scope.machineId,
          observation: 'available', snapshots: [result.operation] });
        attach(serviceName, { destination, operationId: result.operation.operationId });
      }
      return result;
    } finally {
      if (requests.current.get(serviceName) === request) {
        requests.current.delete(serviceName);
        setPendingRequests(new Set(requests.current.keys()));
        setApprovals(current => { const next = new Map(current); next.delete(serviceName); return next; });
      }
    }
  }, [attach, props.binding, props.source.serverId]);
  const clear = React.useCallback((serviceName: string) => setEntries(current => {
    const entry = entriesRef.current.get(serviceName);
    if (!entry) return current;
    cleared.current.add(entry.attachment.operationId);
    const next = new Map(current);
    next.delete(serviceName);
    return next;
  }), []);
  const acknowledgeBinding = React.useCallback((serviceName: string, operationId: string) => setEntries(current => {
    const retained = current.get(serviceName);
    const entry = retained?.attachment.operationId === operationId ? retained : entriesRef.current.get(serviceName);
    if (!entry || entry.attachment.operationId !== operationId || entry.bindingObserved) return current;
    return new Map(current).set(serviceName, { ...entry, bindingObserved: true });
  }), []);
  const publish = React.useCallback((serviceName: string, operationId: string, observation: OperationObservation) => setEntries(current => {
    const retained = current.get(serviceName);
    const entry = retained?.attachment.operationId === operationId ? retained : entriesRef.current.get(serviceName);
    if (!entry || entry.attachment.operationId !== operationId || entry.observation === observation) return current;
    return new Map(current).set(serviceName, { ...entry, observation });
  }), []);
  const source = React.useMemo(() => props.source, [props.source.serverId, props.source.refId, props.source.machineId]);
  const context = React.useMemo(() => ({ source, entries, attach, clear, acknowledgeBinding, executeMove, pendingRequests, approvedStarts, startRequests, observedPlacements: observedPlacements.current, observePlacement, executeStart, resolveStart, managedSelections, managedContinuations, selectManaged, observeManaged,
    runtimeActionExecute: props.runtimeActionExecute }),
    [source, attach, clear, acknowledgeBinding, executeMove, pendingRequests, approvedStarts, startRequests, observePlacement, executeStart, entries, resolveStart, managedSelections, managedContinuations, selectManaged, observeManaged, props.runtimeActionExecute]);
  return <StartContext.Provider value={executeStart}><Context.Provider value={context}>
    {props.binding ? approvalIds.map(artifactId => <ServiceStartApprovalObserver key={artifactId} artifactId={artifactId}
      source={source} binding={props.binding!} publish={publishApproval} />) : null}
    {[...approvals].map(([serviceName, registration]) => <ServiceMoveApprovalObserver key={serviceName}
      source={props.source} serviceName={serviceName} registration={registration} />)}
    {[...managedSelections].map(([name, selection]) => <ServiceManagedMachineObserver key={name} source={props.source}
      binding={props.binding} runtimeActionExecute={props.runtimeActionExecute} name={name} selection={selection} publish={publishManaged} />)}
    {props.binding ? [...entries].map(([serviceName, entry]) => <ServiceOperationObserver
      key={`${serviceName}:${entry.attachment.operationId}`} source={props.source} binding={props.binding!}
      serviceName={serviceName} attachment={entry.attachment} publish={publish} />) : null}
    {props.children}
  </Context.Provider></StartContext.Provider>;
}

/** The retained Services host owns attachment lifetime; phone Back only replaces its presentation. */
export function ProjectServicePlacementObservationProvider(props: Readonly<{
  source: ProjectServiceSource;
  runtimeActionExecute?: FrontDoorRuntimeActionExecutor;
  children: React.ReactNode;
}>) {
  const { binding } = useServerCredentialAccountScopeBinding(props.source.serverId);
  const scopeKey = JSON.stringify([props.source.serverId, props.source.refId, props.source.machineId,
    binding?.accountId, binding?.revision]);
  return <ScopedObservationProvider key={scopeKey} source={props.source} binding={binding} runtimeActionExecute={props.runtimeActionExecute}>{props.children}</ScopedObservationProvider>;
}

export function useProjectServicePlacementObservation(serviceName: string, managedScopeKey?: string,
  native?: Readonly<{ declarationWorkspaceRefId?: string; absent: boolean; bindingPending?: boolean; machineId?: string; managedServiceId?: string }>) {
  const context = React.useContext(Context);
  const attach = React.useCallback((attachment: ProjectServicePlacementOperationAttachment) => context?.attach(serviceName, attachment),
    [context?.attach, serviceName]);
  const clear = React.useCallback(() => context?.clear(serviceName), [context?.clear, serviceName]);
  const executeMove = React.useCallback((destination: ProjectExecutionChoiceV1,
    execute: Parameters<ObservationContext['executeMove']>[2]) => context?.executeMove(serviceName, destination, execute) ?? Promise.resolve(null),
  [context?.executeMove, serviceName]);
  const candidate = context?.entries.get(serviceName);
  const domain = candidate?.observation?.operation?.snapshot.domainRef;
  const declarationWorkspaceRefId = native?.declarationWorkspaceRefId;
  const entry = declarationWorkspaceRefId === undefined || declarationWorkspaceRefId === context?.source.refId
    || (domain?.kind === 'projectService' && domain.declaration?.workspaceRefId === declarationWorkspaceRefId) ? candidate : undefined;
  const localStart = context?.startRequests.get(serviceName);
  const destination = entry?.attachment.destination;
  const approvedStart = context?.approvedStarts.get(serviceName);
  // The received record is already Account-qualified. Use it while the shared
  // observer mounts so an externally initiated Start never flashes Move copy.
  const operation = entry?.observation?.operation ?? (entry ? actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
    serverId: context!.source.serverId, operationId: entry.attachment.operationId,
  }) : null);
  const snapshot = operation?.snapshot;
  const resultTarget = LocalServiceManagedServiceActionTargetV1Schema.safeParse(
    snapshot?.domainRef?.kind === 'projectService' && snapshot.domainRef.currentTarget ? snapshot.domainRef.currentTarget
      : snapshot?.result && typeof snapshot.result === 'object' && 'currentTarget' in snapshot.result ? snapshot.result.currentTarget : undefined);
  const confirmedBinding = snapshot?.state === 'succeeded' && resultTarget.success
    && native?.managedServiceId === resultTarget.data.managedServiceId && native.machineId === resultTarget.data.machineId;
  React.useLayoutEffect(() => {
    if (confirmedBinding && snapshot) context?.acknowledgeBinding(serviceName, snapshot.operationId);
  }, [confirmedBinding, context?.acknowledgeBinding, serviceName, snapshot?.operationId]);
  // Native settlement and its binding read are distinct observations. Keep this
  // exact receipt attached until the binding arrives; success alone proves no URL
  // or health. The cached declaration is still absent while settlement's fresh
  // census is in flight; it cannot release this receipt and offer another Start.
  // A real native terminal instance or failed census still ends Loading.
  const awaitingBinding = snapshot?.state === 'succeeded' && resultTarget.success
    && !entry?.bindingObserved && (native?.bindingPending === true
      || native?.absent === true && !native.managedServiceId);
  const starting = snapshot?.actionId === 'localServices.launcher.start';
  const phase = snapshot?.progress?.kind === 'phase' ? snapshot.progress.phase : null;
  const unknown = operation?.observation !== 'available' || snapshot?.observation?.kind === 'outcome_uncertain'
    || snapshot?.error?.errorCode === 'outcome_uncertain' || snapshot?.state === 'failed' || snapshot?.state === 'cancelled';
  const stoppedBeforeStart = !starting && native?.absent === true && operation?.observation === 'available'
    && (snapshot?.state === 'failed' || snapshot?.state === 'cancelled')
    && (phase === 'stopped' || phase === 'copying' || phase === 'preparing'
      || phase === 'starting' && (snapshot.error?.errorCode === 'project_setup_consent_required'
        || snapshot.error?.errorCode === 'project_setup_effect_changed')) && snapshot?.observation?.kind !== 'outcome_uncertain'
    && snapshot?.error?.errorCode !== 'outcome_uncertain';
  const failedBeforeStop = operation?.observation === 'available'
    && (snapshot?.state === 'failed' || snapshot?.state === 'cancelled') && (starting || phase === null);
  // Attachments retain inspection/recovery history. Only unresolved operations
  // overrides native row facts; a succeeded operation's last phase is historical.
  const active = entry !== undefined && snapshot?.state !== 'succeeded' && !stoppedBeforeStart && !failedBeforeStop;
  const relocating = active && !starting;
  // The Artifact may still say executing while its native operation has already
  // settled. It must never revive pre-admission feedback for that same request.
  const approvalPending = approvedStart !== undefined && snapshot?.requestId !== approvedStart.requestId;
  const startPending = !active && !awaitingBinding && (native?.absent || native?.bindingPending || !native?.managedServiceId)
    && (context?.startRequests.has(serviceName) === true || approvalPending);
  const shownDestination = startPending ? localStart : destination;
  const destinationMachineId = shownDestination?.kind === 'primary' ? context?.source.machineId
    : shownDestination?.destination.kind === 'machine' ? shownDestination.destination.machineId
    : startPending ? approvedStart?.machineId ?? null : null;
  const destinationMachine = useServerScopedMachine(context?.source.serverId ?? '', destinationMachineId ?? '');
  const destinationName = (destinationMachine ? getMachineDisplayName(destinationMachine) : null) ?? t('projectServices.otherMachine');
  const progressText = awaitingBinding ? `${t('common.loading')} · ${t('localServices.row.onMachine', { machine: destinationName })}`
    : startPending ? destinationMachineId
      ? t('localServices.row.startingOn', { machine: destinationName })
      : t('localServices.rowStatus.starting')
    : !active ? null : unknown ? t(starting ? 'localServices.actions.failure.outcomeUnknown' : 'projectServices.moveUnknown')
    : phase === 'stopping' ? t('localServices.rowStatus.stopping')
    : phase === 'stopped' ? t('localServices.rowStatus.stopped')
    : phase === 'copying' ? t('projectWorkers.copying', { machine: destinationName })
    : phase === 'preparing' ? t('projectWorkers.preparing', { machine: destinationName })
    : phase === 'starting' ? t('localServices.row.startingOn', { machine: destinationName })
    : starting ? t('projectWorkers.preparing', { machine: destinationName }) : t('projectServices.moving', { service: serviceName, to: destinationName });
  React.useLayoutEffect(() => managedScopeKey ? context?.observeManaged(serviceName, managedScopeKey) : undefined,
    [context?.observeManaged, managedScopeKey, serviceName]);
  const managed = context?.managedSelections.get(serviceName)?.scopeKey === managedScopeKey ? context?.managedContinuations.get(serviceName) : undefined;
  const selectManaged = React.useCallback((draft: ManagedMachineSelectionDraft | null, purpose: 'start' | 'move' = 'start') => {
    if (managedScopeKey) context?.selectManaged(serviceName, managedScopeKey, draft, purpose);
  }, [context?.selectManaged, managedScopeKey, serviceName]);
  return { hasOwner: context !== null, attachment: starting || snapshot?.state === 'succeeded' ? null : entry?.attachment ?? null,
    operation: operation ?? null, active: active || startPending, awaitingBinding, relocating, progressText, stoppedBeforeStart, failedBeforeStop, stop: entry?.observation?.stop ?? null, attach, clear,
    executeMove, requestPending: context?.pendingRequests.has(serviceName) ?? false,
    managed, selectManaged, runtimeActionExecute: context?.runtimeActionExecute };
}

/** The ordinary Service Start button consumes an ephemeral selection before its existing native request. */
export function useProjectServiceStartDestination() {
  return React.useContext(StartContext);
}

/** Retain presentation through row regrouping; callers still require their fresh read for mutations. */
export function useProjectServicePlacementValueObservation(name: string, placement: ReadyPlacement | null) {
  const context = React.useContext(Context);
  const observe = context?.observePlacement;
  React.useLayoutEffect(() => {
    observe?.(name, placement);
  }, [name, placement, observe]);
  return placement ?? context?.observedPlacements.get(name) ?? null;
}
