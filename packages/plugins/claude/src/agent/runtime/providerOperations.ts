import type {
  AgentSessionProviderBinding,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { readClaudeProviderIdentityValue } from '../../protocol/providerIdentity.js';
import type { ClaudeProviderEvent } from './providerEvents.js';
import type { ClaudeRuntimeAuthIdentity } from '../auth/services/runtime/requestIdentity.js';
import type { ClaudeMcpStartupFailureCode } from '../mcp/managedPolicy.js';

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
  modelId?: string | null;
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
  failureCause?: SessionRuntimeIssueV1['failureCause'];
  timing?: ClaudeProviderConfigurationOutcomeTiming;
  reason?: string;
}>;

export function readClaudePendingLocalId(value: unknown): string | null {
  return readClaudeProviderIdentityValue(value);
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
  runtimeAuthIdentity?: ClaudeRuntimeAuthIdentity;
  beginProviderTurn(turnId?: string): void;
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
  cancelProviderTurn(expectedTurnId?: string): Promise<void | boolean>;
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
  | Readonly<{
    kind: 'rejected_before_effect';
    reason: string;
    failureCause?: SessionRuntimeIssueV1['failureCause'];
    code?: ClaudeMcpStartupFailureCode | 'browser_media_unavailable' | 'claude_image_input_unsupported' | 'claude_skill_source_unavailable';
    retryable?: boolean;
  }>
  | Readonly<{
    kind: 'effect_may_have_occurred';
    reason: string;
    failureCause?: SessionRuntimeIssueV1['failureCause'];
    code?: ClaudeMcpStartupFailureCode;
  }>
  | Readonly<{ kind: 'custody_observed' }>;

export type ClaudeRuntimePromptSendMeta = Readonly<{
  structuredInput?: unknown;
  outputSchema?: Parameters<AgentSessionRuntime['send']>[0]['input']['outputSchema'];
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;
