import type { DefinePluginInput } from '@happier-dev/plugin-sdk';
import type { PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { projectPrepareAction, projectLinkAction } from './prepare.js';
import { projectCreateAction } from './create.js';
import { lifecycleActions } from './actions.js';
import { targetOptionsAction } from './options.js';
import { buildLogsAction } from './logs.js';
import { runtimeLogsAction } from './runtimeLogs.js';
import { variableActions } from './variables.js';
import { domainActions } from './domains.js';

/** One declaration map consumed by daemon manifest and portable Account activation. */
export const accountActions: NonNullable<DefinePluginInput<Readonly<Record<
  string,
  Extract<PluginActionDeclaration, { execution: { target: 'account' } }>
>>>['actions']> = {
  'targets-inspect-v1': projectPrepareAction,
  'project-link': projectLinkAction,
  'project-create': projectCreateAction,
  'target-options-read': targetOptionsAction,
  'build-logs-read': buildLogsAction,
  'runtime-logs-read': runtimeLogsAction,
  ...lifecycleActions,
  ...variableActions,
  ...domainActions,
};

export const pluginIdentity = { id: 'happier.deploy.vercel', version: '0.0.0', displayName: 'Vercel deployments' } as const;
