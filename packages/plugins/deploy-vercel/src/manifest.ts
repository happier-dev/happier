import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectPrepareResultSchema } from './platform/prepare.js';
import { accountActions, pluginIdentity } from './platform/accountActions.js';
import { uploadAction } from './platform/upload.js';
import { targetInputTypes, targetOptionsResources } from './platform/options.js';
import { vercelGitIntegrations } from './platform/operations.js';

export const plugin = definePlugin({
  ...pluginIdentity,
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [{ id: 'vercel-api', capability: 'network', reason: 'Inspect the selected Vercel project and manage its reviewed deployments.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.vercel.com' }], methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  }, { id: 'deploy.manage', capability: 'connectedAccounts', reason: 'Use the selected Vercel deployment account.',
    scope: { serviceRefs: [{ pluginId: 'happier.machine.vercel', localId: 'vercel-account' }], operations: ['use'], materializationKinds: ['httpHeaders', 'environment'] },
  }], optional: [] },
  actions: { ...accountActions, 'deploy-upload-v1': uploadAction },
  // Vercel's mark beside its name: the same packaged triangle as the Vercel AI Gateway plugin, inked like text.
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }, ...targetOptionsResources },
  inputTypes: targetInputTypes,
  // Vercel client getPollingDelay starts at one second; only demanded pending receipts use this cadence.
  deploymentTargets: { runtime: { statusIntervalMs: 1000, role: 'runtime', title: 'Vercel', targetKind: 'vercel', icon: 'server-outline',
    description: 'Hosting for web apps · builds from your repository',
    plans: [
      {
        "id": "hobby",
        "title": "Hobby",
        "price": {
          "amount": "0",
          "currency": "USD",
          "unit": "month"
        },
        "facts": [
          {
            "label": "Seats",
            "value": "1 developer"
          },
          {
            "label": "Transfer",
            "value": "100 GB a month"
          },
          {
            "label": "CDN requests",
            "value": "1M a month"
          },
          {
            "label": "More usage",
            "value": "Not available"
          }
        ],
        "included": [
          "Personal, non-commercial projects",
          "Automatic HTTPS",
          "Preview deployments"
        ],
        "source": {
          "url": "https://vercel.com/docs/plans/hobby",
          "checkedAt": "2026-11-16"
        }
      },
      {
        "id": "pro",
        "title": "Pro",
        "price": {
          "amount": "20",
          "currency": "USD",
          "unit": "month"
        },
        "facts": [
          {
            "label": "Seats",
            "value": "1 deploying seat included"
          },
          {
            "label": "Each extra deploying seat",
            "price": {
              "amount": "20",
              "currency": "USD",
              "unit": "month"
            }
          },
          {
            "label": "Usage credit included",
            "price": {
              "amount": "20",
              "currency": "USD",
              "unit": "month"
            }
          },
          {
            "label": "Transfer",
            "value": "1 TB a month"
          },
          {
            "label": "CDN requests",
            "value": "1M a month"
          },
          {
            "label": "More usage",
            "value": "On-demand billing"
          }
        ],
        "included": [
          "Free viewer seats",
          "Team collaboration",
          "Spend management"
        ],
        "source": {
          "url": "https://vercel.com/docs/plans/pro-plan",
          "checkedAt": "2026-11-16"
        }
      }
    ],
    accepts: ['static', 'server'], needs: ['repository', 'stateless'],
    sources: { gitIntegration: vercelGitIntegrations.map(provider => provider.kind), upload: true },
    targetSchema: { type: 'object', properties: {}, additionalProperties: false }, linkSchema: projectPrepareResultSchema,
    actions: { inspect: 'targets-inspect-v1', link: 'project-link', create: 'project-create', deploy: 'deploy', uploadDeploy: 'deploy-upload-v1', observe: 'observe', cancel: 'cancel', promote: 'promote', rollback: 'rollback', teardown: 'teardown',
      logs: { build: 'build-logs-read', runtime: 'runtime-logs-read' }, variables: { read: 'variables-read', sync: 'variables-sync' },
      domains: { read: 'domains-read', add: 'domains-add', verify: 'domains-verify', remove: 'domains-remove' } } } },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
