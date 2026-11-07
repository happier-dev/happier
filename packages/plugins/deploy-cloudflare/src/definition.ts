import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { CLOUDFLARE_ACCOUNT_ID, cloudflareConnectedAccountRuntime } from './connectedAccounts/runtime.js';
import { CLOUDFLARE_CALLBACK_URL, CLOUDFLARE_IDENTITY_SCOPES } from './connectedAccounts/oauth.js';
import { cloudflarePortableAuthentication } from './connectedAccounts/portableAuthentication.js';
import { cloudflareClientPermissionGuide, cloudflarePermissionGuide, cloudflareFeatureNames } from './connectedAccounts/permissions.js';
import { tunnelActions } from './platform/tunnel.js';
import { zoneActions } from './platform/zone.js';
import { selectionActions } from './platform/selections.js';
import { workerActions, workerLinkSchema } from './platform/workersActions.js';
import { pagesLink, pagesLinkSchema } from './platform/pagesPrepare.js';
import { pagesLifecycleActions } from './platform/pagesDeploy.js';

import { targetOptions, targetOptionsRead, targetOptionInputTypes } from './platform/targetOptions.js';
import { inspect } from './platform/inspect.js';

const accountConfiguration = {
  scope: 'account', changeBehavior: 'reconnect', fields: [{ id: 'accountId', title: 'Account ID',
    description: 'The Cloudflare account that owns your resources.',
    schema: { type: 'string', pattern: '^[a-fA-F0-9]{32}$' }, required: true, secret: false }],
} as const;

const oauthConfiguration = { scope: 'account', changeBehavior: 'reconnect', fields: [
  { ...accountConfiguration.fields[0], required: false },
  // How to register the client is the browser mode's `setup` guide; the fields say only what they hold.
  { id: 'clientId', title: 'OAuth client ID', presentation: { advanced: true },
    schema: { type: 'string', minLength: 1 }, required: false, secret: false },
  { id: 'registeredScopes', title: 'Registered API scope IDs', presentation: { advanced: true },
    description: 'The scope IDs you registered, separated by spaces.',
    schema: { type: 'string', minLength: 1 }, required: false, secret: false },
] } as const;

const tokenConfiguration = { ...accountConfiguration, fields: [...accountConfiguration.fields,
  { id: 'features', title: 'Features', description: 'Check read access for the features you plan to use. Cloudflare checks write permissions when you use each feature.',
    schema: { type: 'array', items: { type: 'string', enum: cloudflareFeatureNames } },
    default: [], required: false, secret: false },
  { id: 'tokenOwner', title: 'Token owner', description: 'Account tokens support Pages, Tunnel and DNS. Workers Builds requires a user token.',
    schema: { type: 'string', enum: ['user', 'account'] }, default: 'user', required: false, secret: false },
  { id: 'zoneId', title: 'DNS zone ID', presentation: { advanced: true }, description: 'Optional zone for DNS record changes.',
    schema: { type: 'string', pattern: '^[a-fA-F0-9]{32}$' }, required: false, secret: false },
] } as const;

export const definition = {
  id: 'happier.deploy.cloudflare',
  version: '0.0.0',
  displayName: 'Cloudflare deployments',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [{ id: 'cloudflare-api', capability: 'network',
    reason: 'Verify the token, selected account and selected feature resources before saving.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET'] },
  }, { id: 'cloudflare-tunnel', capability: 'network', reason: 'Create or adopt the reviewed remote tunnel, read its connector token and reconcile owned configuration and DNS records.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET', 'POST', 'PUT', 'DELETE'] },
  }, { id: 'cloudflare-workers', capability: 'network', reason: 'Inspect the selected Worker and deploy, observe or cancel its reviewed Git build.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET', 'POST', 'PUT'] },
  }, { id: 'cloudflare-pages', capability: 'network', reason: 'Adopt an existing Pages project and upload the reviewed prepared assets and Functions.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET', 'POST'] },
  }, { id: 'cloudflare-oauth', capability: 'network', reason: 'Exchange, refresh and revoke the registered Cloudflare OAuth authorization.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://dash.cloudflare.com' }], methods: ['GET', 'POST'] },
  }, { id: 'deploy.manage', capability: 'connectedAccounts', reason: 'Use the selected Cloudflare deployment account.',
    scope: { serviceRefs: [CLOUDFLARE_ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] },
  }, { id: 'tunnel.manage', capability: 'connectedAccounts', reason: 'Manage the reviewed Cloudflare tunnel routes with the selected account.',
    scope: { serviceRefs: [CLOUDFLARE_ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] },
  }], optional: [] },
  inputTypes: targetOptionInputTypes,
  // Cloudflare's mark beside its name: Simple Icons 13.21.0 (CC0-1.0), brand orange #F38020.
  brand: { iconResourceId: 'brand-icon' },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }, 'target-options': { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'global',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } }, runtime: targetOptions } },
  actions: { 'target-options-read': targetOptionsRead, ...tunnelActions, ...zoneActions, ...selectionActions, ...workerActions, ...pagesLifecycleActions, 'targets-inspect-v1': inspect, 'pages-link': pagesLink },
  deploymentTargets: { workers: { role: 'runtime', title: 'Cloudflare Workers', targetKind: 'cloudflare-workers', icon: 'server-outline',
    targetSchema: { type: 'object', properties: {}, additionalProperties: false }, linkSchema: workerLinkSchema,
    actions: { inspect: 'targets-inspect-v1', link: 'workers-link', deploy: 'workers-deploy', observe: 'workers-observe', cancel: 'workers-cancel' } },
    pages: { role: 'runtime', title: 'Cloudflare Pages', targetKind: 'cloudflare-pages', icon: 'server-outline',
      description: 'Adopt an existing Pages project. Deploy exact prepared output with Direct Upload; Git builds select branch HEAD.',
      targetSchema: { type: 'object', properties: {}, additionalProperties: false }, linkSchema: pagesLinkSchema,
      actions: { inspect: 'targets-inspect-v1', link: 'pages-link', deploy: 'pages-deploy', observe: 'pages-observe' } } },
  connectedAccountDescriptors: { [CLOUDFLARE_ACCOUNT_ID]: {
    declaration: { title: 'Cloudflare',
      description: 'Connect Cloudflare to deploy Workers and Pages or manage tunnels and DNS.',
      authentication: { account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'oauth', modes: [
        { id: 'oauth', kind: 'oauthAuthorizationCode', title: 'Sign in with Cloudflare', callbackUrl: CLOUDFLARE_CALLBACK_URL,
          clientConfiguration: { clientIdFieldId: 'clientId', scopesFieldId: 'registeredScopes' },
          postAuthenticationFieldIds: ['accountId'],
          setup: { url: 'https://dash.cloudflare.com/?to=/:account/oauth-clients',
            checklist: ['Register an OAuth client in Cloudflare', 'Choose Authorization Code with PKCE and no client secret.',
              'Add the redirect URL below, grant the scopes below, then paste the client ID and scope IDs.'],
            permissions: cloudflareClientPermissionGuide },
          scopes: CLOUDFLARE_IDENTITY_SCOPES, pkce: 'required', outcomeReconciliation: 'none', configuration: oauthConfiguration },
        { id: 'token', kind: 'manual', title: 'API token', credentialOrigin: 'authentication', outcomeReconciliation: 'none',
          directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }, configuration: tokenConfiguration,
          setup: { url: 'https://dash.cloudflare.com/profile/api-tokens',
            checklist: ['Open API tokens in Cloudflare', 'Create a token with the permissions below for what you’ll use.', 'Copy it, then paste it below.'],
            permissions: cloudflarePermissionGuide },
          fields: [{ id: 'token', title: 'API token', secret: true, schema: { type: 'string', minLength: 1 },
            description: 'Happier checks the selected account and read access for the features you choose.' }],
        },
      ] },
    }, runtime: cloudflareConnectedAccountRuntime, accountRuntime: cloudflarePortableAuthentication,
  } },
} as const;
