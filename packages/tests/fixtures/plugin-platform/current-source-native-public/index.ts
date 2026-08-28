import {
  defineComposerAttachment,
  defineComposerControl,
  defineComposerReference,
  defineComposerRegion,
  definePlugin,
} from '@happier-dev/plugin-sdk';
import { defineContributionPoint } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

import { qaProtocol } from './protocol.js';
import { QA_REVISION } from './revision.js';
import { createCurrentSourceQaAgentRuntime } from './agent/deterministicAgent.js';

const pluginId = 'qa.current-source.native-public';

export const { manifest, activate } = definePlugin({
  id: pluginId,
  version: QA_REVISION === 'v1' ? '0.0.1' : '0.0.2',
  entrypoints: { daemon: './dist/index.js' },
  agents: {
    'qa-agent': {
      declaration: {
        title: `${pluginId} deterministic QA`,
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        },
      },
      factory: createCurrentSourceQaAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/deterministicAgent.js',
        export: 'createCurrentSourceQaAgentRuntime',
        runtimeApiVersion: 1,
      },
    },
  },
  actions: {
    'qa-self-check': {
      title: 'Run current source self-check',
      description: 'Provides one observable public Action settlement in the loaded fixture.',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['plugin'],
      placementBindings: ['toolbar'],
      dangerLevel: 'safe',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      resultSchema: {
        type: 'object',
        properties: { revision: { type: 'string' } },
        required: ['revision'],
        additionalProperties: false,
      },
      async run() {
        // The delay belongs only to this QA producer: it makes the shared
        // Action owner's busy -> settled transition observable in Playwright
        // and in the native real-host journey within one assertion step.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        return { revision: QA_REVISION };
      },
    },
  },
  // One minimal dynamic Resource observed through the real host in browser
  // (RNW) and native alike: its bytes are exactly this generation's sentinel,
  // so the mounted surface can render only the revision it truly read back.
  resources: {
    'qa-resource': {
      source: 'dynamic',
      kind: 'config',
      scope: 'global',
      contentType: 'text/plain',
      maxBytes: 4_096,
      runtime: {
        read: () => `qa-current-source-resource-${QA_REVISION}`,
        // The bytes are generation-deterministic; a new generation replaces
        // this runtime wholesale, so there is nothing to invalidate in-place.
        observe: () => ({ dispose: () => undefined }),
      },
    },
  },
  contributionPoints: { sources: defineContributionPoint([qaProtocol]) },
  ui: {
    views: [{ id: 'native', container: 'appPage', target: { kind: 'app' }, renderer: 'qa-native', title: 'Current source native QA' },
      { id: 'hosted', container: 'appPage', target: { kind: 'app' }, renderer: 'qa-hosted', title: 'Current source hosted QA' },
      { id: 'declarative', container: 'appPage', target: { kind: 'app' }, renderer: 'qa-declarative', title: 'Current source declarative QA' }],
    renderers: [{ id: 'qa-native', kind: 'reactNative', artifact: 'qa-native', requiredHostMethods: ['context', 'executeAction', 'readResource', 'watchResource', 'readComposer', 'watchComposer'] },
      { id: 'qa-hosted', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'qa-hosted' }, requiredHostMethods: ['context'] },
      { id: 'qa-declarative', kind: 'declarative', root: {
        kind: 'group',
        title: 'Current source declarative QA',
        children: [{ kind: 'text', text: `qa-current-source-declarative-${QA_REVISION}` }, {
          kind: 'actionPanel',
          children: [{
            kind: 'action',
            action: 'qa-self-check',
            label: 'Run current source self-check',
            variant: 'primary',
          }],
        }],
      } }],
    translations: [],
  },
  contributesTo: {
    [pluginId]: {
      sources: {
        'qa-source': qaProtocol.contribute({
          descriptor: { label: `Current source ${QA_REVISION}` },
          operations: {},
          surfaces: { detail: { renderer: 'qa-native' } },
        }),
      },
    },
  },
  composer: {
    attachments: {
    'qa-item': defineComposerAttachment({
      title: 'Current source QA item',
      icon: 'action',
      cardinality: 'many',
      value: defineProtocolObject({ qaId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
      display: { kind: 'badge' },
      runtime: {
        prepareForSend: async ({ attachments }) => ({
          attachments: attachments.map(({ instanceId, value, content }) => ({
            instanceId,
            status: 'ready' as const,
            value,
            ...(content === undefined ? {} : { content }),
          })),
        }),
        resolveForDispatch: async ({ attachments }) => ({
          attachments: attachments.map(({ instanceId, value }) => ({
            instanceId,
            status: 'ready' as const,
            context: 'Current source native QA attachment context.',
            data: value,
          })),
        }),
        afterMessageAccepted: async () => undefined,
      },
    }),
    },
    references: {
    'qa-references': defineComposerReference({
      title: 'Current source QA references', icon: 'search', triggers: ['@'],
      search: async () => [{ id: 'qa:1', label: 'Current source QA reference' }],
      resolve: async (id) => ({ id, label: 'Current source QA reference', context: 'Current source native QA reference context.' }),
    }),
    },
    controls: {
    'qa-control': defineComposerControl({
      label: 'Current source QA',
      icon: 'action',
      scopes: ['session', 'newSession', 'pendingMessage'],
      interaction: {
        kind: 'choices', selection: 'single', options: [{
          id: 'attach', label: 'Attach Current source QA facts',
          effect: { kind: 'composerApply', operations: [{ kind: 'text.set', text: '@qa-ref' }, {
            // The qualified Composer reference payload: only this spelling is
            // resolved by the daemon's send-time reference resolver and
            // rendered into the Agent-visible context entry the fixture Agent
            // validates.
            kind: 'reference.insert',
            reference: {
              kind: 'happier.composerReference',
              ref: 'composerReference:qa:1',
              token: '@qa-ref',
              label: 'Current source QA reference',
              start: 0,
              end: 7,
              composerReference: { pluginId, localId: 'qa-references' },
            },
          }, {
            kind: 'attachment.add', attachmentLocalId: 'qa-item', value: {
              key: `qa-${QA_REVISION}`, value: { qaId: QA_REVISION },
              presentation: { label: `Current source QA attachment ${QA_REVISION}`, description: 'Immutable transcript fallback proof.' },
            },
          }] },
        }],
      },
    }),
    'qa-secondary-control': defineComposerControl({
      label: 'Current source secondary QA',
      icon: 'more',
      scopes: ['session', 'newSession', 'pendingMessage'],
      interaction: {
        kind: 'choices',
        selection: 'single',
        options: [{
          id: 'keep',
          label: 'Keep current QA facts',
          effect: { kind: 'composerApply', operations: [{ kind: 'text.set', text: '' }] },
        }],
      },
    }),
    },
    regions: {
    'qa-region': defineComposerRegion({ placement: 'beforeComposer', renderer: { renderer: 'qa-native' }, scopes: ['session', 'newSession', 'pendingMessage'] }),
    },
  },
});
