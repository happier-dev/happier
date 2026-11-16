import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { neonConnectedAccountRuntime, neonPortableRuntime } from './connectedAccounts/runtime.js';
import { accountExecution, dataActions } from './data/actions.js';
import { dataResource } from './data/resources.js';
import { dataInputResources, dataInputTypes } from './data/inputs.js';
import { targetSchema } from './data/schemas.js';
import { queryAction } from './data/query.js';

const resource = (actionId: string) => ({ source: 'dynamic' as const, kind: 'config' as const,
  contentType: 'application/json', scope: 'surface' as const, execution: accountExecution, runtime: dataResource(actionId) });

export const plugin = definePlugin({
  id: 'happier.deploy.neon',
  version: '0.0.0',
  displayName: 'Neon deployments',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [
    { id: 'neon-api', capability: 'network', reason: 'Read the selected Neon resources and manage approved projects and preview branches.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://console.neon.tech' }], methods: ['GET', 'POST', 'DELETE'] } },
    { id: 'neon-sql', capability: 'network', reason: 'Query the selected branch using its bound read-only database login.',
      scope: { targets: [{ kind: 'httpsHostSuffix', hostSuffix: 'neon.tech' }], methods: ['POST'] } },
    { id: 'deploy-manage', capability: 'connectedAccounts', reason: 'Use the selected Neon management credential.',
      scope: { serviceRefs: ['neon'], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  connectedAccountDescriptors: { neon: {
    declaration: { title: 'Neon',
      description: 'Create a management API key at https://console.neon.tech: open Settings > API keys in your profile or selected organization. Choose its organization and optionally one existing project. Project-scoped keys cannot create organization projects. Setup verifies the selected scope; Neon checks permission for each operation.',
      authentication: { account: { artifactId: 'account-runtime', exportName: 'activateAccount' }, defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', title: 'Management API key', apiKey: true,
        browserReachability: 'unreachable',
        setup: {
          url: 'https://console.neon.tech',
          checklist: ['Open API keys in your Neon account settings or the selected organization settings and create a management API key.', 'Choose access for the organization or project you want to manage.', 'Copy the key when it is shown and enter the matching organization ID and optional project ID here.'],
          createKeyTitle: 'Open Neon Console',
        },
        credentialOrigin: 'authentication', outcomeReconciliation: 'none', directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        fields: [{ id: 'token', title: 'API key', secret: true, schema: { type: 'string', minLength: 1 } }],
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
          { id: 'organizationId', title: 'Organization ID', required: true, secret: false, schema: { type: 'string', minLength: 1 } },
          { id: 'projectId', title: 'Project ID', description: 'Optional exact project for a project-scoped key.', required: false, secret: false, schema: { type: 'string', minLength: 1 } },
        ] },
      }] } }, runtime: neonConnectedAccountRuntime, accountRuntime: neonPortableRuntime,
  } },
  actions: { ...dataActions, 'query-read': queryAction },
  inputTypes: dataInputTypes,
  resources: { ...dataInputResources, 'projects-list-resource': resource('projects-list-read'), 'provision-options-resource': resource('provision-options-read'),
    'branches-list-resource': resource('branches-list-read') },
  deploymentTargets: { database: { role: 'data', title: 'Neon', icon: 'server-outline', targetKind: 'neon',
    targetSchema: targetSchema.jsonSchema, linkSchema: targetSchema.jsonSchema,
    dataV1: { database: { engineId: 'postgresql' }, query: { readOnly: 'query-read' }, projects: { list: 'projects-list-resource', listAction: 'projects-list-read', provisionOptions: 'provision-options-resource',
      provisionOptionsAction: 'provision-options-read', provision: 'projects-provision', link: 'projects-link', delete: 'projects-delete', observe: 'projects-observe' },
      branches: { list: 'branches-list-resource', listAction: 'branches-list-read', create: 'branches-create', delete: 'branches-delete',
        previewInput: { name: { kind: 'input', name: 'preview', path: ['name'] },
          initialization: { kind: 'literal', value: 'parent-schema' },
          correlation: { kind: 'input', name: 'preview', path: ['correlation'] } } },
      connectionSecret: { save: 'connections-save' } },
  } },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
