import type { ActionContract } from '@happier-dev/plugin-sdk/actions';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

import { useExecutePluginAction } from '../hostApi/executeAction.js';
import type { PluginActionExecution } from '../hostApi/executeAction.js';
import { Action } from './Action.js';

declare const updateReview: ActionContract;
declare const completeReview: ActionContract;
declare const hostApi: PluginUiHostApi;

function typecheck(callback: () => void): void {
  void callback;
}

const reload = (
  <Action.Execute
    action="plugins.reload"
    input={{ pluginId: 'example.author' }}
    onSettled={(settled) => {
      if (settled.status === 'success') {
        const result: Readonly<{ ok?: boolean }> = settled.result;
        void result;
      }
    }}
  />
);

void reload;

// @ts-expect-error Action.Execute preserves the exact canonical host ActionSpec input.
const invalidReload = <Action.Execute action="plugins.reload" input={{ title: 'example.author' }} />;
void invalidReload;

typecheck(() => {
  const update = useExecutePluginAction(updateReview, { title: 'Rename review' });
  const complete = useExecutePluginAction(completeReview, null);
  const updateExecution: Promise<PluginActionExecution<JsonValue>> = update.execute();
  const completeExecution: Promise<PluginActionExecution<JsonValue>> = complete.execute();
  const completeTransportResult: Promise<JsonValue> = hostApi.executeAction(completeReview, null);

  const updateState = update.execution;
  if (updateState.status === 'success') {
    const result: JsonValue = updateState.result;
    void result;
  }
  const completeState = complete.execution;
  if (completeState.status === 'success') {
    const result: JsonValue = completeState.result;
    void result;
  }

  const contributedAction = (
    <Action.Execute
      action={updateReview}
      input={{ title: 'Rename review' }}
      onSettled={(settled) => {
        if (settled.status === 'success') {
          const result: JsonValue = settled.result;
          void result;
        }
      }}
    />
  );
  const voidAction = (
    <Action.Execute
      action={completeReview}
      input={null}
      onSettled={(settled) => {
        if (settled.status === 'success') {
          const result: JsonValue = settled.result;
          void result;
        }
      }}
    />
  );

  void updateExecution;
  void completeExecution;
  void completeTransportResult;
  void contributedAction;
  void voidAction;
});
