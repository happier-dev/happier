import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequesterAccountProjectionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { StoredCredentials } from '@/persistence';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { ResolveExternalActionEncryption } from '../externalActions/executeExternalAction';

/** Finite Account custody at an admitted ingress, never a Session or a credential store. */
export type RequesterAccountActionContext = Readonly<{
  invocation?: ExternalActionRequesterInvocationV1;
  deploymentChild?: import('@happier-dev/protocol').DeploymentChildRpcV1;
  credentials: StoredCredentials;
  accountSettingsContext: AccountSettingsContext;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  authorization: ExternalActionExecutionAuthorizationV1;
  serverHttpBaseUrl: string;
  resolveEncryption: ResolveExternalActionEncryption;
  isCurrent(): Promise<boolean>;
  /** Local installed custody, separate from fresh Home effect authorization. */
  isCustodyCurrent?: () => Promise<boolean>;
  refreshAccountSettings(signal?: AbortSignal): Promise<boolean>;
  retain(): () => Promise<void>;
  dispose(): Promise<void>;
}>;

export const requesterActionContext = Symbol('admittedRequesterAccountActionContext');

/** Host-local custody facet; strict parsing/JSON forwarding cannot carry credentials or settings. */
export function readRequesterAccountActionContext(authorization?: ExternalActionExecutionAuthorizationV1): RequesterAccountActionContext | null {
  const projection: (ExternalActionRequesterAccountProjectionV1 & { [requesterActionContext]?: RequesterAccountActionContext }) | undefined
    = authorization?.requesterAccountProjection;
  return projection?.[requesterActionContext] ?? null;
}
