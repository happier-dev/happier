import * as React from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiActionControlController, PluginUiActionReference } from '@happier-dev/plugin-sdk/ui';
import {
  projectPluginActionControlExecutionV1,
  useExecutePluginAction,
  usePluginTranslation,
  type PluginActionExecution,
} from '@happier-dev/plugin-ui';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  projectGithubMutationOutcomeV1,
  type GithubMutationOutcomeV1,
  type GithubMutationResultV1,
} from './mutations.js';

export type GithubObservedEntryHandlerV1 = (
  execution: PluginActionExecution<unknown>,
  outcome: GithubMutationOutcomeV1 | null,
  actionLocalId: string,
) => void;

export type GithubWriteControllerV1<T extends GithubMutationResultV1 = GithubMutationResultV1> = Readonly<{
  action: PluginUiActionReference;
  outcome: GithubMutationOutcomeV1 | null;
  pending: boolean;
  controllerFor: (payload: JsonValue | null, onApplied?: (result: T) => void) => PluginUiActionControlController;
  /** Automation and binding consumers awaiting host-owned interaction support. */
  run: (payload: JsonValue, signal?: AbortSignal) => Promise<T | null>;
}>;

/** Native writes share preparation and settlement across host controls and automation. */
export function useGithubWrite<T extends GithubMutationResultV1>(
  localId: string,
  parseResult: (value: unknown) => T | null,
  onObserved: GithubObservedEntryHandlerV1,
): GithubWriteControllerV1<T> {
  const text = usePluginTranslation();
  const action = React.useMemo(() => ({ pluginId: GITHUB_PLUGIN_ID, localId }), [localId]);
  const { execute } = useExecutePluginAction(action);
  const [outcome, setOutcome] = React.useState<GithubMutationOutcomeV1 | null>(null);
  const [pending, setPending] = React.useState(false);
  const inFlight = React.useRef(false);
  const prepare = React.useCallback((payload: JsonValue | null, signal?: AbortSignal) => {
    if (payload === null || inFlight.current || signal?.aborted) return null;
    inFlight.current = true;
    setPending(true);
    setOutcome(null);
    return { input: payload };
  }, []);
  const settle = React.useCallback((settled: PluginActionExecution<unknown>): T | null => {
    const parsed = settled.status === 'success' ? parseResult(settled.result) : null;
    const outcome = projectGithubMutationOutcomeV1(settled, parsed);
    inFlight.current = false;
    setPending(false);
    setOutcome(outcome);
    onObserved(settled, outcome, localId);
    return parsed;
  }, [localId, onObserved, parseResult]);
  const controllerFor = React.useCallback((payload: JsonValue | null, onApplied?: (result: T) => void): PluginUiActionControlController => ({
    prepare: options => prepare(payload, options.signal),
    onSettled: execution => {
      const parsed = settle(projectPluginActionControlExecutionV1(execution, text));
      if (parsed?.kind === 'applied') onApplied?.(parsed);
    },
  }), [prepare, settle, text]);
  const run = React.useCallback(async (payload: JsonValue, signal?: AbortSignal): Promise<T | null> => {
    if (prepare(payload, signal) === null) return null;
    return settle(await execute(payload, signal === undefined ? undefined : { signal }));
  }, [execute, prepare, settle]);
  return React.useMemo(() => ({ action, outcome, pending, controllerFor, run }),
    [action, outcome, pending, controllerFor, run]);
}
