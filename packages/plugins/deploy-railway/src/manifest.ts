import { definePlugin } from '@happier-dev/plugin-sdk';
import { railwayHostAccess, railwayIdentity } from './platform/account.js';
import { railwaySelectorSchema } from './platform/coordinates.js';
import { coreActions, railwayLinkContentSchema } from './platform/coreActions.js';
import { railwayScopeCreateActions } from './platform/createScope.js';
import { railwayScopeDeleteActions } from './platform/deleteScope.js';
import { domainActions } from './platform/domains.js';
import { buildLogsAction, runtimeLogsAction } from './platform/logs.js';
import { optionsAction, optionsInputTypes, optionsResources } from './platform/options.js';
import { variableActions } from './platform/variables.js';

const pricing = { url: 'https://docs.railway.com/pricing/plans', checkedAt: '2026-11-20' };

const locales = ['ca', 'de', 'en', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant'] as const;

export const plugin = definePlugin({
  ...railwayIdentity,
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: railwayHostAccess,
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
    ...optionsResources,
    ...Object.fromEntries(locales.map(locale => [`i18n-${locale.toLowerCase()}`,
      { kind: 'asset' as const, path: `assets/i18n/${locale}.json`, contentType: 'application/json' }])),
  },
  ui: { translations: locales.map(locale => ({ locale, resourceId: `i18n-${locale.toLowerCase()}` })) },
  inputTypes: optionsInputTypes,
  actions: { ...coreActions, ...railwayScopeCreateActions, ...railwayScopeDeleteActions, ...domainActions, ...variableActions, 'target-options-read': optionsAction,
    'build-logs-read': buildLogsAction, 'runtime-logs-read': runtimeLogsAction },
  deploymentTargets: { runtime: {
    role: 'runtime', targetKind: 'railway', title: 'Railway', icon: 'server-outline',
    description: 'Run a web app or backend from GitHub',
    accepts: ['static', 'server', 'container'], needs: ['repository'],
    sources: { gitIntegration: ['github'], upload: false },
    gitSource: { guarantee: 'exactCommit', requiresPublishedCheckout: true, create: 'branchHead' },
    nativeSelectorSchema: railwaySelectorSchema, generatedDomains: true,
    logFollow: false,
    targetSchema: { type: 'object', properties: {}, additionalProperties: false },
    linkSchema: railwayLinkContentSchema,
    plans: [
      { id: 'free', title: 'Free', price: { amount: '0', currency: 'USD', unit: 'month' },
        facts: [{ label: 'Memory limit', value: '0.5 GB per service' }], included: ['For small apps that can sleep when idle'], source: pricing },
      { id: 'hobby', title: 'Hobby', price: { amount: '5', currency: 'USD', unit: 'month' },
        facts: [{ label: 'Included resource usage', price: { amount: '5', currency: 'USD', unit: 'month' } }],
        included: ['Subscription fee counts toward resource usage'], source: pricing },
      { id: 'pro', title: 'Pro', price: { amount: '20', currency: 'USD', unit: 'month' },
        facts: [], included: ['Team collaboration', 'Subscription fee counts toward resource usage'], source: pricing },
    ],
    actions: { inspect: 'targets-inspect-v1', link: 'service-link', create: 'service-create', deploy: 'deploy', observe: 'observe', cancel: 'cancel', teardown: 'teardown',
      domains: { add: 'domains-add', read: 'domains-read', verify: 'domains-verify', remove: 'domains-remove' },
      variables: { read: 'variables-read', sync: 'variables-sync' }, logs: { build: 'build-logs-read', runtime: 'runtime-logs-read' } },
  } },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
