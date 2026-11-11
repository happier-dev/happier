import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectPrepareResultSchema } from './platform/prepare.js';
import { accountActions, pluginIdentity } from './platform/accountActions.js';
import { uploadAction } from './platform/upload.js';
import { targetInputTypes, targetOptionsResources } from './platform/options.js';

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
  resources: targetOptionsResources,
  inputTypes: targetInputTypes,
  deploymentTargets: { runtime: { role: 'runtime', title: 'Vercel', targetKind: 'vercel', icon: 'server-outline',
    targetSchema: { type: 'object', properties: {}, additionalProperties: false }, linkSchema: projectPrepareResultSchema,
    actions: { inspect: 'targets-inspect-v1', link: 'project-link', deploy: 'deploy', uploadDeploy: 'deploy-upload-v1', observe: 'observe', cancel: 'cancel', promote: 'promote', rollback: 'rollback',
      logs: { build: 'build-logs-read' }, variables: { read: 'variables-read', sync: 'variables-sync' },
      domains: { read: 'domains-read', add: 'domains-add', verify: 'domains-verify', remove: 'domains-remove' } } } },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
