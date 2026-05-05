import type { AcpRuntimeDefinitionV1 } from './_types';

function hasCallback(
  callbacks: AcpRuntimeDefinitionV1['callbacks'],
  key: keyof AcpRuntimeDefinitionV1['callbacks'],
): boolean {
  return typeof callbacks[key] === 'function';
}

export function assertAcpRuntimeDefinitionSupported(definition: AcpRuntimeDefinitionV1): void {
  if ('customHandler' in definition.transport && definition.transport.customHandler) {
    throw new Error(`ACP backend '${definition.backendId}' declares transport.customHandler, but A.15.2 runtimeCore does not support custom transport handlers yet.`);
  }
  if (definition.auth?.buildAuthEnv) {
    throw new Error(`ACP backend '${definition.backendId}' declares auth.buildAuthEnv, but A.15.2 runtimeCore cannot execute auth env callbacks yet.`);
  }
  if (definition.transportLifecycle?.handshake) {
    throw new Error(`ACP backend '${definition.backendId}' declares transportLifecycle.handshake, but A.15.2 runtimeCore cannot execute handshake callbacks yet.`);
  }
  if (definition.bootstrap?.preStart || definition.bootstrap?.postReady) {
    throw new Error(`ACP backend '${definition.backendId}' declares bootstrap hooks, but A.15.2 runtimeCore cannot execute bootstrap hooks yet.`);
  }
  if (definition.messageMeta?.enrichIncoming) {
    throw new Error(`ACP backend '${definition.backendId}' declares messageMeta.enrichIncoming, but A.15.2 runtimeCore cannot transform incoming ACP messages yet.`);
  }
  if (
    hasCallback(definition.callbacks, 'argvBuilder')
    || hasCallback(definition.callbacks, 'envBuilder')
    || hasCallback(definition.callbacks, 'preflight')
    || hasCallback(definition.callbacks, 'permissionDecision')
  ) {
    throw new Error(`ACP backend '${definition.backendId}' declares Tier-2 callbacks, but A.15.2 runtimeCore only supports declarative Tier-1 ACP definitions.`);
  }
}
