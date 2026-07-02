import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthTargetInput,
  ConnectedServiceRuntimeFailureInput,
} from './types';

type AdapterInput = Readonly<{
  target: Readonly<{ agentId: string }>;
}>;

function unsupported(operation: string): never {
  throw new Error(`connected_service_runtime_auth_adapter_unsupported:${operation}`);
}

export function createConnectedServiceRuntimeAuthDispatcher(deps: Readonly<{
  resolveAdapter(input: AdapterInput): ConnectedServiceProviderRuntimeAuthAdapter | null;
}>) {
  const adapterFor = (input: AdapterInput, operation: string): ConnectedServiceProviderRuntimeAuthAdapter => {
    const adapter = deps.resolveAdapter(input);
    if (!adapter) unsupported(operation);
    return adapter;
  };

  return {
    classifyRuntimeAuthFailure(input: ConnectedServiceRuntimeFailureInput) {
      return deps.resolveAdapter(input)?.classifyRuntimeAuthFailure(input) ?? null;
    },
    materializeActiveProfile(input: ConnectedServiceRuntimeAuthTargetInput) {
      return adapterFor(input, 'materialize').materializeActiveProfile(input);
    },
    canHotApply(input: ConnectedServiceRuntimeAuthTargetInput) {
      return adapterFor(input, 'canHotApply').canHotApply(input);
    },
    hotApply(input: ConnectedServiceRuntimeAuthTargetInput) {
      return adapterFor(input, 'hotApply').hotApply(input);
    },
    recoverAfterRuntimeAuthSwitch(input: ConnectedServiceRuntimeAuthTargetInput) {
      return adapterFor(input, 'recoverAfterRuntimeAuthSwitch').recoverAfterRuntimeAuthSwitch(input);
    },
    verifyActiveAccount(input: ConnectedServiceRuntimeAuthTargetInput) {
      const adapter = adapterFor(input, 'verifyActiveAccount');
      if (!adapter.verifyActiveAccount) unsupported('verifyActiveAccount');
      return adapter.verifyActiveAccount(input);
    },
    probeQuota(input: ConnectedServiceRuntimeAuthTargetInput) {
      return adapterFor(input, 'probeQuota').probeQuota(input);
    },
    refreshActiveProfile(input: ConnectedServiceRuntimeAuthTargetInput) {
      return adapterFor(input, 'refreshActiveProfile').refreshActiveProfile(input);
    },
  };
}
