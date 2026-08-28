import { z } from 'zod';
import {
  AGENT_CONNECTED_ACCOUNT_RUNTIME_AUTH_FAILURE_KINDS,
  type AgentConnectedAccountProviderOutcomeInputV1,
  type AgentConnectedAccountProviderOutcomeTargetV1,
  type AgentConnectedAccountProviderOutcomeVerificationResultV1,
  type AgentConnectedAccountRuntimeAuthAdapterResultV1,
  type AgentConnectedAccountRuntimeAuthFailureKind,
  type AgentConnectedAccountRuntimeAuthSelectionV1,
  type AgentConnectedAccountRuntimeFailureClassificationV1,
  type AgentConnectedAccountRuntimeFailureInputV1,
  type AgentSessionRuntimeAuthApplyResult,
  type AgentConnectedAccountTransitionVerificationResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ConnectedServiceLimitCategoryV1,
  ProviderAccountUsageQuotaScopeV1,
} from '@happier-dev/protocol';

export const CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_KINDS =
  AGENT_CONNECTED_ACCOUNT_RUNTIME_AUTH_FAILURE_KINDS;
export type ConnectedServiceRuntimeAuthFailureKind =
  AgentConnectedAccountRuntimeAuthFailureKind;
export const ConnectedServiceRuntimeAuthFailureKindSchema = z.enum(
  CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_KINDS,
);

export type ConnectedServiceRuntimeLimitCategory = ConnectedServiceLimitCategoryV1;
export type ConnectedServiceRuntimeQuotaScope = ProviderAccountUsageQuotaScopeV1;
export type ConnectedServiceRuntimeFailureClassification =
  AgentConnectedAccountRuntimeFailureClassificationV1;
export type ConnectedServiceRuntimeAuthTargetInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  selection: AgentConnectedAccountRuntimeAuthSelectionV1;
  credential?: ConnectedServiceCredentialRecordV1;
  applySelectedAuthGeneration?: () => Promise<AgentSessionRuntimeAuthApplyResult>;
  readProviderAccount?: () => Promise<unknown>;
  readProviderUsage?: (params?: unknown) => Promise<unknown>;
  nativeHome?: Readonly<{
    readFiles(fileIds: readonly string[]): Promise<Readonly<Record<string, Uint8Array>>>;
    replaceFiles(files: Readonly<Record<string, Uint8Array>>): Promise<void>;
  }>;
  validateCurrentBeforeMutation?: () => Promise<Readonly<
    | { current: true }
    | { current: false; reason: string }
  >>;
}>;
export type ConnectedServiceRuntimeFailureInput =
  AgentConnectedAccountRuntimeFailureInputV1;
export type ConnectedServiceRuntimeAuthAdapterResult =
  AgentConnectedAccountRuntimeAuthAdapterResultV1;
export type ConnectedServiceProviderOutcomeTarget =
  AgentConnectedAccountProviderOutcomeTargetV1;
export type ConnectedServiceProviderOutcomeInput =
  AgentConnectedAccountProviderOutcomeInputV1;
export type ConnectedServiceProviderOutcomeVerificationResult =
  AgentConnectedAccountProviderOutcomeVerificationResultV1;
export type ConnectedServiceAccountTransitionVerificationResult =
  AgentConnectedAccountTransitionVerificationResultV1;
export type ConnectedServiceProviderRuntimeAuthAdapter = Readonly<{
  classifyRuntimeAuthFailure(input: ConnectedServiceRuntimeFailureInput): ConnectedServiceRuntimeFailureClassification | null;
  materializeActiveProfile(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
  canHotApply(input: ConnectedServiceRuntimeAuthTargetInput): ConnectedServiceRuntimeAuthAdapterResult;
  hotApply(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
  verifyActiveAccount?(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceAccountTransitionVerificationResult>;
  verifyProviderOutcome?(input: ConnectedServiceProviderOutcomeInput): Promise<ConnectedServiceProviderOutcomeVerificationResult>;
  probeQuota(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
  refreshActiveProfile(input: ConnectedServiceRuntimeAuthTargetInput): Promise<ConnectedServiceRuntimeAuthAdapterResult>;
}>;
