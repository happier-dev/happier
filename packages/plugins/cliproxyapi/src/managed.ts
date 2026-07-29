import {
  MANAGED_PROVIDER_RUNTIME_ADAPTER,
} from './provider/managedRuntime.js';

export { MANAGED_PROVIDER_RUNTIME_ADAPTER };

export const MANAGED_PROVIDER_IMPLEMENTATION = Object.freeze({
  v: 1 as const,
  providerLocalId: 'cliproxyapi',
  facet: Object.freeze({
    managedEndpoint: Object.freeze({
      localService: Object.freeze({
        id: 'cliproxyapi-managed',
        launch: Object.freeze({
          kind: 'packaged-runtime-binary' as const,
          directorySegments: Object.freeze(['tools', 'unpacked']),
          executableBaseName: 'happier-cliproxyapi-managed',
          privateConfigPathFlag: '--config',
        }),
        launchMode: Object.freeze({
          kind: 'assignAndInject' as const,
          portPolicy: Object.freeze({ kind: 'allocated' as const }),
          environment: Object.freeze({
            inject: Object.freeze(['PORT', 'HOST']),
          }),
        }),
        hostPolicy: Object.freeze({
          kind: 'loopback' as const,
          host: '127.0.0.1',
        }),
        name: Object.freeze({
          strategy: 'fixed' as const,
          name: 'CLIProxyAPI managed gateway',
        }),
        healthCheck: Object.freeze({
          kind: 'http' as const,
          path: '/healthz',
        }),
        restart: Object.freeze({ kind: 'never' as const }),
        cleanup: Object.freeze({ staleAfterMs: 60_000 }),
      }),
      protocols: Object.freeze([
        'openai-chat',
        'openai-responses',
        'anthropic',
      ] as const),
    }),
    connectedAccounts: Object.freeze([Object.freeze({
      purpose: 'openai-upstream',
      service: Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      }),
      required: false,
      materializationKinds: Object.freeze(['httpHeaders'] as const),
    }), Object.freeze({
      purpose: 'anthropic-upstream',
      service: Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      }),
      required: false,
      materializationKinds: Object.freeze(['httpHeaders'] as const),
    })]),
    requestAuthUses: Object.freeze([Object.freeze({
      purpose: 'openai-upstream',
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        origin: 'https://chatgpt.com',
        headerNames: Object.freeze(['authorization', 'chatgpt-account-id']),
      }),
    }), Object.freeze({
      purpose: 'anthropic-upstream',
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        origin: 'https://api.anthropic.com',
        headerNames: Object.freeze(['authorization']),
      }),
    })]),
  }),
});
