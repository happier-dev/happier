import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { supabaseConnectedAccountRuntime, supabasePortableRuntime } from './connectedAccounts/runtime.js';
import { SUPABASE_OAUTH_SCOPES } from './connectedAccounts/oauth.js';
import { accountExecution, dataActions } from './data/actions.js';
import { actionResource } from './data/resources.js';
import { dataInputResources, dataInputTypes } from './data/inputs.js';
import { supabaseDatabaseRuntime } from './data/database.js';

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
      description: 'Create and manage Supabase projects and preview branches.',
      authentication: { account: { artifactId: 'account-runtime', exportName: 'activateAccount' }, defaultModeId: 'oauth', modes: [
      // No callbackUrl: the attempt uses the Home's Connected Account relay. The
      // client fields are written by the runtime's own registration, never typed.
      { id: 'oauth', kind: 'oauthAuthorizationCode', title: 'Sign in with Supabase', browserReachability: 'unreachable',
        scopes: [...SUPABASE_OAUTH_SCOPES], pkce: 'required', outcomeReconciliation: 'none', postAuthenticationFieldIds: ['organizationSlug'],
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
          { id: 'organizationSlug', title: 'Organization slug', required: false, secret: false, schema: { type: 'string', minLength: 1 } },
          { id: 'oauthClientId', title: 'OAuth client', required: false, secret: false, presentation: { hidden: true }, schema: { type: 'string', minLength: 1 } },
          { id: 'oauthRedirectUri', title: 'OAuth redirect URL', required: false, secret: false, presentation: { hidden: true }, schema: { type: 'string', minLength: 1 } },
          { id: 'oauthClientSecret', title: 'OAuth client secret', required: false, secret: true, presentation: { hidden: true }, schema: { type: 'string', minLength: 1 } },
        ] } },
      { id: 'token', kind: 'manual', title: 'Personal access token', credentialOrigin: 'authentication', outcomeReconciliation: 'none',
        browserReachability: 'unreachable',
        setup: {
          url: 'https://supabase.com/dashboard/account/tokens',
          checklist: ['Create a personal access token in your [Supabase account access-token settings].', 'Choose the organizations, projects, and permissions needed for the actions you want to use.', 'Copy the management token and enter the matching organization slug and optional project reference here.'],
          createKeyTitle: 'Open Supabase access tokens',
        },
        directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        credentialFieldKeys: { token: 'token' },
        fields: [{ id: 'token', title: 'Personal access token', description: 'A management token from your Supabase account, not a project’s anon or service-role key.', secret: true, schema: { type: 'string', minLength: 1 } }],
        configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
          { id: 'organizationSlug', title: 'Organization slug', required: true, secret: false, schema: { type: 'string', minLength: 1 } },
          { id: 'projectRef', title: 'Project reference', description: 'Only for a project-scoped token, which can’t create new projects.', required: false, secret: false, schema: { type: 'string', minLength: 1 } },
        ] },
      }] } }, runtime: supabaseConnectedAccountRuntime, accountRuntime: supabasePortableRuntime,
  } },
  actions: dataActions,
  inputTypes: dataInputTypes,
  // Supabase's mark beside its name: Simple Icons 13.21.0 (CC0-1.0), brand green #3FCF8E.
  brand: { iconResourceId: 'brand-icon' },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }, ...dataInputResources, 'projects-list-resource': resource('projects-list'), 'provision-options-resource': resource('provision-options'), 'branches-list-resource': resource('branches-list') },
  deploymentTargets: { database: { role: 'data', title: 'Supabase', icon: 'server-outline', targetKind: 'supabase', targetSchema: empty, linkSchema: empty,
    dataV1: { database: { engineId: 'postgresql', runtime: supabaseDatabaseRuntime }, projects: { list: 'projects-list-resource', listAction: 'projects-list', provisionOptions: 'provision-options-resource', provisionOptionsAction: 'provision-options', provision: 'projects-provision', link: 'projects-link', delete: 'projects-delete', observe: 'projects-observe' },
      branches: { list: 'branches-list-resource', listAction: 'branches-list', create: 'branches-create', delete: 'branches-delete',
        previewInput: { name: { kind: 'input', name: 'preview', path: ['name'] },
          gitBranch: { kind: 'input', name: 'preview', path: ['headRef'] }, withData: { kind: 'literal', value: false } } }, connectionSecret: { save: 'connections-save' } },
  } },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
