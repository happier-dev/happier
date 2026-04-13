import { isConfiguredAcpBackendTarget, type BackendTargetRefV1 } from '@happier-dev/protocol';

export function isConfiguredAcpProbeTarget<T extends Readonly<{
  agentId: string;
  backendTarget?: BackendTargetRefV1;
}>>(params: T): params is T & Readonly<{
  backendTarget: Extract<BackendTargetRefV1, { kind: 'configuredAcpBackend' }>;
}> {
  return params.backendTarget !== undefined && params.backendTarget !== null && isConfiguredAcpBackendTarget(params.backendTarget);
}
