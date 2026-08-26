import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServiceResolvedSelection } from './materializeConnectedServicesForSpawn';
import type { ConnectedServiceRefreshFailureCategory } from '../credentials/lifecycleTypes';
import type {
  ConnectedServiceGroupMutationTarget,
} from '../credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '../credentials/lifecycleTypes';

export type ConnectedServicesMaterializationDiagnostic = Readonly<{
  code: string;
  providerId: CatalogAgentId;
  severity?: 'warning' | 'blocking';
  serviceId?: ConnectedServiceId;
  requestedStateMode?: string;
  effectiveStateMode?: string;
  entryName?: string;
  reason?: string;
  credentialRefreshFailure?: Readonly<{
    category: ConnectedServiceRefreshFailureCategory;
    providerStatus?: number;
    providerErrorCode?: string;
  }>;
}>;

export const CONNECTED_SERVICE_MATERIALIZATION_REASONS = Object.freeze({
  authoritativeGroupTargetSuperseded: 'authoritative_group_target_changed_before_materialization',
} as const);

export function isAuthoritativeGroupTargetSupersededMaterializationDiagnostic(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): boolean {
  return diagnostic.severity === 'blocking'
    && diagnostic.reason === CONNECTED_SERVICE_MATERIALIZATION_REASONS.authoritativeGroupTargetSuperseded;
}

export function isBlockingConnectedServicesMaterializationDiagnostic(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): boolean {
  return diagnostic.severity === 'blocking';
}

export function collectBlockingConnectedServicesMaterializationDiagnostics(
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[] | undefined,
): readonly ConnectedServicesMaterializationDiagnostic[] {
  return (diagnostics ?? []).filter(isBlockingConnectedServicesMaterializationDiagnostic);
}

export type ConnectedServicesMaterializeResult = Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot?: string | null;
  afterPromote?: (input: Readonly<{
    env: Record<string, string>;
    targetMaterializedRoot: string | null;
    finalRootDir: string;
  }>) => Promise<void> | void;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>;

export type ConnectedServicesProviderMaterializerInput = Readonly<{
  agentId: CatalogAgentId;
  activeServerDir: string;
  rootDir: string;
  previousMaterializedRoot?: string | null;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  cleanupRoot: () => void;
  validateGroupMutationCurrentness?: (
    input: ConnectedServiceGroupMutationTarget,
  ) => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
}>;

export type ConnectedServicesProviderMaterializer = (
  params: ConnectedServicesProviderMaterializerInput,
) => Promise<ConnectedServicesMaterializeResult | null>;
