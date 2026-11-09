import { definePlugin } from '@happier-dev/plugin-sdk';

export const FIXTURE_PLUGIN_ID = 'qa.finish-e-cli-secret-configuration';
export const FIXTURE_SERVICE_ID = 'fixture';
export const FIXTURE_MODE_ID = 'fixture';
export const FIXTURE_PURPOSE = 'e6-configuration';

const runtime = {
  authentication: { modes: { fixture: {
    kind: 'manual',
    async complete(input, context, options) {
      if (input.fields.label !== 'E6 disposable fixture') {
        return { status: 'rejected', diagnostic: {
          code: 'qa/fixture-label-required', severity: 'error',
          message: 'Use the disposable fixture label.',
        } };
      }
      await context.attemptCredentials.set('fixture-label', input.fields.label, options);
      return { status: 'connected', displayName: 'FINISH-E-CLI disposable fixture', scopes: [] };
    },
  } } },
  async status() { return { status: 'connected', displayName: 'FINISH-E-CLI disposable fixture' }; },
  async refresh() { return { status: 'connected', displayName: 'FINISH-E-CLI disposable fixture' }; },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize() { throw new Error('qa_fixture_has_no_materialization'); },
};

const plugin = definePlugin({
  id: FIXTURE_PLUGIN_ID,
  version: '1.0.0',
  displayName: 'FINISH-E-CLI Secret configuration fixture',
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './src/index.mjs' },
  activation: { events: [{ kind: 'startup' }] },
  hostAccess: { required: [{
    id: FIXTURE_PURPOSE,
    capability: 'connectedAccounts',
    reason: 'Exercise a disposable connection configuration without reading credential values.',
    scope: { serviceRefs: [FIXTURE_SERVICE_ID], operations: ['use'] },
  }], optional: [] },
  connectedAccountDescriptors: { fixture: {
    declaration: {
      title: 'FINISH-E-CLI disposable configuration',
      description: 'QA only. No network, real login, or credential materialization.',
      authentication: { defaultModeId: FIXTURE_MODE_ID, modes: [{
        id: FIXTURE_MODE_ID, kind: 'manual', title: 'Disposable fixture', outcomeReconciliation: 'none',
        fields: [{ id: 'label', title: 'Fixture label', schema: { type: 'string', minLength: 1 } }],
        configuration: {
          scope: 'service', changeBehavior: 'refresh',
          fields: [{ id: 'dummy-secret', title: 'E6 dummy Secret',
            description: 'Select a disposable Saved Secret. The fixture never reads its value.',
            schema: { type: 'string', minLength: 1 }, secret: true, required: false }],
        },
      }] },
    },
    runtime,
  } },
  actions: { 'fixture/inspect': {
    title: 'Inspect E6 fixture identity',
    description: 'Return fixed QA identities only; never acquire or expose credential values.',
    scopes: ['global'], surfaces: ['cli', 'ui', 'agent'], execution: { target: 'daemon' },
    dangerLevel: 'safe', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resultSchema: { type: 'object', properties: {
      pluginId: { type: 'string' }, serviceId: { type: 'string' }, modeId: { type: 'string' }, purpose: { type: 'string' },
    }, required: ['pluginId', 'serviceId', 'modeId', 'purpose'], additionalProperties: false },
    async run() { return { pluginId: FIXTURE_PLUGIN_ID, serviceId: FIXTURE_SERVICE_ID,
      modeId: FIXTURE_MODE_ID, purpose: FIXTURE_PURPOSE }; },
  } },
});

export const manifest = plugin.manifest;
export const activate = plugin.activate;
