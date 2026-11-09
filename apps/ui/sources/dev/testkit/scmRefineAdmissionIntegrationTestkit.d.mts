import type { ActionId} from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ScmDiffSummaryRefineInput } from '@happier-dev/protocol/scm';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { Message } from '@happier-dev/session-core/messages';

export function resolveExecutionRunVisibleMessages(params: Readonly<{
  runId: string; messages: readonly Message[]; focusedMessages: readonly Message[];
}>): readonly Message[];

type PendingFixture = Readonly<{ id: string; localId: string; text: string; displayText?: string; rawRecord: unknown }>;
export function createPendingMessageFixture(overrides: PendingFixture): PendingFixture;
export function resolvePendingMessageContentPresentation(message: PendingFixture): Readonly<{ isHostInput: boolean }>;

// A typed cross-app test boundary avoids merging UI/CLI @/* aliases into one
// TypeScript program; the UI project checks the real exported owners.
export function createScmDiffSummaryResultOperations(params: Readonly<{
  machineId: string; serverId: string; accountId: string; shouldContinue: () => boolean;
  actionExecutor: Readonly<{ execute: (actionId: ActionId, input: unknown,
    context?: ActionExecutorContext) => Promise<ActionExecuteResult> }>;
}>): Readonly<{ refine(input: ScmDiffSummaryRefineInput): Promise<unknown> }>;

export function createUiAccountActionTransport(params: Readonly<{
  account: Readonly<{ serverId: string; accountId: string; assertCurrent(): void; assertResultCurrent(): void }>;
  resolveFallbackMachineId: () => string | null;
  transport: (request: Readonly<{
    actionId: ActionId; payload: unknown; requestId: string;
    target: Extract<NonNullable<ActionExecutorContext['externalActionTarget']>, { kind: 'machine' }>;
    invocation: ExternalActionRequesterInvocationV1;
  }>) => Promise<unknown>;
}>): (args: Readonly<{ actionId: ActionId; input: unknown; context: ActionExecutorContext;
  signal?: AbortSignal }>) => Promise<unknown>;
