import { definePlugin } from '@happier-dev/plugin-sdk';

export const { manifest, activate } = definePlugin({
  id: '__pluginId__',
  version: '0.0.0',
  displayName: '__pluginDisplayName__',
  description: 'Template plugin generated for local development.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: { required: [], optional: [] },
  actions: {
    'save-note': {
      title: 'Save note',
      execution: { target: 'daemon' },
      description: 'Stores a note in plugin-local storage and returns it.',
      scopes: ['global'],
      surfaces: ['agent', 'cli', 'mcp'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { note: { type: 'string' } },
        required: ['note'],
      },
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { note: { type: 'string' } },
        required: ['note'],
      },
      async run(input, context) {
        const note = typeof input === 'object'
          && input !== null
          && 'note' in input
          && typeof input.note === 'string'
          ? input.note
          : '';
        await context.services.storage.daemon.set('latestNote', note);
        return { note: await context.services.storage.daemon.get('latestNote') };
      },
    },
  },
  tools: {
    'notes-add': {
      name: 'notes_add',
      title: 'Add note',
      description: 'Stores a note through the canonical save-note action.',
      surfaces: ['agent', 'mcp'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { note: { type: 'string' } },
        required: ['note'],
      },
      action: 'save-note',
    },
  },
  commands: {
    'notes-add-command': {
      title: 'Add note',
      path: ['notes', 'add'],
      action: 'save-note',
    },
  },
  hooks: {
    'session-spawned': {
      declaration: {
        on: 'session.spawned',
        hookApiVersion: 1,
        category: 'lifecycle',
        scope: 'session',
        executionKind: 'observe',
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
