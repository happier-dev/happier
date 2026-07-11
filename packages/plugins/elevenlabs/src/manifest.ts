export const PLUGIN_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: 'happier.voice.elevenlabs',
  version: '0.0.0',
  displayName: 'ElevenLabs Voice',
  engines: { happier: '^0.0.0' },
  activationEvents: [],
  uses: [],
  entrypoints: { main: './dist/index.js' },
  permissions: { required: [], optional: [] },
  contributes: {},
});
