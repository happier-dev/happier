export {
  BackendTargetKeySchema,
  BackendTargetKindSchema,
  BackendTargetRefSchema,
  buildBackendTargetKey,
  isBuiltInAgentTarget,
  isConfiguredAcpBackendTarget,
  type BackendTargetKey,
  type BackendTargetKind,
  type BackendTargetRefV1,
} from './targets/backendTargetRef.js';
export { buildBackendTargetKeyV2 } from './targets/backendTargetRefV2.js';
