import { definePlugin } from '@happier-dev/plugin-sdk';
import { definition } from './definition.js';
import { pagesUpload } from './platform/pagesUpload.js';

export const plugin = definePlugin({ ...definition,
  systemTools: { docker: { title: 'Docker', executableNames: ['docker'] } },
  actions: { ...definition.actions, 'pages-upload': pagesUpload },
  deploymentTargets: { ...definition.deploymentTargets, pages: { ...definition.deploymentTargets.pages,
    actions: { ...definition.deploymentTargets.pages.actions, uploadDeploy: 'pages-upload' } } },
});
export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
