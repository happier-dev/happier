export { isHappierActionApprovalRequestCreated } from './approval.js';
export {
  connect,
  type HappierActions,
  type HappierClient,
  type HappierMachineActionExecute,
  type HappierMachineActionExecutionOptions,
  type HappierMachineActions,
  type HappierMachineClient,
  type HappierMachineExecutionRuns,
  type HappierExecutionRuns,
} from './connect.js';
export {
  HappierActionError,
  HappierClientClosedError,
  HappierTransportError,
} from './errors.js';
export type {
  FollowTranscriptOptions,
  HappierExecutionRunStream,
  HappierExecutionRunStreamEvent,
  HappierTranscriptItem,
} from './subscriptions.js';
export type { HappierMachine, MachineListOptions } from './machines.js';
export {
  HappierAgentUnavailableError,
  HappierSessionInitialInputError,
  HappierSessionSpawnError,
  type HappierAgentUnavailableReason,
  type HappierMachineSessions,
  type HappierSession,
  type HappierSessionSendAndWaitInput,
  type HappierSessionSpawnInput,
  type HappierSessionSpawnOptions,
  type HappierSessions,
} from './fluent/sessions.js';
export type {
  PublicActionId,
  PublicActionInputById,
  PublicActionResultById,
} from './actions/generated.js';
export type {
  ActionExecute,
  ActionExecutionOptions,
  ActionTarget,
  ContributedActionId,
  HappierConnectOptions,
  PublicActionExecutionResult,
  RawActionExecute,
} from './types.js';
