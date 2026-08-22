import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

import {
  packedTargetedContributionProtocol,
  packedTargetedSetupResultSchema,
} from './protocol.js';

const CLIENT_ARTIFACT_ID = 'packed-client-runtime';
const CLIENT_MODULE = {
  artifactId: CLIENT_ARTIFACT_ID,
  modulePath: './clientRuntime',
  exportName: 'activate',
} as const;

const setupInputSchema = defineProtocolObject({
  requestedBy: defineProtocolString(),
}, { policy: 'closed' });
const clientActionResultSchema = defineProtocolObject({
  screen: defineProtocolString(),
  invocationSurface: defineProtocolString(),
}, { policy: 'closed' });
const clientActionInputSchema = defineProtocolObject({
  delayMs: defineProtocolNumber({ integer: true, minimum: 0, maximum: 60_000 }).optional(),
}, { policy: 'closed' });
const providerDescriptor = {
  providerId: 'github',
  ignoredByTargetParser: true,
};

const plugin = definePlugin({
  id: 'examples.packed-targeted-projection-contributor',
  version: '1.0.0',
  displayName: 'Packed Targeted Projection Contributor',
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
    setup: {
      title: 'Set up provider',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema: setupInputSchema,
      resultSchema: packedTargetedSetupResultSchema,
      run: async () => ({}),
    },
    'inspect-context': {
      title: 'Inspect packed provider context',
      description: 'Reads the current UI context on the invoking client.',
      surfaces: ['ui', 'voice'],
      execution: {
        target: 'client',
        client: CLIENT_MODULE,
        platforms: ['web', 'ios', 'android'],
      },
      inputSchema: clientActionInputSchema,
      resultSchema: clientActionResultSchema,
    },
    'inspect-web-only': {
      title: 'Inspect packed provider context on web',
      description: 'Reads the current UI context through the web client contribution.',
      surfaces: ['ui', 'voice'],
      execution: {
        target: 'client',
        client: CLIENT_MODULE,
        platforms: ['web'],
      },
      inputSchema: clientActionInputSchema,
      resultSchema: clientActionResultSchema,
    },
    'apply-local-effect': {
      title: 'Apply packed local change',
      description: 'Navigates the invoking client to a packed fixture detail location after confirmation.',
      surfaces: ['ui'],
      dangerLevel: 'writesLocal',
      confirmation: {
        title: 'Apply packed local change?',
        body: 'This navigates only the invoking client within the packed fixture.',
        confirmLabel: 'Apply change',
      },
      execution: {
        target: 'client',
        client: CLIENT_MODULE,
        platforms: ['web', 'ios', 'android'],
      },
      inputSchema: clientActionInputSchema,
      resultSchema: clientActionResultSchema,
    },
  },
  voiceProviders: {
    'packed-conversation': {
      declaration: {
        title: 'Packed targeted conversation',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web', 'ios', 'android'],
        capabilities: {
          turn: { cancelResponse: false, bargeIn: false },
          tools: { effectCalls: 'stable_ids' },
        },
        client: CLIENT_MODULE,
      },
    },
  },
  ui: {
    views: [{
      id: 'packed-provider-page',
      container: 'appPage',
      target: { kind: 'app' },
      renderer: 'provider-detail',
      title: 'Packed targeted provider',
    }],
    renderers: [{
      id: 'provider-detail',
      kind: 'reactNative',
      artifact: 'provider-detail',
      requiredHostMethods: ['executeAction', 'publishCurrentUiContext'],
    }],
    translations: [],
  },
  contributesTo: {
    'examples.packed-targeted-projection-target': {
      providers: {
        github: packedTargetedContributionProtocol.contribute({
          descriptor: providerDescriptor,
          operations: {
            setup: packedTargetedContributionProtocol.operations.setup.bind('setup'),
          },
          surfaces: {
            detail: { renderer: 'provider-detail' },
          },
        }),
      },
    },
  },
});

export const { manifest, activate } = plugin;
