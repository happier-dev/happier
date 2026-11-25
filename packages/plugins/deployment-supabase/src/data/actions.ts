import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { actionSchema, resultSchema } from './schemas.js';
import type { Operation } from './schemas.js';
import { run } from './operations.js';
import { dataActionInputHints } from './inputs.js';

export const accountExecution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
function action(operation: Operation, title: string, description: string, readOnly: boolean) {
  return { title, description, surfaces: ['cli', 'plugin', 'ui', 'agent'] as const, placementBindings: [], execution: accountExecution,
    inputSchema: actionSchema(operation), resultSchema: resultSchema(operation), readOnly,
    inputHints: dataActionInputHints[operation],
    dangerLevel: readOnly ? 'safe' as const : operation === 'branches-delete' || operation === 'projects-delete' ? 'destructive' as const : operation === 'connections-save' ? 'writesLocal' as const : 'writesRemote' as const,
    hostAccess: ['supabase-api', 'deploy-manage'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy-manage' }],
    ...(!readOnly ? { confirmation: { title } } : {}),
    run: (input: JsonValue, context: PluginAccountActionContext) => run(operation, input, context) };
}
export const dataActions = {
  'projects-delete': action('projects-delete', 'Delete the recorded Supabase project and all of its data', "Delete the Supabase project named in the reviewed deployment link, including its data.", false),
  'projects-observe': action('projects-observe', 'Observe the recorded Supabase project after deletion', "Confirm whether the Supabase project named in the deployment link still exists after removal.", true),
  'projects-list': action('projects-list', 'List Supabase projects', "Find projects the selected Supabase connection can access so one can be adopted as a database target.", true),
  'provision-options': action('provision-options', 'Read Supabase provision options', "Read the organizations and regions available to the selected Supabase connection.", true),
  'projects-provision': action('projects-provision', 'Create Supabase project', "Provision a Supabase project with the reviewed organization, region and name.", false),
  'projects-link': action('projects-link', 'Inspect existing Supabase project', "Read the selected Supabase project and return the database target information required to link it.", true),
  'branches-list': action('branches-list', 'List Supabase branches', "List the database branches under the linked Supabase project.", true),
  'branches-create': action('branches-create', 'Create Supabase preview branch', "Create a preview database branch under the linked Supabase project.", false),
  'branches-delete': action('branches-delete', 'Delete Supabase preview branch', "Delete the reviewed preview branch from the linked Supabase project.", false),
  'connections-save': action('connections-save', 'Save Supabase database connections', "Save database connection material for the linked Supabase project and the reviewed audience.", false),
};
