import { useCallback, useRef, useState } from 'react';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { projectPluginActionControlExecutionV1, usePluginTranslation } from '@happier-dev/plugin-ui';
import { projectForgeCiMutationExecutionV1 } from '../../runtime/adapter.js';
import type {
  ForgeCiActionInputByOperationV1,
  ForgeCiMutationResultV1,
} from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiBindingV1 } from './binding.js';

export type ForgeCiMutationOperationV1 =
  | 'enableWorkflow'
  | 'disableWorkflow'
  | 'rerunAll'
  | 'rerunFailed'
  | 'rerunJob'
  | 'cancelRun'
  | 'forceCancelRun'
  | 'approveForkRun';

export type ForgeCiMutationStateV1 = Readonly<{
  pending: ForgeCiMutationOperationV1 | null;
  last: Readonly<{
    operation: ForgeCiMutationOperationV1;
    result: ForgeCiMutationResultV1;
  }> | null;
}>;

/**
 * One write at a time from a CI view. The host owns approval and confirmation; this owns only what the view shows
 * while the write is out and after its answer: busy state, the exact result (an unknown answer stays unknown and is
 * never retried here), and one readback of the affected run when the forge accepted it.
 */
export function useForgeCiMutationV1(
  ci: ForgeCiBindingV1,
  onSettled?: (result: ForgeCiMutationResultV1, operation: ForgeCiMutationOperationV1) => void,
) {
  const text = usePluginTranslation();
  const [state, setState] = useState<ForgeCiMutationStateV1>({
    pending: null,
    last: null,
  });
  const inFlight = useRef(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const run = useCallback(
    async <K extends ForgeCiMutationOperationV1>(
      operation: K,
      input: ForgeCiActionInputByOperationV1[K],
    ) => {
      const adapter = ci.adapter;
      if (!adapter || inFlight.current) return;
      inFlight.current = true;
      setState((previous) => ({ pending: operation, last: previous.last }));
      try {
        const call = adapter[operation] as (
          value: ForgeCiActionInputByOperationV1[K],
        ) => Promise<ForgeCiMutationResultV1>;
        const result = await call(input);
        await ci.reads?.completeMutation(operation, result);
        setState({ pending: null, last: { operation, result } });
        settled.current?.(result, operation);
      } finally {
        inFlight.current = false;
      }
    },
    [ci.adapter, ci.reads],
  );
  const control = <K extends ForgeCiMutationOperationV1>(
    operation: K,
    input: ForgeCiActionInputByOperationV1[K] | null,
  ) => {
    const action = ci.actionRefs[operation];
    if (action === null) return null;
    const controller: PluginUiActionControlController = {
      prepare: () => {
        if (input === null || inFlight.current) return null;
        inFlight.current = true;
        setState(previous => ({ pending: operation, last: previous.last }));
        return { input: projectNativeJsonValueForTransport(input) };
      },
      onSettled: execution => {
        void (async () => {
          try {
            if (input === null) return;
            const result = projectForgeCiMutationExecutionV1(input, projectPluginActionControlExecutionV1(execution, text));
            if (result === null) { setState(previous => ({ ...previous, pending: null })); return; }
            await ci.reads?.completeMutation(operation, result);
            setState({ pending: null, last: { operation, result } });
            settled.current?.(result, operation);
          } finally { inFlight.current = false; }
        })();
      },
    };
    return { action, controller };
  };
  const dismiss = useCallback(
    () => setState((previous) => ({ pending: previous.pending, last: null })),
    [],
  );
  return { state, run, control, dismiss };
}
