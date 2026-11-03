import { getActionSpec } from '../actionSpecs.js';
import type { ActionId } from '../actionIds.js';
import { readActionSecretInputPaths, readActionSecretInputAdmission } from '../actionInputHintsRuntime.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import type { ActionExecutorDeps } from './types.js';

export function isNativeSecretFillAction(actionId: string): boolean {
  return actionId === 'computer.secret.fill' || actionId === 'browser.automation.secret.fill';
}

/** Exact selected declaration only; this never enumerates the contribution catalog. */
function readDeclaredInputs<TResult>(actionId: ActionId, input: unknown,
  list: ActionExecutorDeps['listContributedActionDefinitions'],
  read: (spec: Parameters<typeof readActionSecretInputPaths>[0], input: unknown, prefix: string) => TResult): TResult {
  if (actionId !== 'action.invoke') return read(getActionSpec(actionId), input, '');
  const action = readRecord(readRecord(input).action);
  const id = parseQualifiedPluginActionId(`${action.pluginId}/actions/${action.localId}`);
  if (!id) return read({}, input, '');
  const qualifiedId = formatQualifiedPluginActionId(id);
  const definition = list?.({ id: qualifiedId }).find(item => item.id === qualifiedId);
  return read(definition ?? {}, readRecord(input).input, 'input.');
}

export function readConfidentialActionInputPaths(actionId: ActionId, input: unknown,
  list: ActionExecutorDeps['listContributedActionDefinitions'],
  options?: Readonly<{ includeInactive?: boolean }>): readonly string[] {
  return readDeclaredInputs(actionId, input, list, (spec, value, prefix) =>
    readActionSecretInputPaths(spec, value, options).map(path => `${prefix}${path}`));
}

export function readConfidentialActionInputAdmission(actionId: ActionId, input: unknown,
  list: ActionExecutorDeps['listContributedActionDefinitions']): ReturnType<typeof readActionSecretInputAdmission> {
  return readDeclaredInputs(actionId, input, list, (spec, value, prefix) => {
    const admission = readActionSecretInputAdmission(spec, value);
    return { paths: admission.paths.map(path => `${prefix}${path}`),
      missingPaths: admission.missingPaths.map(path => `${prefix}${path}`) };
  });
}

export function requiresConfidentialActionChoice(actionId: ActionId, input: unknown,
  list: ActionExecutorDeps['listContributedActionDefinitions']): boolean {
  return isNativeSecretFillAction(actionId) || readConfidentialActionInputAdmission(actionId, input, list).missingPaths.length > 0;
}
