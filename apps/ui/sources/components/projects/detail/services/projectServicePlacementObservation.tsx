import * as React from 'react';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ProjectServiceSource } from './ProjectServicePlacementControls';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

export type ProjectServicePlacementOperationAttachment = Readonly<{
  operationId: string;
  destination: ProjectExecutionChoiceV1;
}>;

type OperationObservation = Readonly<{
  operation: ReturnType<typeof useActionOperation>;
  stop: Pick<ReturnType<typeof useActionOperationStopControl>, 'pending' | 'stopRequested' | 'requestStop'>;
}>;
type Entry = Readonly<{ attachment: ProjectServicePlacementOperationAttachment; observation?: OperationObservation }>;
type ObservationContext = Readonly<{
  entries: ReadonlyMap<string, Entry>;
  attach: (serviceName: string, attachment: ProjectServicePlacementOperationAttachment) => void;
  clear: (serviceName: string) => void;
}>;
const Context = React.createContext<ObservationContext | null>(null);

/** One canonical operation/Cancel observer for each accepted service, shared by both row bodies. */
function ServiceOperationObserver(props: Readonly<{
  source: ProjectServiceSource;
  accountId: string;
  serviceName: string;
  attachment: ProjectServicePlacementOperationAttachment;
  publish: (serviceName: string, operationId: string, observation: OperationObservation) => void;
}>) {
  const record = useActionOperation({ serverId: props.source.serverId, operationId: props.attachment.operationId });
  const operation = record?.snapshot.scope.accountId === props.accountId
    && record.snapshot.actionId === 'projects.service.relocate' ? record : null;
  const active = operation?.snapshot.state === 'accepted' || operation?.snapshot.state === 'running';
  const stop = useActionOperationStopControl(active ? operation : null);
  const observation = React.useMemo(() => ({ operation,
    stop: { pending: stop.pending, stopRequested: stop.stopRequested, requestStop: stop.requestStop } }),
  [operation, stop.pending, stop.stopRequested, stop.requestStop]);
  React.useEffect(() => {
    props.publish(props.serviceName, props.attachment.operationId, observation);
  }, [observation, props.attachment.operationId, props.publish, props.serviceName]);
  return null;
}

function ScopedObservationProvider(props: Readonly<{
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding | null;
  children: React.ReactNode;
}>) {
  const [entries, setEntries] = React.useState<ReadonlyMap<string, Entry>>(() => new Map());
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
  const clear = React.useCallback((serviceName: string) => setEntries(current => {
    if (!current.has(serviceName)) return current;
    const next = new Map(current);
    next.delete(serviceName);
    return next;
  }), []);
  const publish = React.useCallback((serviceName: string, operationId: string, observation: OperationObservation) => setEntries(current => {
    const entry = current.get(serviceName);
    if (!entry || entry.attachment.operationId !== operationId || entry.observation === observation) return current;
    return new Map(current).set(serviceName, { ...entry, observation });
  }), []);
  const context = React.useMemo(() => ({ entries, attach, clear }), [attach, clear, entries]);
  return <Context.Provider value={context}>
    {props.binding ? [...entries].map(([serviceName, entry]) => <ServiceOperationObserver
      key={`${serviceName}:${entry.attachment.operationId}`} source={props.source} accountId={props.binding!.accountId}
      serviceName={serviceName} attachment={entry.attachment} publish={publish} />) : null}
    {props.children}
  </Context.Provider>;
}

/** The retained Services host owns attachment lifetime; phone Back only replaces its presentation. */
export function ProjectServicePlacementObservationProvider(props: Readonly<{
  source: ProjectServiceSource;
  children: React.ReactNode;
}>) {
  const { binding } = useServerCredentialAccountScopeBinding(props.source.serverId);
  const scopeKey = JSON.stringify([props.source.serverId, props.source.refId, props.source.machineId,
    binding?.accountId, binding?.revision]);
  return <ScopedObservationProvider key={scopeKey} source={props.source} binding={binding}>{props.children}</ScopedObservationProvider>;
}

export function useProjectServicePlacementObservation(serviceName: string) {
  const context = React.useContext(Context);
  const attach = React.useCallback((attachment: ProjectServicePlacementOperationAttachment) => context?.attach(serviceName, attachment),
    [context?.attach, serviceName]);
  const clear = React.useCallback(() => context?.clear(serviceName), [context?.clear, serviceName]);
  const entry = context?.entries.get(serviceName);
  return { hasOwner: context !== null, attachment: entry?.attachment ?? null,
    operation: entry?.observation?.operation ?? null, stop: entry?.observation?.stop ?? null, attach, clear };
}
