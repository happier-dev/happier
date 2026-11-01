import { AsyncLocalStorage } from 'node:async_hooks';
import { observeCurrentConnectedServiceMaterializationPhase as observeMaterializationPhase } from './materialize/materializationPhase';
import { QualifiedConnectedAccountMaterialError } from './qualifiedConnectedAccountMaterialError';
import { assertNotAborted, type ConnectedAccountEstablishedReadScope } from '@happier-dev/cli-common/connectedAccounts';
export { assertNotAborted } from '@happier-dev/cli-common/connectedAccounts';

export type EstablishedAccountReadScope = ConnectedAccountEstablishedReadScope;

export function createEstablishedAccountReadScope(params: Readonly<{
  isAccountRuntimeCurrent?: (signal?: AbortSignal) => Promise<boolean>;
  runAccountOperation?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}>): EstablishedAccountReadScope {
  // Existing materialization admission is invocation custody, never a process-wide or timed cache.
  const materialization = new AsyncLocalStorage<{ open: boolean; signal?: AbortSignal }>();
  async function verifyAccountRuntimeCurrent(signal?: AbortSignal): Promise<boolean> {
    assertNotAborted(signal);
    return !params.isAccountRuntimeCurrent || await observeMaterializationPhase(
      'established_account_currentness', () => params.isAccountRuntimeCurrent!(signal),
    );
  }
  async function isAccountRuntimeCurrent(signal?: AbortSignal): Promise<boolean> {
    assertNotAborted(signal);
    const cycle = materialization.getStore();
    return cycle ? cycle.open && !cycle.signal?.aborted : verifyAccountRuntimeCurrent(signal);
  }
  async function assertAccountRuntimeCurrent(signal?: AbortSignal): Promise<void> {
    if (!await isAccountRuntimeCurrent(signal)) {
      throw new QualifiedConnectedAccountMaterialError('connected_account_runtime_not_current', 'connected_account_runtime_not_current');
    }
  }
  async function runMaterialization<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertNotAborted(signal);
    if (!await verifyAccountRuntimeCurrent(signal)) throw new QualifiedConnectedAccountMaterialError('connected_account_runtime_not_current', 'connected_account_runtime_not_current');
    const cycle = { open: true, signal };
    try {
      const result = await materialization.run(cycle, () => runCurrentAccountRead(read, signal));
      // The admitted operation owns its receipt. Retained callbacks cannot
      // borrow this completed cycle, and cancellation still prevents disclosure.
      cycle.open = false;
      assertNotAborted(signal);
      return result;
    } finally {
      cycle.open = false;
    }
  }
  async function runCurrentAccountRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertNotAborted(signal);
    const result = await (params.runAccountOperation ? params.runAccountOperation(read, signal) : read());
    assertNotAborted(signal);
    return result;
  }
  function runIndependentAccountRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // A reentrant public operation is a new admission, even when a plugin
    // invokes it from inside an admitted materialization callback.
    return materialization.exit(() => runMaterialization(read, signal));
  }
  return { isAccountRuntimeCurrent, assertAccountRuntimeCurrent, runMaterialization, runCurrentAccountRead, runIndependentAccountRead };
}
