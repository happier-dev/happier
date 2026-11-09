import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

export const { manifest, activate } = definePlugin({
  id: '__pluginId__',
  version: '0.0.0',
  displayName: '__pluginDisplayName__',
  description: 'Template plugin generated for local development.',
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: { required: [], optional: [] },
  actions: {
    'save-note': {
      title: 'Save note',
      description: 'Stores a note in plugin-local storage and returns it.',
      surfaces: ['agent', 'cli', 'mcp'],
      tool: {
        name: 'notes_add',
        title: 'Add note',
        description: 'Stores a note through the canonical save-note action.',
      },
      cli: { path: ['notes', 'add'] },
      placementBindings: ['commandPalette'],
      inputSchema: defineProtocolObject({ note: defineProtocolString() }, { policy: 'closed' }),
      resultSchema: defineProtocolObject({ note: defineProtocolString() }, { policy: 'closed' }),
      async run(input, context) {
        const note = input.note;
        await context.services.storage.daemon.set('latestNote', note);
        return { note };
      },
    },
  },
  hooks: {
    'session-spawned': {
      declaration: {
        on: 'session.spawned',
      },
      handler: (_payload, context) => {
        context.services.logger.debug('template plugin observed session spawn');
      },
    },
  },
  settings: {
    preferences: {
      title: 'Plugin preferences',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'enabled',
        title: 'Enabled',
        description: 'Example host-rendered plugin preference.',
        schema: { type: 'boolean' },
        default: true,
      }],
    },
  },
});
