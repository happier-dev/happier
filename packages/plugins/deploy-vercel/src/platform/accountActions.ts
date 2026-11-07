import type { DefinePluginInput } from '@happier-dev/plugin-sdk';
import type { PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { projectPrepareAction, projectLinkAction } from './prepare.js';
import { lifecycleActions } from './actions.js';
import { targetOptionsAction } from './options.js';
import { buildLogsAction } from './logs.js';

/** One declaration map consumed by daemon manifest and portable Account activation. */
export const accountActions: NonNullable<DefinePluginInput<Readonly<Record<
  string,
  Extract<PluginActionDeclaration, { execution: { target: 'account' } }>
>>>['actions']> = {
  'targets-inspect-v1': projectPrepareAction,
  'project-link': projectLinkAction,
  'target-options-read': targetOptionsAction,
  'build-logs-read': buildLogsAction,
  ...lifecycleActions,
};

export const pluginIdentity = { id: 'happier.deploy.vercel', version: '0.0.0', displayName: 'Vercel deployments' } as const;
