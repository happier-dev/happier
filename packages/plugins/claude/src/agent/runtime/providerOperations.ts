import type {
  AgentSessionProviderBinding,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';

import type { ClaudeProviderEvent } from './providerEvents.js';

/**
 * Claude-provider operations below the canonical AgentRuntime owner.
 *
 * These provider-local types are never registered or publicly exposed. Every event is translated
 * by nativeRuntime before crossing the plugin boundary.
 */
export type ClaudeProviderPermissionResponseOutcome =
  | Readonly<{ delivered: true }>
  | Readonly<{
      delivered: false;
      reason: 'no_active_session' | 'unknown_request';
    }>;

export type ClaudeProviderConfigurationUpdate = Readonly<{
  modeId?: string;
  modelId?: string;
  permissionMode?: string;
  configOption?: Readonly<Record<string, unknown>>;
  providerBinding?: AgentSessionProviderBinding;
}> & Readonly<Record<string, unknown>>;

export type ClaudeProviderConfigurationOutcomeStatus =
  RuntimeConfigUpdateOutcomeV1['status'];
export type ClaudeProviderConfigurationOutcomeTiming =
  NonNullable<RuntimeConfigUpdateOutcomeV1['timing']>;

export type ClaudeProviderConfigurationOutcome = Readonly<{
  status: ClaudeProviderConfigurationOutcomeStatus;
  timing?: ClaudeProviderConfigurationOutcomeTiming;
  reason?: string;
}>;

export function readClaudePendingLocalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export type ClaudeProviderDisposeReason = Exclude<
  Parameters<AgentSessionRuntime['dispose']>[0],
  undefined
>;

type ClaudeProviderPromptDeliveryIdentity = Readonly<{
  localInputId: string;
  userMessageSeq: number | null;
  userMessageSeqs?: readonly number[];
}>;

type ClaudeLegacyProviderPromptDeliveryOutcome = Readonly<{
  localInputId?: string | null;
  localInputIds?: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs?: readonly number[];
  type: 'custody_observed' | 'provider_accepted' | 'rejected_before_write' | 'possible_write';
  reason?: string;
}>;

export type ClaudeProviderPromptDeliveryOutcome =
  | ClaudeLegacyProviderPromptDeliveryOutcome
  | (ClaudeProviderPromptDeliveryIdentity & Readonly<{
      type: 'input-accepted';
      delivery: Readonly<{
        kind: 'newTurn' | 'followUp' | 'steer';
        turnId: string;
      }>;
    }>)
  | (ClaudeProviderPromptDeliveryIdentity & Readonly<{
      type: 'input-rejected';
      diagnostic: Readonly<{
        code: string;
        severity: 'error' | 'warning' | 'info';
        message?: string;
      }>;
      retryable: boolean;
    }>)
  | (ClaudeProviderPromptDeliveryIdentity & Readonly<{
      type: 'input-custody-unknown';
      issue: Readonly<{
        code: string;
        severity: 'error' | 'warning' | 'info';
        message?: string;
      }>;
    }>);

export type ClaudeProviderPromptDeliveryOutcomeCallback = (
  outcome: ClaudeProviderPromptDeliveryOutcome,
) => void;

export type ClaudeRuntimeTurnOperations = Readonly<{
  beginProviderTurn(): void;
  startProviderSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null | Readonly<Record<string, unknown>>>;
  sendProviderTurnPrompt(
    prompt: string,
    meta?: ClaudeRuntimePromptSendMeta,
  ): Promise<ClaudeRuntimePromptSubmissionOutcome>;
  steerProviderTurn(
    message: string,
    meta?: ClaudeRuntimePromptSendMeta,
  ): Promise<ClaudeRuntimePromptSubmissionOutcome>;
  waitForProviderTurnCompletion(opts?: Readonly<{ timeoutMs?: number | null }>): Promise<void>;
  subscribeProviderEvents(handler: (event: ClaudeProviderEvent) => void): () => void;
  respondToProviderPermission(
    requestId: string,
    approved: boolean,
  ): Promise<ClaudeProviderPermissionResponseOutcome>;
  cancelProviderTurn(): Promise<void>;
  readProviderIdentity(): Readonly<{ sessionId: string | null }>;
  updateProviderConfiguration(
    update: ClaudeProviderConfigurationUpdate,
  ): Promise<ClaudeProviderConfigurationOutcome | void>;
  disposeProviderSession(
    reason?: ClaudeProviderDisposeReason | Readonly<{ reason?: ClaudeProviderDisposeReason }>,
  ): Promise<void>;
}>;

export type ClaudeRuntimePromptSubmissionOutcome =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'rejected_before_effect'; reason: string }>
  | Readonly<{ kind: 'effect_may_have_occurred'; reason: string }>
  | Readonly<{ kind: 'custody_observed' }>;

export type ClaudeRuntimePromptSendMeta = Readonly<{
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;
