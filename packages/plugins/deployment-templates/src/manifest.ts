import { definePlugin } from '@happier-dev/plugin-sdk';

export const plugin = definePlugin({
  id: 'happier.deployment.templates',
  version: '0.0.0',
  displayName: 'Deployment templates',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [], optional: [] },
  registrySources: {
    'data-services': {
      title: 'Data services',
      format: 'happier-catalog',
      kinds: ['app'],
      packageContent: { path: 'resources/registry/apps.json' },
    },
    starters: {
      title: 'Project starters',
      format: 'happier-catalog',
      kinds: ['starter'],
      packageContent: { path: 'resources/registry/starters.json' },
    },
  },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
