import * as React from 'react';
import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { useSurfaceContext } from '@happier-dev/plugin-ui';
import { useLivePluginResourceProjection, type PluginUiResourceProjection,
  type PluginUiResourceProjectionSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { pluginJsonValuesEqual, PluginUiActionOperationHostReadResultV1ProtocolSchema,
  type PluginUiActionOperationHostReadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import type { LocalActRunSeedV1 } from '../../../actions/local/contracts.js';
import { createLocalRunControllerV1, type LocalRunController, type LocalRunOperationRef } from './localRunController.js';
import { bindLocalActFormV1 } from './mountedForm.js';

const NO_WORKFLOWS: readonly string[] = Object.freeze([]);
const operationProjection: PluginUiResourceProjection<PluginUiActionOperationHostReadResultV1> = {
  decode(content, previous) {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(content.bytes));
    const next = PluginUiActionOperationHostReadResultV1ProtocolSchema.parse(decoded);
    return previous && pluginJsonValuesEqual(previous, next) ? previous : next;
  },
};
const selectOperation = (snapshot: PluginUiResourceProjectionSnapshot<PluginUiActionOperationHostReadResultV1>) => snapshot;

/** Headless binding: the incumbent Resource store owns reads, invalidation and retirement. */
function LocalActRunOperationBinding(props: Readonly<{ controller: LocalRunController; operationRef: LocalRunOperationRef }>) {
  const observed = useLivePluginResourceProjection({ hostRead: 'action.operations.get', input: props.operationRef },
    operationProjection, selectOperation).value;
  React.useEffect(() => {
    const unavailable = observed.error !== undefined || observed.freshness !== 'fresh' || observed.subscription === 'ended';
    const observation = observed.subscription === 'reconnecting' ? 'reconnecting'
      : unavailable ? 'unavailable' : observed.value?.observation ?? 'unavailable';
    props.controller.receiveOperation(props.operationRef, {
      operation: observed.value === undefined ? props.controller.getSnapshot().operation : observed.value.operation,
      observation,
    });
  }, [props.controller, props.operationRef, observed]);
  return null;
}

/** Data/lifetime wiring only. The UI lane owns every rendered element. */
export function useLocalActRunFormV1(options: Readonly<{
  accountId: string; mountId: string; seed: LocalActRunSeedV1; signal: AbortSignal;
  host: Pick<PluginUiHostApi, 'executeAction' | 'readMachineDisplayName'>; sharedScope: PluginEphemeralSharedScope;
}>) {
  const surface = useSurfaceContext();
  const [controller, setController] = React.useState<LocalRunController | null>(null);
  const latest = React.useRef(options); latest.current = options;
  const { serverId, workspaceId, machineId, rootPath } = options.seed.workspace;
  const targetId = options.seed.target.kind === 'session' ? options.seed.target.sessionId : options.seed.target.projectId;
  React.useEffect(() => {
    const current = latest.current;
    if (current.signal.aborted) { setController(null); return; }
    const next = createLocalRunControllerV1({ accountId: current.accountId, seed: current.seed, host: current.host });
    const unbind = bindLocalActFormV1(current.sharedScope, current.mountId, current.seed, next);
    let retired = false;
    const retire = () => {
      if (retired) return;
      retired = true;
      unbind(); next.dispose();
      setController(held => held === next ? null : held);
    };
    current.signal.addEventListener('abort', retire, { once: true });
    setController(next);
    void next.inspect();
    return () => { current.signal.removeEventListener('abort', retire); retire(); };
  }, [options.accountId, options.mountId, options.signal, options.host, options.sharedScope, serverId, workspaceId, machineId, rootPath,
    options.seed.workflowPath, options.seed.event, options.seed.yamlJobId, options.seed.sourceHeadSha, options.seed.target.kind, targetId]);
  const subscribe = React.useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller]);
  const getSnapshot = React.useCallback(() => controller?.getSnapshot() ?? null, [controller]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const nameServerId = snapshot?.selection.workspace.serverId;
  const nameMachineId = snapshot?.selection.workspace.machineId;
  React.useEffect(() => {
    if (!controller || !nameServerId || !nameMachineId) return;
    const request = new AbortController();
    const address = { serverId: nameServerId, machineId: nameMachineId };
    void (async () => {
      try {
        const result = await options.host.readMachineDisplayName(address, { signal: request.signal });
        if (!request.signal.aborted) controller.receiveMachineDisplayName(address, result.status === 'ready' ? result.displayName : null);
      } catch {
        // Presentation is unavailable; naming never grants or blocks command execution.
        if (!request.signal.aborted) controller.receiveMachineDisplayName(address, null);
      }
    })();
    return () => request.abort();
  }, [controller, options.host, nameServerId, nameMachineId]);
  // A retained snapshot is not a current process fact while its qualified owner is unavailable.
  const operationStatus = !snapshot?.operationRef ? null : snapshot.operationObservation === 'available'
    ? snapshot.operation?.state ?? 'unavailable' : snapshot.operationObservation;
  return { controller, snapshot, signal: options.signal,
    pendingApproval: snapshot?.runState === 'submitting' ? surface.pendingApproval ?? null : null,
    operationStatus, inspectionError: snapshot?.inspectionError ?? null,
    workflowChoices: snapshot?.inspection?.workflows ?? NO_WORKFLOWS, runnerRequirements: snapshot?.runnerRequirements ?? null };
}

export function LocalActRunForm(props: Parameters<typeof useLocalActRunFormV1>[0] & {
  children(value: ReturnType<typeof useLocalActRunFormV1>): React.ReactNode;
}) {
  const form = useLocalActRunFormV1(props);
  return <>
    {form.controller && form.snapshot?.operationRef
      ? <LocalActRunOperationBinding controller={form.controller} operationRef={form.snapshot.operationRef} /> : null}
    {props.children(form)}
  </>;
}
