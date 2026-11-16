import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { supabaseConnectedAccountRuntime, supabasePortableRuntime } from './connectedAccounts/runtime.js';
import { accountExecution, dataActions } from './data/actions.js';
import { actionResource } from './data/resources.js';
import { dataInputResources, dataInputTypes } from './data/inputs.js';
import { queryAction } from './data/query.js';

const empty = { type: 'object', properties: {}, additionalProperties: false } as const;
const resource = (actionId: string) => ({ source: 'dynamic' as const, kind: 'config' as const, contentType: 'application/json', scope: 'surface' as const,
  execution: accountExecution, runtime: actionResource(actionId) });

export const plugin = definePlugin({
  id: 'happier.deploy.supabase',
  version: '0.0.0',
  displayName: 'Supabase deployments',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [{ id: 'supabase-api', capability: 'network', reason: 'Read the selected Supabase resources and manage approved projects and preview branches.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.supabase.com' }], methods: ['GET', 'POST', 'DELETE'] } },
  { id: 'deploy-manage', capability: 'connectedAccounts', reason: 'Use the selected Supabase management credential.',
    scope: { serviceRefs: ['supabase'], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
  connectedAccountDescriptors: { supabase: {
    declaration: { title: 'Supabase',
      description: 'Use a Supabase management personal access token, not an application anon or service-role key. Choose the organization and optionally one existing project. Setup verifies that exact scope; Supabase checks permission for each operation. Project-scoped access cannot create organization projects.',
      authentication: { account: { artifactId: 'account-runtime', exportName: 'activateAccount' }, defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', title: 'Personal access token', credentialOrigin: 'authentication', outcomeReconciliation: 'none',
        browserReachability: 'unreachable',
        setup: {
          url: 'https://supabase.com/dashboard/account/tokens',
          checklist: ['Create a personal access token in your [Supabase account access-token settings].', 'Choose the organizations, projects, and permissions needed for the actions you want to use.', 'Copy the management token and enter the matching organization slug and optional project reference here.'],
          createKeyTitle: 'Open Supabase access tokens',
        },
        directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'Personal access token', secret: true, schema: { type: 'string', minLength: 1 } }],
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
          { id: 'organizationSlug', title: 'Organization slug', required: true, secret: false, schema: { type: 'string', minLength: 1 } },
          { id: 'projectRef', title: 'Project reference', description: 'Optional exact project reference for a project-scoped token.', required: false, secret: false, schema: { type: 'string', minLength: 1 } },
        ] },
      }] } }, runtime: supabaseConnectedAccountRuntime, accountRuntime: supabasePortableRuntime,
  } },
  actions: { ...dataActions, 'query-read': queryAction },
  inputTypes: dataInputTypes,
  resources: { ...dataInputResources, 'projects-list-resource': resource('projects-list'), 'provision-options-resource': resource('provision-options'), 'branches-list-resource': resource('branches-list') },
  deploymentTargets: { database: { role: 'data', title: 'Supabase', icon: 'server-outline', targetKind: 'supabase', targetSchema: empty, linkSchema: empty,
    dataV1: { query: { readOnly: 'query-read' }, projects: { list: 'projects-list-resource', listAction: 'projects-list', provisionOptions: 'provision-options-resource', provisionOptionsAction: 'provision-options', provision: 'projects-provision', link: 'projects-link', delete: 'projects-delete', observe: 'projects-observe' },
      branches: { list: 'branches-list-resource', listAction: 'branches-list', create: 'branches-create', delete: 'branches-delete',
        previewInput: { name: { kind: 'input', name: 'preview', path: ['name'] },
          gitBranch: { kind: 'input', name: 'preview', path: ['headRef'] }, withData: { kind: 'literal', value: false } } }, connectionSecret: { save: 'connections-save' } },
  } },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
