import type { DefinePluginInput } from '@happier-dev/plugin-sdk';
import type { PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { CLOUDFLARE_ACCOUNT_ID, cloudflareConnectedAccountRuntime } from './connectedAccounts/runtime.js';
import { CLOUDFLARE_IDENTITY_SCOPES } from './connectedAccounts/oauth.js';
import { cloudflarePortableAuthentication } from './connectedAccounts/portableAuthentication.js';
import { cloudflareClientPermissionGuide, cloudflarePermissionGuide, cloudflareFeatureNames } from './connectedAccounts/permissions.js';
import { tunnelActions } from './platform/tunnel.js';
import { zoneActions } from './platform/zone.js';
import { selectionActions } from './platform/selections.js';
import { workerActions, workerLinkSchema } from './platform/workersActions.js';
import { pagesCreate, workersCreate } from './platform/create.js';
import { pagesLink, pagesLinkSchema } from './platform/pagesPrepare.js';
import { pagesLifecycleActions } from './platform/pagesDeploy.js';
import { pagesTrafficActions } from './platform/traffic.js';
import { workerTrafficActions } from './platform/workerTraffic.js';
import { pagesLogsActions, workersLogsActions } from './platform/logs.js';
import { domainActions } from './platform/domains.js';
import { variableActions } from './platform/variables.js';
import { dnsRecordActions } from './platform/dnsRecords.js';

import { targetOptionResources, targetOptionsRead, targetOptionInputTypes } from './platform/targetOptions.js';
import { inspect, productInspectActions } from './platform/inspect.js';

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

type CloudflareActionDeclarations = typeof productInspectActions & typeof tunnelActions & typeof zoneActions & typeof selectionActions
  & typeof workerActions & typeof workerTrafficActions & typeof pagesLifecycleActions & typeof pagesTrafficActions & typeof pagesLogsActions & typeof workersLogsActions & typeof domainActions & typeof variableActions & typeof dnsRecordActions & Readonly<{
    'target-options-read': typeof targetOptionsRead;
    'targets-inspect-v1': typeof inspect;
    'pages-link': typeof pagesLink;
    'pages-create': typeof pagesCreate;
    'workers-create': typeof workersCreate;
  }>;

const actions: Readonly<{
  [TId in keyof CloudflareActionDeclarations]: PluginActionDefinition<
    Omit<CloudflareActionDeclarations[TId], 'run' | 'observeRead'>>;
}> = { 'target-options-read': targetOptionsRead, ...productInspectActions, ...tunnelActions, ...zoneActions, ...selectionActions, ...workerActions, ...workerTrafficActions, ...pagesLifecycleActions, ...pagesTrafficActions, ...pagesLogsActions, ...workersLogsActions, ...domainActions, ...variableActions, ...dnsRecordActions, 'targets-inspect-v1': inspect, 'pages-link': pagesLink, 'pages-create': pagesCreate, 'workers-create': workersCreate } as const;

// Wrangler Pages starts its deployment status wait at one second. The plugin declares the same cadence for Workers.
const deploymentTargets = { workers: { statusIntervalMs: 1000, role: 'runtime', title: 'Cloudflare Workers', targetKind: 'cloudflare-workers', icon: 'server-outline',
    description: 'Code that runs on Cloudflare’s network',
    plans: [
      {
        "id": "free",
        "title": "Free",
        "facts": [
          {
            "label": "Price",
            "value": "$0"
          },
          {
            "label": "Requests",
            "value": "100,000 a day"
          },
          {
            "label": "CPU time",
            "value": "10 ms per invocation"
          }
        ],
        "included": [
          "No data transfer charges"
        ],
        "source": {
          "url": "https://developers.cloudflare.com/workers/platform/pricing/",
          "checkedAt": "2026-11-16"
        }
      },
      {
        "id": "paid",
        "title": "Paid",
        "facts": [
          {
            "label": "Price",
            "value": "From $5 a month per account"
          },
          {
            "label": "Requests",
            "value": "10M a month"
          },
          {
            "label": "CPU time",
            "value": "30M ms a month"
          },
          {
            "label": "Extra requests",
            "value": "$0.30 per 1M"
          },
          {
            "label": "Extra CPU time",
            "value": "$0.02 per 1M ms"
          }
        ],
        "included": [
          "No data transfer charges",
          "Pages Functions usage included in Workers billing"
        ],
        "source": {
          "url": "https://developers.cloudflare.com/workers/platform/pricing/",
          "checkedAt": "2026-11-16"
        }
      }
    ],
    accepts: ['workers'], needs: ['repository', 'stateless'], sources: { gitIntegration: [], upload: true },
    targetSchema: { type: 'object', properties: {}, additionalProperties: false }, linkSchema: workerLinkSchema,
    actions: { inspect: 'workers-inspect', link: 'workers-link', create: 'workers-create', deploy: 'workers-deploy', observe: 'workers-observe', cancel: 'workers-cancel', teardown: 'workers-teardown', promote: 'workers-promote', rollback: 'workers-rollback',
      logs: { build: 'workers-build-logs-read' },
      variables: { read: 'workers-variables-read', sync: 'workers-variables-sync' },
      domains: { read: 'workers-domains-read', add: 'workers-domains-add', verify: 'workers-domains-verify', remove: 'workers-domains-remove' } } },
    pages: { statusIntervalMs: 1000, role: 'runtime', title: 'Cloudflare Pages', targetKind: 'cloudflare-pages', icon: 'server-outline',
      accepts: ['static'], needs: ['repository', 'stateless'], sources: { gitIntegration: ['github', 'gitlab'], upload: true },
      description: 'Static and server-rendered sites',
      plans: [
        {
          "id": "free",
          "title": "Free",
          "facts": [
            {
              "label": "Price",
              "value": "$0"
            },
            {
              "label": "Builds",
              "value": "500 a month"
            },
            {
              "label": "At a time",
              "value": "1 build"
            },
            {
              "label": "Projects",
              "value": "100 per account"
            }
          ],
          "included": [
            "Custom domains",
            "Preview deployments",
            "Functions billed separately as Workers"
          ],
          "source": {
            "url": "https://developers.cloudflare.com/pages/platform/limits/",
            "checkedAt": "2026-11-16"
          }
        }
      ],
      targetSchema: { type: 'object', properties: {}, additionalProperties: false }, linkSchema: pagesLinkSchema,
      actions: { inspect: 'pages-inspect', link: 'pages-link', create: 'pages-create', deploy: 'pages-deploy', observe: 'pages-observe', rollback: 'pages-rollback', logs: { build: 'pages-build-logs-read' },
        variables: { read: 'pages-variables-read', sync: 'pages-variables-sync' },
        domains: { read: 'pages-domains-read', add: 'pages-domains-add', verify: 'pages-domains-verify', remove: 'pages-domains-remove' } } } } as const;

export const definition: Pick<DefinePluginInput<typeof actions>,
  'version' | 'displayName' | 'entrypoints' | 'activation' | 'hostAccess' | 'inputTypes' | 'brand'
  | 'resources' | 'connectedAccountDescriptors'> & Readonly<{
  id: 'happier.deploy.cloudflare'; actions: typeof actions; deploymentTargets: typeof deploymentTargets;
}> = {
  id: 'happier.deploy.cloudflare',
  version: '0.0.0',
  displayName: 'Cloudflare deployments',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [{ id: 'cloudflare-api', capability: 'network',
    reason: 'Verify the token, selected account and selected feature resources before saving.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET'] },
  }, { id: 'cloudflare-tunnel', capability: 'network', reason: 'Create or adopt the reviewed remote tunnel, read its connector token and reconcile owned configuration and DNS records.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET', 'POST', 'PUT', 'DELETE'] },
  }, { id: 'cloudflare-workers', capability: 'network', reason: 'Inspect, deploy or delete the selected Worker or Preview and manage its reviewed builds.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  }, { id: 'cloudflare-pages', capability: 'network', reason: 'Adopt an existing Pages project and upload the reviewed prepared assets and Functions.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  }, { id: 'cloudflare-oauth', capability: 'network', reason: 'Exchange, refresh and revoke the registered Cloudflare OAuth authorization.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://dash.cloudflare.com' }], methods: ['GET', 'POST'] },
  }, { id: 'cloudflare-dns', capability: 'network', reason: 'Read and create the reviewed DNS records in the selected Cloudflare zone.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.cloudflare.com' }], methods: ['GET', 'POST'] },
  }, { id: 'deploy.manage', capability: 'connectedAccounts', reason: 'Use the selected Cloudflare deployment account.',
    scope: { serviceRefs: [CLOUDFLARE_ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] },
  }, { id: 'tunnel.manage', capability: 'connectedAccounts', reason: 'Manage the reviewed Cloudflare tunnel routes with the selected account.',
    scope: { serviceRefs: [CLOUDFLARE_ACCOUNT_ID], operations: ['use'], materializationKinds: ['httpHeaders'] },
  }], optional: [] },
  inputTypes: targetOptionInputTypes,
  // Cloudflare's mark beside its name: Simple Icons 13.21.0 (CC0-1.0), brand orange #F38020.
  brand: { iconResourceId: 'brand-icon' },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }, ...targetOptionResources },
  actions,
  deploymentTargets,
  connectedAccountDescriptors: { [CLOUDFLARE_ACCOUNT_ID]: {
    declaration: { title: 'Cloudflare',
      description: 'Connect Cloudflare to deploy Workers and Pages or manage tunnels and DNS.',
      authentication: { account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'oauth', modes: [
        // No callbackUrl: the attempt uses the Home's Connected Account relay.
        { id: 'oauth', kind: 'oauthAuthorizationCode', title: 'Sign in with Cloudflare',
          browserReachability: 'unreachable',
          clientConfiguration: { clientIdFieldId: 'clientId', scopesFieldId: 'registeredScopes' },
          postAuthenticationFieldIds: ['accountId'],
          setup: { url: 'https://dash.cloudflare.com/?to=/:account/oauth-clients',
            checklist: ['Register an OAuth client in [Cloudflare]', 'Choose Authorization Code with PKCE and no client secret.',
              'Add the redirect URL below, grant the scopes below, then paste the client ID and scope IDs.'],
            permissions: cloudflareClientPermissionGuide },
          scopes: CLOUDFLARE_IDENTITY_SCOPES, pkce: 'required', outcomeReconciliation: 'none', configuration: oauthConfiguration },
        { id: 'token', kind: 'manual', title: 'API token', credentialOrigin: 'authentication', outcomeReconciliation: 'none',
          credentialFieldKeys: { token: 'token' },
          browserReachability: 'unreachable',
          directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }, configuration: tokenConfiguration,
          setup: { url: 'https://dash.cloudflare.com/profile/api-tokens',
            checklist: ['Open [API tokens in Cloudflare]', 'Create a token with the permissions below for what you’ll use.', 'Copy it, then paste it below.'],
            permissions: cloudflarePermissionGuide },
          fields: [{ id: 'token', title: 'API token', secret: true, schema: { type: 'string', minLength: 1 },
            description: 'Happier checks the selected account and read access for the features you choose.' }],
        },
      ] },
    }, runtime: cloudflareConnectedAccountRuntime, accountRuntime: cloudflarePortableAuthentication,
  } },
} as const;
