import {
  adaptClaudeProviderOperationsForTest,
  createClaudeTestSessionRuntime,
  type ClaudeTestSessionRuntime,
  type ClaudeRuntimeTurnOperations,
} from '../../sessionRuntime.testkit.js';
import {
  createClaudeUnifiedTerminalTurnOperations as createClaudeUnifiedTerminalProviderOperations,
  type ClaudeUnifiedTerminalNativeRuntime,
  type ClaudeUnifiedTerminalTurnOperationsParams,
} from './turnOperations.js';

type ClaudeUnifiedTerminalTestOperations =
  ClaudeUnifiedTerminalNativeRuntime & ClaudeRuntimeTurnOperations;

export function createClaudeUnifiedTerminalTurnOperations(
  params: ClaudeUnifiedTerminalTurnOperationsParams & Readonly<{ nativeOperationsOnly: true }>,
): ClaudeUnifiedTerminalTestOperations;
export function createClaudeUnifiedTerminalTurnOperations(
  params: ClaudeUnifiedTerminalTurnOperationsParams,
): ClaudeTestSessionRuntime<ClaudeUnifiedTerminalTestOperations>;
export function createClaudeUnifiedTerminalTurnOperations(
  params: ClaudeUnifiedTerminalTurnOperationsParams & Readonly<{ nativeOperationsOnly?: boolean }>,
): ClaudeTestSessionRuntime<ClaudeUnifiedTerminalTestOperations> | ClaudeUnifiedTerminalTestOperations {
  const operations = createClaudeUnifiedTerminalProviderOperations(params);
  const testOperations = adaptClaudeProviderOperationsForTest(operations);
  return params.nativeOperationsOnly === true
    ? testOperations
    : createClaudeTestSessionRuntime(testOperations);
}
