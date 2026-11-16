import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { actionSchema, resultSchema } from './schemas.js';
import type { Operation } from './schemas.js';
import { run } from './operations.js';
import { dataActionInputHints } from './inputs.js';

export const accountExecution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
function action(operation: Operation, title: string, readOnly: boolean) {
  return { title, surfaces: ['cli', 'plugin', 'ui', 'agent'] as const, placementBindings: [], execution: accountExecution,
    inputSchema: actionSchema(operation), resultSchema: resultSchema(operation), readOnly,
    inputHints: dataActionInputHints[operation],
    dangerLevel: readOnly ? 'safe' as const : operation === 'branches-delete' || operation === 'projects-delete' ? 'destructive' as const : operation === 'connections-save' ? 'writesLocal' as const : 'writesRemote' as const,
    hostAccess: ['supabase-api', 'deploy-manage'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy-manage' }],
    ...(!readOnly ? { confirmation: { title } } : {}),
    run: (input: JsonValue, context: PluginAccountActionContext) => run(operation, input, context) };
}
export const dataActions = {
  'projects-delete': action('projects-delete', 'Delete the recorded Supabase project and all of its data', false),
  'projects-observe': action('projects-observe', 'Observe the recorded Supabase project after deletion', true),
  'projects-list': action('projects-list', 'List Supabase projects', true),
  'provision-options': action('provision-options', 'Read Supabase provision options', true),
  'projects-provision': action('projects-provision', 'Create Supabase project', false),
  'projects-link': action('projects-link', 'Inspect existing Supabase project', true),
  'branches-list': action('branches-list', 'List Supabase branches', true),
  'branches-create': action('branches-create', 'Create Supabase preview branch', false),
  'branches-delete': action('branches-delete', 'Delete Supabase preview branch', false),
  'connections-save': action('connections-save', 'Save Supabase database connections', false),
};
