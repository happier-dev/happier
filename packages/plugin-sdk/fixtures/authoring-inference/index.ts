import { definePlugin, type PluginAgentDefinition } from '../../src/definePlugin.js';
import {
  defineProtocolObject,
  defineProtocolString,
} from '../../src/protocol/index.js';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';

import { promptAssetAdapter } from './promptAsset.js';

const executionRuntime: AgentRuntimeFactory = () => Object.freeze({
  executionRuns: Object.freeze({
    async open() {
      throw new Error('Fixture does not execute the Agent runtime');
    },
  }),
});

const inputSchema = defineProtocolObject({
  text: defineProtocolString(),
}, { policy: 'closed' });
const resultSchema = defineProtocolObject({
  echoed: defineProtocolString(),
}, { policy: 'closed' });

export const voiceRuntime = Object.freeze({
  kind: 'speech',
  async synthesize(request) {
    return {
      requestId: request.requestId,
      bytes: new Uint8Array(),
      mimeType: 'audio/wav' as const,
    };
  },
} satisfies SpeechProviderRuntime);

export const { manifest, activate } = definePlugin({
  id: 'example.inference',
  version: '0.1.0',
  actions: {
    echo: {
      title: 'Echo',
      inputSchema,
      resultSchema,
      run: async (input) => ({ echoed: input.text }),
    },
  },
  commands: {
    'echo-command': { title: 'Echo', path: ['echo'], action: 'echo' },
  },
  resources: {
    readme: { kind: 'asset', path: 'README.md', contentType: 'text/markdown' },
  },
  agents: {
    reviewer: {
      declaration: {
        title: 'Reviewer',
        runtime: { kind: 'custom' },
        primary: 'executionRuns',
        capabilities: {
          executionRuns: { open: ['create'], checkpoint: false, stop: true },
        },
      },
      factory: executionRuntime,
    },
  },
  promptAssets: {
    'external-skills': {
      declaration: {
        kind: 'context',
        resource: 'readme',
        target: { kind: 'agent', agent: 'reviewer' },
      },
      adapter: promptAssetAdapter satisfies PromptAssetAdapter,
    },
  },
  voiceProviders: {
    speech: {
      declaration: {
        title: 'Fixture speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web'],
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'voiceName',
            title: 'Voice',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'voice-a',
            presentation: { control: 'text' },
          }],
        },
      },
      runtime: voiceRuntime,
    },
  },
  ui: {
    renderers: [{
      id: 'summary-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'Summary' },
    }],
    views: [{
      id: 'summary-view',
      container: 'detailsTab',
      target: { kind: 'session' },
      renderer: 'summary-renderer',
      title: 'Summary',
    }],
    translations: [],
  },
  openableContentViewers: {
    'markdown-viewer': {
      destination: 'summary-view',
      contentClasses: ['text'],
      mimeTypes: ['text/markdown'],
      extensions: ['.md'],
    },
  },
  events: {
    changed: { declaration: { kind: 'event', title: 'Changed' } },
    watch: {
      declaration: { kind: 'subscription', target: { kind: 'plugin', event: 'changed' } },
      handler: async () => undefined,
    },
  },
  setup() {
    return () => undefined;
  },
});

if (false) {
  // @ts-expect-error Custom Agent authoring requires its runtime factory leaf.
  const missingAgentFactory: PluginAgentDefinition = {
    declaration: {
      title: 'Reviewer',
      runtime: { kind: 'custom' },
      primary: 'executionRuns',
      capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
    },
  };
  void missingAgentFactory;

  const acpWithoutTransport: PluginAgentDefinition = {
    // @ts-expect-error ACP Agent declarations require their transport.
    declaration: {
      title: 'ACP Agent',
      runtime: { kind: 'acp' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
    },
  };
  void acpWithoutTransport;

  const customWithoutTitle: PluginAgentDefinition = {
    // @ts-expect-error Custom Agent declarations require a title.
    declaration: {
      runtime: { kind: 'custom' },
      primary: 'executionRuns',
      capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
    },
    factory: executionRuntime,
  };
  void customWithoutTitle;

  const customWithoutPrimary: PluginAgentDefinition = {
    // @ts-expect-error Custom Agent declarations require their primary facet.
    declaration: {
      title: 'Custom Agent',
      runtime: { kind: 'custom' },
      capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
    },
    factory: executionRuntime,
  };
  void customWithoutPrimary;

  const mismatchedPrimaryCapability: PluginAgentDefinition = {
    // @ts-expect-error The sessions primary requires the matching sessions capability.
    declaration: {
      title: 'Mismatched Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
    },
    factory: executionRuntime,
  };
  void mismatchedPrimaryCapability;

  const misspelledCliMetadata: PluginAgentDefinition = {
    declaration: {
      title: 'CLI Agent',
      runtime: { kind: 'custom' },
      primary: 'executionRuns',
      capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
      cli: {
        // @ts-expect-error Agent CLI metadata rejects misspelled fields.
        exeutable: {},
      },
    },
    factory: executionRuntime,
  };
  void misspelledCliMetadata;

  const misspelledProviderRequirements: PluginAgentDefinition = {
    declaration: {
      title: 'Provider Agent',
      runtime: { kind: 'custom' },
      primary: 'executionRuns',
      capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
      providerRequirements: {
        // @ts-expect-error Agent provider requirements reject misspelled fields.
        acceptsProtcols: ['openai-responses'],
        required: {},
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
        materialization: 'spawnEnv',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
    },
    factory: executionRuntime,
  };
  void misspelledProviderRequirements;

  definePlugin({
    id: 'example.inference.invalid',
    version: '0.1.0',
    events: {
      // @ts-expect-error Subscription declarations require their handler leaf.
      invalid: {
        declaration: { kind: 'subscription', target: { kind: 'plugin', event: 'changed' } },
      },
    },
  });

  definePlugin({
    id: 'example.inference.invalid-action-result',
    version: '0.1.0',
    actions: {
      invalid: {
        title: 'Invalid',
        inputSchema,
        resultSchema,
        // @ts-expect-error The result schema requires a string.
        run: async (input) => ({ echoed: input.text.length }),
      },
    },
  });

  definePlugin({
    id: 'example.inference.invalid-action-input',
    version: '0.1.0',
    actions: {
      invalid: {
        title: 'Invalid',
        inputSchema,
        // @ts-expect-error The input schema supplies text, not a numeric count.
        run: async (input: { count: number }) => ({ count: input.count }),
      },
    },
  });

  definePlugin({
    id: 'example.inference.invalid-descriptor-runtime',
    version: '0.1.0',
    resources: {
      invalid: {
        kind: 'asset',
        path: 'README.md',
        contentType: 'text/markdown',
        // @ts-expect-error Descriptor-only families reject runtime material.
        runtime: {},
      },
    },
  });

  definePlugin({
    id: 'example.inference.invalid-generated-output',
    version: '0.1.0',
    // @ts-expect-error Host-generated projection output is not author input.
    generated: { uiArtifacts: [] },
  });

  definePlugin({
    id: 'example.inference.invalid-app-whole-pane-bindings',
    version: '0.1.0',
    ui: {
      renderers: [{
        id: 'retained-renderer',
        kind: 'declarative',
        root: { kind: 'text', text: 'Retained' },
      }],
      views: [
        // @ts-expect-error rightPane has no App target binding.
        {
          id: 'unsupported-app-right-pane',
          container: 'rightPane',
          target: { kind: 'app' },
          renderer: 'retained-renderer',
        },
        // @ts-expect-error detailsPane has no App target binding.
        {
          id: 'unsupported-app-details-pane',
          container: 'detailsPane',
          target: { kind: 'app' },
          renderer: 'retained-renderer',
        },
        // @ts-expect-error bottomPane has no App target binding.
        {
          id: 'unsupported-app-bottom-pane',
          container: 'bottomPane',
          target: { kind: 'app' },
          renderer: 'retained-renderer',
        },
      ],
    },
  });

}
