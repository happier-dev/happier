import type { ReactNode } from 'react';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import type { ForgeCiMutationResultV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeReleaseMutationResultV1 } from '@happier-dev/triage-protocol/releases/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { readForgeOperationStateV1, type ForgeOperationStateV1 } from './operationState.js';

export type ForgeOperationStateProps = Readonly<{
  failure?: TriageSourceFailureV1 | null; mutation?: ForgeCiMutationResultV1 | ForgeReleaseMutationResultV1 | null;
  account?: ConnectedAccountRef | null; hasRetainedValue: boolean;
  download?: FileDownloadResultV1 | null; targetUrl?: string | null;
  children(state: ForgeOperationStateV1): ReactNode;
}>;

/** The UI lane binds this model to public ErrorState/freshness and exact-account repair. */
export function ForgeOperationState(props: ForgeOperationStateProps): ReactNode {
  return props.children(readForgeOperationStateV1(props));
}
