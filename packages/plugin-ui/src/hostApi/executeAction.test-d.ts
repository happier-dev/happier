import { useExecutePluginAction } from './executeAction.js';
import type { PluginActionExecution } from './executeAction.js';

const reload = useExecutePluginAction('plugins.reload', { pluginId: 'example.author' });

if (reload.execution.status === 'success') {
  const result: Readonly<{ ok?: boolean }> = reload.execution.result;
  void result;
}

const reloadExecution: Promise<PluginActionExecution<Readonly<{ ok?: boolean }>>> = reload.execute();
void reloadExecution;

// @ts-expect-error The canonical host ActionSpec requires its exact input shape.
useExecutePluginAction('plugins.reload', { title: 'example.author' });
