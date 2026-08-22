import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  MessageActionAvailableSnapshotV1,
  PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';

import type { PluginManifest } from '../manifest.js';
import type { JsonValue } from '../identity.js';
import type { HttpMethod } from '../http.js';
import type {
  AdmittedTargetedOperationExecutionHandle,
} from '../actions/service.js';
import { isPluginActionHandlerInvocationKnownNotStarted } from '../actions/index.js';
import { definePlugin } from '../definePlugin.js';
import type { PresentationService } from '../interactions.js';
import type {
  PluginApi,
  PluginEventHandler,
  PluginMcpDiscoveryHandler,
  PluginMcpServerRuntime,
} from '../activation.js';
import type { AgentRuntimeFactory } from '../agentRuntime/index.js';
import type { PluginLoggerService } from '../services/index.js';
import type {
  TargetedContributionObservation,
  TargetedContributionPointRef,
  TargetedContributionsService,
} from '../services/targetedContributions.js';
import { createPluginTestkit } from './host.js';
import type { PluginRuntimeRegistration } from '../host/registration/index.js';
import type {
  PluginTestkit,
  PluginTestkitOptions,
  PluginTestkitRegistrationByFamily,
} from './types.js';
import type { ProvidersService } from '../providers.js';
import type { VoiceProviderRuntime } from '../voice/index.js';
import type {
  VoiceSpeechSynthesizeRequest,
  VoiceSpeechTranscribeRequest,
} from '../voice/speech.js';
import { isPluginError, PluginError } from '../errors.js';
import { defineContributionProtocol } from '../targetedContributionAuthoring.js';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '../protocol/protocolFacade.js';

const manifest = {
  schemaVersion: 2,
  id: 'acme.testkit',
  version: '1.0.0',
  displayName: 'Testkit Fixture',
  engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
  contributes: {
    actions: [{
      id: 'echo',
      title: 'Echo',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['cli'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
    }],
  },
} satisfies PluginManifest;

const agentManifest = {
  ...manifest,
  contributes: {
    agents: [{
      id: 'assistant',
      title: 'Assistant',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        surfaces: ['terminal'],
        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
      },
    }],
  },
} satisfies PluginManifest;

const agentWithExternalSessionsManifest = {
  ...agentManifest,
  contributes: {
    agents: [{
      ...agentManifest.contributes.agents[0],
      capabilities: {
        ...agentManifest.contributes.agents[0].capabilities,
        surfaces: ['terminal', 'externalSessions'],
      },
      surfaces: {
        externalSession: {
          sources: [{
            sourceKind: 'test',
            schema: {
              fields: [{ kind: 'literal', name: 'kind', value: 'test' }],
            },
            key: { segments: [{ kind: 'literal', value: 'test' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    }],
  },
} satisfies PluginManifest;

const mcpManifest = {
  ...manifest,
  contributes: {
    actions: manifest.contributes.actions,
    mcp: {
      servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }],
      discoverySources: [],
    },
  },
} satisfies PluginManifest;

function actionManifest(
  pluginId: string,
  actionId: string,
  surfaces: readonly ('cli' | 'plugin')[],
): PluginManifest {
  return {
    schemaVersion: 2,
    id: pluginId,
    version: '1.0.0',
    displayName: pluginId,
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    contributes: {
      actions: [{
        id: actionId,
      title: actionId,
      execution: { target: 'daemon' },
      scopes: ['global'],
        surfaces: [...surfaces],
        ...(surfaces.includes('cli') ? { placementBindings: ['commandPalette'] as const } : {}),
        dangerLevel: 'safe',
      }],
    },
  };
}

const testkitTargetedOperationInputSchema = defineProtocolObject({
  title: defineProtocolString(),
}, { policy: 'closed' });
const testkitTargetedOperationResultSchema = defineProtocolObject({
  accepted: defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
  ]),
}, { policy: 'closed' });
const testkitTargetedOperationProtocol = defineContributionProtocol({
  id: 'acme.testkit/providers',
  version: 1,
  operations: {
    publish: {
      required: true,
      input: { kind: 'protocolDefined', schema: testkitTargetedOperationInputSchema },
      resultSchema: testkitTargetedOperationResultSchema,
      action: { surface: 'plugin', dangerLevel: 'safe' },
    },
  },
});
const testkitTargetedTargetDefinition = definePlugin({
  id: 'acme.testkit.target',
  version: '1.0.0',
  contributionPoints: {
    providers: testkitTargetedOperationProtocol.point({ maxContributionsPerContributor: 1 }),
  },
  actions: {
    capture: {
      title: 'Capture provider',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['cli'],
      dangerLevel: 'safe',
      run: async () => null,
    },
    send: {
      title: 'Send provider request',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['cli'],
      dangerLevel: 'safe',
      run: async () => null,
    },
  },
});

type TestkitTargetedOperationHandle = AdmittedTargetedOperationExecutionHandle;
type TestkitTargetedOperationRef = { current: TestkitTargetedOperationHandle | undefined };
type TestkitTargetedObservationRef = {
  current: TargetedContributionObservation<unknown> | undefined;
};

function createTargetedOperationTargetModule(
  operation: TestkitTargetedOperationRef,
) {
  return {
    activate(api: PluginApi) {
      api.actions.register('capture', async (_input, context) => {
        const observation = context.services.targetedContributions.observeForSelf(
          testkitTargetedTargetDefinition.contributionPoints.providers,
          { onInvalidated: () => {} },
        );
        try {
          const snapshot = await observation.readCurrent({ signal: context.signal });
          operation.current = snapshot.contributions[0]?.operations.publish;
          return { count: snapshot.contributions.length, generation: snapshot.generation };
        } finally {
          observation.dispose();
        }
      });
      api.actions.register('send', async (_input, context) => {
        if (operation.current === undefined) {
          throw new Error('No current testkit targeted operation was captured.');
        }
        return (await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
          operation.current,
          { title: 'Ready' },
        )).result;
      });
    },
  };
}

function createTargetedObservationTargetModule(
  observation: TestkitTargetedObservationRef,
  onInvalidated: () => void,
) {
  return {
    activate(api: PluginApi) {
      api.actions.register('capture', async (_input, context) => {
        const current = context.services.targetedContributions.observeForSelf(
          testkitTargetedTargetDefinition.contributionPoints.providers,
          { onInvalidated },
        );
        observation.current = current;
        const snapshot = await current.readCurrent({ signal: context.signal });
        return { count: snapshot.contributions.length };
      });
      api.actions.register('send', () => null);
    },
  };
}

function defineTargetedOperationContributor(
  pluginId: string,
  actionId: string,
  contributionIds: readonly string[] = ['primary'],
) {
  return definePlugin({
    id: pluginId,
    version: '1.0.0',
    actions: {
      [actionId]: {
        title: actionId,
        execution: { target: 'daemon' },
        scopes: ['global'],
        surfaces: ['plugin'],
        inputSchema: testkitTargetedOperationInputSchema.jsonSchema,
        resultSchema: testkitTargetedOperationResultSchema.jsonSchema,
        dangerLevel: 'safe',
        run: async () => ({ accepted: true }),
      },
    },
    contributesTo: {
      'acme.testkit.target': {
        providers: Object.fromEntries(contributionIds.map((contributionId) => [
          contributionId,
          testkitTargetedOperationProtocol.contribute({
            operations: {
              publish: testkitTargetedOperationProtocol.operations.publish.bind(actionId),
            },
          }),
        ])),
      },
    },
  });
}

const voiceManifest = {
  ...manifest,
  contributes: {
    voiceProviders: [{
      id: 'speech',
      title: 'Speech',
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
    }],
  },
} satisfies PluginManifest;

function voiceRuntime(includeTranscribe = false): VoiceProviderRuntime {
  return {
    kind: 'speech',
    synthesize: async (request: VoiceSpeechSynthesizeRequest) => ({
      requestId: request.requestId,
      bytes: new Uint8Array(),
      mimeType: 'audio/wav',
    }),
    ...(includeTranscribe
      ? {
          transcribe: async (request: VoiceSpeechTranscribeRequest) => ({
            requestId: request.requestId,
            text: '',
          }),
        }
      : {}),
  };
}

function mcpRuntime(dispose: PluginMcpServerRuntime['dispose']): PluginMcpServerRuntime {
  return {
    async listTools() { return { items: [] }; },
    async callTool() { return { content: [] }; },
    async listResources() { return { items: [] }; },
    async listResourceTemplates() { return { items: [] }; },
    async readResource() { return { contents: [] }; },
    async subscribeResource() { return { dispose() {} }; },
    async listPrompts() { return { items: [] }; },
    async getPrompt() { return { messages: [] }; },
    dispose,
  };
}

const agentFactory: AgentRuntimeFactory = async () => ({
  sessions: {
    open: async () => { throw new Error('not invoked'); },
  },
});

const sessionRunnerFactory = Object.freeze({
  module: './agent/runtime.js',
  export: 'createSessionRunner',
  runtimeApiVersion: 1 as const,
});

type MissingPluginTestkitRegistrationFamily = {
  [TFamily in PluginRuntimeRegistration['family']]:
  PluginTestkit['registration'] extends (
    family: TFamily,
    localId: string,
  ) => Extract<PluginRuntimeRegistration, { family: TFamily }>['value'] | undefined
    ? never
    : TFamily;
}[PluginRuntimeRegistration['family']];

type UnexpectedPluginTestkitRegistrationFamily = Exclude<
  keyof PluginTestkitRegistrationByFamily,
  PluginRuntimeRegistration['family']
>;

function assertPublicRegistrationLookupTypes(testkit: PluginTestkit): void {
  const eventHandler = testkit.registration('events', 'watch-item');
  const mcpDiscoveryHandler = testkit.registration('mcp.discoverySources', 'catalog');
  const requestInterceptor = testkit.registration('requestInterceptors', 'api-policy');

  expectTypeOf(eventHandler).toEqualTypeOf<PluginEventHandler | undefined>();
  expectTypeOf(mcpDiscoveryHandler).toEqualTypeOf<PluginMcpDiscoveryHandler | undefined>();
  expectTypeOf(requestInterceptor).toEqualTypeOf<PluginApi['interceptors']['register'] extends (
    localId: string,
    interceptor: infer TInterceptor,
  ) => void ? TInterceptor | undefined : never>();
}

function readCanonicalTestkitActionResult(testkit: PluginTestkit): Promise<JsonValue | null> {
  return testkit.invokeAction('echo', null);
}

describe('createPluginTestkit', () => {
  it('rejects HostAccess capabilities that remain deferred from public authoring', async () => {
    const deferredRequests = [
      { capability: 'browser', scope: { operations: ['read'] } },
      { capability: 'clipboard', scope: { access: ['read'] } },
      { capability: 'externalLinks', scope: { origins: ['https://links.example.com'] } },
    ] as const;

    for (const request of deferredRequests) {
      const manifestWithDeferredAccess = {
        ...manifest,
        hostAccess: {
          required: [{ id: 'deferred-access', reason: 'Exercise the public boundary.', ...request }],
          optional: [],
        },
      } as unknown as PluginTestkitOptions['manifest'];
      await expect(createPluginTestkit({
        manifest: manifestWithDeferredAccess,
        module: { activate() {} },
      })).rejects.toThrow('deferred from public plugin authoring');
    }
  });

  it('records a declared request interceptor without simulating the canonical fetch-policy chain', async () => {
    const manifestWithRequestInterceptors = {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        requestInterceptors: [{
          id: 'api-policy',
          origins: ['https://intercept.example.com'],
          methods: ['GET'],
        }],
      },
    } as unknown as PluginTestkitOptions['manifest'];
    const interceptor = vi.fn(async (request: {
      url: string;
      method: HttpMethod;
      headers: Readonly<Record<string, string>>;
    }) => ({ decision: 'continue' as const, request }));

    const testkit = await createPluginTestkit({
      manifest: manifestWithRequestInterceptors,
      module: {
        activate(api) {
          api.actions.register('echo', async () => null);
          api.interceptors.register('api-policy', interceptor);
        },
      },
    });

    try {
      expect(testkit.registrations()).toContainEqual({
        family: 'requestInterceptors',
        localId: 'api-policy',
      });
      expect(testkit.registration('requestInterceptors', 'api-policy')).toBe(interceptor);
      expect(interceptor).not.toHaveBeenCalled();
    } finally {
      await testkit.dispose();
    }
  });

  it('normalizes a void handler result to the canonical validated null result', async () => {
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', () => undefined);
        },
      },
    });

    try {
      await expect(testkit.invokeAction('echo', null)).resolves.toBeNull();
      expectTypeOf(readCanonicalTestkitActionResult).returns.toEqualTypeOf<Promise<JsonValue | null>>();
    } finally {
      await testkit.dispose();
    }
  });

  it('rebuilds a direct action failure from its canonical published payload', async () => {
    const cause = new Error('credential secret');
    const original = new PluginError({
      code: 'fixture_provider_failed',
      message: 'provider credential is secret',
      retryable: true,
      details: { credential: 'secret' },
      remediation: {
        kind: 'openSettings',
        path: 'accounts/acme',
      },
      diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
    }, { cause });
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', () => {
            throw original;
          });
        },
      },
    });

    try {
      const received = await testkit.invokeAction('echo', null).catch((error: unknown) => error);

      expect(isPluginError(received)).toBe(true);
      if (!isPluginError(received)) {
        throw new Error('Expected a PluginError');
      }
      // The error is rebuilt from the canonical payload, never transported as
      // an object: identity and `cause` do not survive, the contract does.
      expect(received).not.toBe(original);
      expect(received).toMatchObject({
        code: 'fixture_provider_failed',
        message: 'provider credential is secret',
        retryable: true,
        details: { credential: 'secret' },
        remediation: { kind: 'openSettings', path: 'accounts/acme' },
        diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
      });
      expect(Object.hasOwn(received, 'cause')).toBe(false);
      expect(received.data).toEqual(original.data);
    } finally {
      await testkit.dispose();
    }
  });

  it('carries a target plugin canonical failure payload to its plugin caller', async () => {
    const cause = new Error('credential secret');
    const original = new PluginError({
      code: 'fixture_provider_failed',
      message: 'provider credential is secret',
      retryable: true,
      details: { credential: 'secret' },
      remediation: {
        kind: 'openSettings',
        path: 'accounts/acme',
      },
      diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
    }, { cause });
    const target = await createPluginTestkit({
      manifest: actionManifest('acme.target', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', () => {
            throw original;
          });
        },
      },
    });
    const caller = await createPluginTestkit({
      manifest: actionManifest('acme.caller', 'send', ['cli']),
      actionTargets: [target],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.target', localId: 'receive' },
            null,
          ));
        },
      },
    });

    try {
      const received = await caller.invokeAction('send', null).catch((error: unknown) => error);

      expect(isPluginError(received)).toBe(true);
      if (!isPluginError(received)) {
        throw new Error('Expected a PluginError');
      }
      // Plugins are trusted code: the target's own code, retryable signal and
      // published payload reach the calling plugin.
      expect(received).not.toBe(original);
      expect(received).toMatchObject({
        code: 'fixture_provider_failed',
        message: 'provider credential is secret',
        retryable: true,
        details: { credential: 'secret' },
        remediation: { kind: 'openSettings', path: 'accounts/acme' },
        diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
      });
      expect(Object.hasOwn(received, 'cause')).toBe(false);
      expect(received.data).toEqual(original.data);
    } finally {
      await caller.dispose();
      await target.dispose();
    }
  });

  it('uses the host-owned current materialization resolver to stamp each immediate caller through nested contributed Actions', async () => {
    const gamma = await createPluginTestkit({
      manifest: actionManifest('acme.gamma', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', async (_input, context) => {
            if (context.caller?.kind !== 'plugin') {
              throw new Error('Expected a host-stamped plugin caller');
            }
            return {
              surface: context.surface,
              callerPluginId: context.caller.pluginId,
              callerContribution: context.caller.contribution.qualifiedId,
              callerMaterialization: context.caller.materialization,
            };
          });
        },
      },
    });
    const betaOptions: PluginTestkitOptions = {
      manifest: actionManifest('acme.beta', 'relay', ['plugin']),
      actionTargets: [gamma],
      module: {
        activate(api) {
          api.actions.register('relay', async (_input, context) => {
            if (context.caller?.kind !== 'plugin') {
              throw new Error('Expected a host-stamped plugin caller');
            }
            const caller = context.caller;
            const gamma = await context.services.actions.execute(
              { pluginId: 'acme.gamma', localId: 'receive' },
              { upstreamCaller: caller.pluginId },
            );
            return {
              // Contributed Actions return strict JSON, so retain the caller
              // proof as a JSON projection rather than returning its runtime
              // invocation object directly.
              caller: {
                kind: caller.kind,
                pluginId: caller.pluginId,
                contribution: {
                  id: caller.contribution.id,
                  qualifiedId: caller.contribution.qualifiedId,
                },
                materialization: {
                  pluginId: caller.materialization.pluginId,
                  machineId: caller.materialization.machineId,
                  materializationId: caller.materialization.materializationId,
                },
                ...(caller.originSurface === undefined ? {} : { originSurface: caller.originSurface }),
              },
              // The canonical contributed-Action owner represents a successful
              // void handler result as JSON null.
              gamma: gamma === undefined ? null : gamma,
            };
          });
        },
      },
    };
    const beta = await createPluginTestkit(betaOptions);
    let alphaMaterialization: PluginMachineMaterializationRefV1 = Object.freeze({
      pluginId: 'acme.alpha',
      machineId: 'machine-alpha',
      materializationId: 'materialization-alpha-current',
    });
    const resolveAlphaMaterialization = vi.fn(() => alphaMaterialization);
    const alphaOptions: PluginTestkitOptions = {
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      resolveCurrentPluginMaterializationRef: resolveAlphaMaterialization,
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.beta', localId: 'relay' },
            null,
          ));
        },
      },
    };
    const alpha = await createPluginTestkit(alphaOptions);

    try {
      await expect(alpha.invokeAction('send', null)).resolves.toEqual({
        caller: {
          kind: 'plugin',
          pluginId: 'acme.alpha',
          contribution: {
            id: 'send',
            qualifiedId: 'acme.alpha/actions/send',
          },
          materialization: alphaMaterialization,
          originSurface: 'cli',
        },
        gamma: {
          surface: 'plugin',
          callerPluginId: 'acme.beta',
          callerContribution: 'acme.beta/actions/relay',
          callerMaterialization: {
            pluginId: 'acme.beta',
            machineId: 'plugin-testkit-machine',
            materializationId: 'plugin-testkit-acme.beta',
          },
        },
      });
      alphaMaterialization = Object.freeze({
        pluginId: 'acme.alpha',
        machineId: 'machine-alpha',
        materializationId: 'materialization-alpha-replacement',
      });
      await expect(alpha.invokeAction('send', null)).resolves.toMatchObject({
        caller: {
          materialization: alphaMaterialization,
        },
      });
    } finally {
      await alpha.dispose();
      await beta.dispose();
      await gamma.dispose();
    }
  });

  it('withholds a contributed Action result when the host-stamped caller materialization changes while it runs', async () => {
    let alphaMaterialization: PluginMachineMaterializationRefV1 = Object.freeze({
      pluginId: 'acme.alpha',
      machineId: 'machine-alpha',
      materializationId: 'materialization-alpha-before',
    });
    const targetHandler = vi.fn(async () => {
      alphaMaterialization = Object.freeze({
        pluginId: 'acme.alpha',
        machineId: 'machine-alpha',
        materializationId: 'materialization-alpha-after',
      });
      return { accepted: true };
    });
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alpha = await createPluginTestkit({
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      resolveCurrentPluginMaterializationRef: () => alphaMaterialization,
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.beta', localId: 'receive' },
            null,
          ));
        },
      },
    });

    try {
      await expect(alpha.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_action_caller_unavailable',
      });
      expect(targetHandler).toHaveBeenCalledOnce();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('returns a host-stamped exact target execution origin through the contributed-Action testkit path', async () => {
    const targetHandler = vi.fn(async () => ({ accepted: true }));
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alpha = await createPluginTestkit({
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      resolveCurrentPluginMaterializationRef: () => Object.freeze({
        pluginId: 'acme.alpha',
        machineId: 'machine-alpha',
        materializationId: 'materialization-alpha-current',
      }),
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.executeWithExecutionOrigin(
            { pluginId: 'acme.beta', localId: 'receive' },
            { title: 'Ready' },
          ));
        },
      },
    });

    try {
      await expect(alpha.invokeAction('send', null)).resolves.toEqual({
        result: { accepted: true },
        executionOrigin: {
          serverIdentityId: 'srv_plugin_testkit',
          materializationRef: {
            pluginId: 'acme.beta',
            machineId: 'plugin-testkit-machine',
            materializationId: 'plugin-testkit-acme.beta',
          },
        },
      });
      expect(targetHandler).toHaveBeenCalledOnce();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('derives a fixture-only targeted snapshot from declared contributors and preserves generation currentness', async () => {
    const handlerG = vi.fn(async () => ({ accepted: true }));
    const betaGDefinition = defineTargetedOperationContributor(
      'acme.testkit.contributor',
      'publish-provider',
    );
    const betaG = await createPluginTestkit({
      manifest: betaGDefinition.manifest,
      module: {
        activate(api) {
          api.actions.register('publish-provider', handlerG);
        },
      },
    });
    const operationG: TestkitTargetedOperationRef = { current: undefined };
    const alphaG = await createPluginTestkit({
      manifest: testkitTargetedTargetDefinition.manifest,
      targetedContributionContributors: [betaG],
      module: createTargetedOperationTargetModule(operationG),
    });

    try {
      const fixtureG = alphaG.readTargetedContributionFixture(
        testkitTargetedTargetDefinition.contributionPoints.providers,
      );
      expect(fixtureG.contributions).toHaveLength(1);
      expect(fixtureG.contributions[0]).toMatchObject({
        contributor: {
          pluginId: 'acme.testkit.contributor',
          contributionId: 'primary',
        },
        protocol: { id: 'acme.testkit/providers', version: 1 },
      });
      const issuedG = alphaG.issueAdmittedTargetedOperation({
        point: testkitTargetedTargetDefinition.contributionPoints.providers,
        contributor: {
          testkit: betaG,
          contributionId: 'primary',
        },
        role: 'publish',
      });
      expect(Object.getOwnPropertyNames(issuedG)).toEqual(['identity']);
      expect(Object.getOwnPropertySymbols(issuedG)).toEqual([]);
      expect(issuedG.identity).toMatchObject({
        target: { pluginId: 'acme.testkit.target' },
        point: {
          pointId: 'providers',
          protocol: { id: 'acme.testkit/providers', version: 1 },
        },
        contributor: {
          pluginId: 'acme.testkit.contributor',
          contributionId: 'primary',
        },
        role: 'publish',
      });

      await expect(alphaG.invokeAction('capture', null)).resolves.toMatchObject({ count: 1 });
      const original = operationG.current;
      expect(original).toBeDefined();
      operationG.current = issuedG;
      await expect(alphaG.invokeAction('send', null)).resolves.toEqual({ accepted: true });
      expect(handlerG).toHaveBeenCalledOnce();

      operationG.current = Object.freeze({ ...original }) as typeof original;
      await expect(alphaG.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_admitted_targeted_operation_handle_invalid',
      });
      operationG.current = Object.freeze({
        identity: Object.freeze({
          target: Object.freeze({ ...original!.identity.target }),
          point: Object.freeze({
            pointId: original!.identity.point.pointId,
            protocol: Object.freeze({ ...original!.identity.point.protocol }),
          }),
          contributor: Object.freeze({ ...original!.identity.contributor }),
          role: original!.identity.role,
        }),
      }) as NonNullable<typeof original>;
      await expect(alphaG.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_admitted_targeted_operation_handle_invalid',
      });
      expect(handlerG).toHaveBeenCalledOnce();

      await betaG.dispose();
      expect(alphaG.readTargetedContributionFixture(
        testkitTargetedTargetDefinition.contributionPoints.providers,
      ).contributions).toEqual([]);
      operationG.current = original;
      await expect(alphaG.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_action_generation_retired',
      });

      const handlerH = vi.fn(async () => ({ accepted: true }));
      const betaHDefinition = defineTargetedOperationContributor(
        'acme.testkit.contributor',
        'publish-provider',
      );
      const betaH = await createPluginTestkit({
        manifest: betaHDefinition.manifest,
        module: {
          activate(api) {
            api.actions.register('publish-provider', handlerH);
          },
        },
      });
      const operationH: TestkitTargetedOperationRef = { current: undefined };
      const alphaH = await createPluginTestkit({
        manifest: testkitTargetedTargetDefinition.manifest,
        targetedContributionContributors: [betaH],
        module: createTargetedOperationTargetModule(operationH),
      });
      try {
        await expect(alphaH.invokeAction('capture', null)).resolves.toMatchObject({ count: 1 });
        const freshH = operationH.current;
        expect(freshH).toBeDefined();
        expect(freshH!.identity.contributor.immutableGenerationId)
          .not.toBe(original!.identity.contributor.immutableGenerationId);

        operationH.current = original;
        await expect(alphaH.invokeAction('send', null)).rejects.toMatchObject({
          code: 'plugin_action_generation_retired',
        });
        expect(handlerH).not.toHaveBeenCalled();

        operationH.current = freshH;
        await expect(alphaH.invokeAction('send', null)).resolves.toEqual({ accepted: true });
        expect(handlerH).toHaveBeenCalledOnce();
      } finally {
        await alphaH.dispose();
        await betaH.dispose();
      }
    } finally {
      await alphaG.dispose();
      await betaG.dispose();
    }
  });

  it('refuses an original admitted handle after only its target generation is replaced', async () => {
    const targetHandler = vi.fn(async () => ({ accepted: true }));
    const contributorDefinition = defineTargetedOperationContributor(
      'acme.testkit.target-currentness-contributor',
      'publish-provider',
    );
    const contributor = await createPluginTestkit({
      manifest: contributorDefinition.manifest,
      module: {
        activate(api) {
          api.actions.register('publish-provider', targetHandler);
        },
      },
    });
    const operationG: TestkitTargetedOperationRef = { current: undefined };
    const targetG = await createPluginTestkit({
      manifest: testkitTargetedTargetDefinition.manifest,
      targetedContributionContributors: [contributor],
      module: createTargetedOperationTargetModule(operationG),
    });

    let original: TestkitTargetedOperationHandle | undefined;
    try {
      await expect(targetG.invokeAction('capture', null)).resolves.toMatchObject({ count: 1 });
      if (operationG.current === undefined) {
        throw new Error('Expected target generation G to capture its admitted operation.');
      }
      original = operationG.current;
    } finally {
      await targetG.dispose();
    }
    if (original === undefined) {
      throw new Error('Expected target generation G to retain its admitted operation.');
    }

    const operationH: TestkitTargetedOperationRef = { current: undefined };
    const targetH = await createPluginTestkit({
      manifest: testkitTargetedTargetDefinition.manifest,
      targetedContributionContributors: [contributor],
      module: createTargetedOperationTargetModule(operationH),
    });

    try {
      await expect(targetH.invokeAction('capture', null)).resolves.toMatchObject({ count: 1 });
      const fresh = operationH.current;
      if (fresh === undefined) {
        throw new Error('Expected target generation H to capture its admitted operation.');
      }

      operationH.current = original;
      await expect(targetH.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_action_generation_retired',
      });
      expect(targetHandler).not.toHaveBeenCalled();

      operationH.current = fresh;
      await expect(targetH.invokeAction('send', null)).resolves.toEqual({ accepted: true });
      expect(targetHandler).toHaveBeenCalledOnce();
    } finally {
      await targetH.dispose();
      await contributor.dispose();
    }
  });

  it('invalidates a fixture observation when its configured contributor retires', async () => {
    const contributorDefinition = defineTargetedOperationContributor(
      'acme.testkit.fixture-observer',
      'publish-provider',
    );
    const contributor = await createPluginTestkit({
      manifest: contributorDefinition.manifest,
      module: {
        activate(api) {
          api.actions.register('publish-provider', async () => ({ accepted: true }));
        },
      },
    });
    const observation: TestkitTargetedObservationRef = { current: undefined };
    const onInvalidated = vi.fn();
    const target = await createPluginTestkit({
      manifest: testkitTargetedTargetDefinition.manifest,
      targetedContributionContributors: [contributor],
      module: createTargetedObservationTargetModule(observation, onInvalidated),
    });

    try {
      await expect(target.invokeAction('capture', null)).resolves.toEqual({ count: 1 });
      expect(observation.current).toBeDefined();

      await contributor.dispose();

      await vi.waitFor(() => expect(onInvalidated).toHaveBeenCalledOnce());
      await expect(observation.current!.readCurrent()).resolves.toMatchObject({ contributions: [] });
    } finally {
      observation.current?.dispose();
      await target.dispose();
      await contributor.dispose();
    }
  });

  it('refuses an admitted targeted-operation shape instead of falling back to a generic Action ref', async () => {
    const targetHandler = vi.fn(async () => ({ accepted: true }));
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alpha = await createPluginTestkit({
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => {
            try {
              await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin({
                identity: {
                  target: { pluginId: 'acme.target' },
                  point: { pointId: 'providers', protocol: { id: 'acme.providers', version: 1 } },
                  contributor: {
                    pluginId: 'acme.contributor',
                    contributionId: 'primary',
                    immutableGenerationId: 'contributor-generation-g',
                  },
                  role: 'publish',
                },
              } as never, null);
            } catch (error) {
              return { targetHandlerNotStarted: isPluginActionHandlerInvocationKnownNotStarted(error) };
            }
            return { targetHandlerNotStarted: false };
          });
        },
      },
    });

    try {
      await expect(alpha.invokeAction('send', null)).resolves.toEqual({
        targetHandlerNotStarted: true,
      });
      expect(targetHandler).not.toHaveBeenCalled();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('rejects a mismatched expected target execution origin before the testkit target handler', async () => {
    const targetHandler = vi.fn(async () => ({ accepted: true }));
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alpha = await createPluginTestkit({
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => {
            try {
              await context.services.actions.executeWithExecutionOrigin(
                { pluginId: 'acme.beta', localId: 'receive' },
                { title: 'Ready' },
                {
                  expectedExecutionOrigin: {
                    serverIdentityId: 'srv_plugin_testkit',
                    materializationRef: {
                      pluginId: 'acme.beta',
                      machineId: 'plugin-testkit-machine',
                      materializationId: 'plugin-testkit-acme.beta-before',
                    },
                  },
                },
              );
            } catch (error) {
              return { targetHandlerNotStarted: isPluginActionHandlerInvocationKnownNotStarted(error) };
            }
            return { targetHandlerNotStarted: false };
          });
        },
      },
    });

    try {
      await expect(alpha.invokeAction('send', null)).resolves.toEqual({
        targetHandlerNotStarted: true,
      });
      expect(targetHandler).not.toHaveBeenCalled();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('fails closed rather than replacing an unavailable target execution origin with a synthetic fallback', async () => {
    const targetHandler = vi.fn(async () => ({ accepted: true }));
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      resolveCurrentPluginMaterializationRef: () => null,
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alpha = await createPluginTestkit({
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.executeWithExecutionOrigin(
            { pluginId: 'acme.beta', localId: 'receive' },
            { title: 'Ready' },
          ));
        },
      },
    });

    try {
      await expect(alpha.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_action_execution_origin_unavailable',
      });
      expect(targetHandler).not.toHaveBeenCalled();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('withholds a contributed Action result when the host-owned target origin changes while it runs', async () => {
    let betaMaterialization: PluginMachineMaterializationRefV1 = Object.freeze({
      pluginId: 'acme.beta',
      machineId: 'machine-beta',
      materializationId: 'materialization-beta-before',
    });
    const targetHandler = vi.fn(async () => {
      betaMaterialization = Object.freeze({
        pluginId: 'acme.beta',
        machineId: 'machine-beta',
        materializationId: 'materialization-beta-after',
      });
      return { accepted: true };
    });
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      resolveCurrentPluginMaterializationRef: () => betaMaterialization,
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alpha = await createPluginTestkit({
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.executeWithExecutionOrigin(
            { pluginId: 'acme.beta', localId: 'receive' },
            { title: 'Ready' },
          ));
        },
      },
    });

    try {
      const received = await alpha.invokeAction('send', null).catch((error: unknown) => error);
      expect(received).toMatchObject({
        code: 'plugin_action_execution_origin_changed',
      });
      expect(received).not.toHaveProperty('actionHandlerInvocation');
      expect(targetHandler).toHaveBeenCalledOnce();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it.each([
    ['null', () => null],
    ['a malformed materialization', () => ({
      pluginId: 'acme.alpha',
      machineId: '',
      materializationId: 'materialization-alpha-current',
    })],
    ['a materialization with an unknown field', () => ({
      pluginId: 'acme.alpha',
      machineId: 'machine-alpha',
      materializationId: 'materialization-alpha-current',
      unexpected: true,
    })],
    ['a different plugin materialization', () => ({
      pluginId: 'acme.other',
      machineId: 'machine-other',
      materializationId: 'materialization-other-current',
    })],
    ['a throwing resolver', () => { throw new Error('materialization lookup failed'); }],
  ])('fails closed for %s rather than replacing an unavailable host materialization with the synthetic default', async (_case, resolveCurrentPluginMaterializationRef) => {
    const targetHandler = vi.fn(async () => null);
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alpha = await createPluginTestkit({
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      resolveCurrentPluginMaterializationRef,
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.beta', localId: 'receive' },
            null,
          ));
        },
      },
    });

    try {
      await expect(alpha.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_action_caller_unavailable',
      });
      expect(targetHandler).not.toHaveBeenCalled();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('rejects a contributed target after its synthetic current materialization retires', async () => {
    const targetHandler = vi.fn(async () => null);
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alphaOptions: PluginTestkitOptions = {
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => {
            try {
              await context.services.actions.execute(
                { pluginId: 'acme.beta', localId: 'receive' },
                null,
              );
            } catch (error) {
              return { targetHandlerNotStarted: isPluginActionHandlerInvocationKnownNotStarted(error) };
            }
            return { targetHandlerNotStarted: false };
          });
        },
      },
    };
    const alpha = await createPluginTestkit(alphaOptions);

    try {
      await beta.dispose();
      await expect(alpha.invokeAction('send', null)).resolves.toEqual({
        targetHandlerNotStarted: true,
      });
      expect(targetHandler).not.toHaveBeenCalled();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('requires a target Action to declare the plugin surface before dispatch', async () => {
    const targetHandler = vi.fn(async () => null);
    const beta = await createPluginTestkit({
      manifest: actionManifest('acme.beta', 'receive', ['cli']),
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alphaOptions: PluginTestkitOptions = {
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.beta', localId: 'receive' },
            null,
          ));
        },
      },
    };
    const alpha = await createPluginTestkit(alphaOptions);

    try {
      await expect(alpha.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_action_unavailable',
      });
      expect(targetHandler).not.toHaveBeenCalled();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('validates a nested contributed Action through the canonical invocation schema', async () => {
    const targetHandler = vi.fn(async () => null);
    const betaManifest = {
      ...actionManifest('acme.beta', 'receive', ['plugin']),
      contributes: {
        actions: [{
          id: 'receive',
          title: 'receive',
          execution: { target: 'daemon' },
          scopes: ['global'],
          surfaces: ['plugin'],
          dangerLevel: 'safe',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          },
        }],
      },
    } satisfies PluginManifest;
    const beta = await createPluginTestkit({
      manifest: betaManifest,
      module: {
        activate(api) {
          api.actions.register('receive', targetHandler);
        },
      },
    });
    const alphaOptions: PluginTestkitOptions = {
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.beta', localId: 'receive' },
            null,
          ));
        },
      },
    };
    const alpha = await createPluginTestkit(alphaOptions);

    try {
      await expect(alpha.invokeAction('send', null)).rejects.toMatchObject({
        code: 'plugin_action_input_schema_invalid',
      });
      expect(targetHandler).not.toHaveBeenCalled();
    } finally {
      await alpha.dispose();
      await beta.dispose();
    }
  });

  it('propagates caller cancellation through nested testkit contributed Actions', async () => {
    const gammaHandler = vi.fn(async (_input, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      });
      return null;
    });
    const gamma = await createPluginTestkit({
      manifest: actionManifest('acme.gamma', 'receive', ['plugin']),
      module: {
        activate(api) {
          api.actions.register('receive', gammaHandler);
        },
      },
    });
    const betaOptions: PluginTestkitOptions = {
      manifest: actionManifest('acme.beta', 'relay', ['plugin']),
      actionTargets: [gamma],
      module: {
        activate(api) {
          api.actions.register('relay', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.gamma', localId: 'receive' },
            null,
          ));
        },
      },
    };
    const beta = await createPluginTestkit(betaOptions);
    const alphaOptions: PluginTestkitOptions = {
      manifest: actionManifest('acme.alpha', 'send', ['cli']),
      actionTargets: [beta],
      module: {
        activate(api) {
          api.actions.register('send', async (_input, context) => await context.services.actions.execute(
            { pluginId: 'acme.beta', localId: 'relay' },
            null,
          ));
        },
      },
    };
    const alpha = await createPluginTestkit(alphaOptions);
    const caller = new AbortController();

    try {
      const pending = alpha.invokeAction('send', null, { signal: caller.signal });
      await vi.waitFor(() => expect(gammaHandler).toHaveBeenCalledOnce());
      caller.abort(new Error('caller stopped'));
      await expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    } finally {
      await alpha.dispose();
      await beta.dispose();
      await gamma.dispose();
    }
  });

  it('settles an abort-ignoring Action handler after caller cancellation', async () => {
    const caller = new AbortController();
    const handler = vi.fn(() => new Promise<never>(() => {}));
    const testkit = await createPluginTestkit({
      manifest: actionManifest('acme.abort', 'wait', ['cli']),
      module: {
        activate(api) {
          api.actions.register('wait', handler);
        },
      },
    });

    try {
      const pending = testkit.invokeAction('wait', null, { signal: caller.signal });
      let rejection: unknown;
      void pending.catch((error) => {
        rejection = error;
      });
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

      caller.abort(new Error('caller stopped'));

      await vi.waitFor(
        () => expect(rejection).toMatchObject({ code: 'plugin_action_aborted' }),
        { timeout: 1_000 },
      );
      await expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    } finally {
      await testkit.dispose();
    }
  }, 2_000);

  it('passes a host-stamped Message Action snapshot only through the synthetic invocation context', async () => {
    const messageAction = {
      sessionId: 'session-1',
      messageId: 'message-1',
      observedRevision: 'revision-1',
      role: 'user',
      contentCategory: 'text',
      seq: 4,
      visibleText: 'Review this change.',
      structuredPresentationSummary: null,
      provenanceCategory: 'owner',
    } satisfies MessageActionAvailableSnapshotV1;
    let observed: MessageActionAvailableSnapshotV1 | undefined;
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            observed = context.messageAction;
            return null;
          });
        },
      },
    });

    await testkit.invokeAction('echo', null, { messageAction });

    expect(observed).toEqual(messageAction);
    await testkit.dispose();
  });

  it('projects every public testkit registration family from the canonical host map', () => {
    expectTypeOf<MissingPluginTestkitRegistrationFamily>().toEqualTypeOf<never>();
    expectTypeOf<UnexpectedPluginTestkitRegistrationFamily>().toEqualTypeOf<never>();
    expectTypeOf<PluginTestkitRegistrationByFamily>().toHaveProperty('requestInterceptors');
  });

  it('retrieves Event and MCP discovery registrations with their exact public handler identities', () => {
    expectTypeOf<PluginTestkitRegistrationByFamily['events']>()
      .toEqualTypeOf<PluginEventHandler>();
    expectTypeOf<PluginTestkitRegistrationByFamily['mcp.discoverySources']>()
      .toEqualTypeOf<PluginMcpDiscoveryHandler>();
    expectTypeOf(assertPublicRegistrationLookupTypes).returns.toEqualTypeOf<void>();
  });

  it('activates declared registrations and invokes the real registered action without daemon state', async () => {
    const presentationCalls: string[] = [];
    const presentation = Object.freeze({
      async notify(message: string) {
        presentationCalls.push(`notify:${message}`);
      },
      status: Object.freeze({ async set(key: string, text: string | null) { presentationCalls.push(`status:${key}:${text}`); } }),
      widget: Object.freeze({ async set() {} }),
      composer: Object.freeze({ async replace() {} }),
    }) satisfies PresentationService;
    expect('title' in presentation).toBe(false);
    const logCalls: string[] = [];
    const logger = Object.freeze({
      debug(message: string) { logCalls.push(`debug:${message}`); },
      info(message: string) { logCalls.push(`info:${message}`); },
      warn(message: string) { logCalls.push(`warn:${message}`); },
      error(message: string) { logCalls.push(`error:${message}`); },
      diagnostic(data: Parameters<PluginLoggerService['diagnostic']>[0]) { logCalls.push(`diagnostic:${data.code}`); },
    }) satisfies PluginLoggerService;
    const testkit = await createPluginTestkit({
      manifest,
      presentation,
      services: { logger },
      module: {
        activate(api) {
          api.actions.register('echo', async (input, context) => {
            context.services.logger.info('invoked');
            const invocationPresentation = context.ui;
            if (invocationPresentation === undefined) {
              throw new Error('Expected the test presentation facade');
            }
            await invocationPresentation.notify('Finished');
            return {
              input,
              pluginId: context.plugin.id,
              contributionId: context.contribution.id,
              qualifiedContributionId: context.contribution.qualifiedId,
              serviceAvailability: context.services.availability('storage').status,
              loggerAvailability: context.services.availability('logger').status,
              loggerIsFixture: context.services.logger === logger,
              presentationIsFixture: invocationPresentation === presentation,
            };
          });
        },
      },
    });

    await expect(testkit.invokeAction('echo', { value: 42 })).resolves.toEqual({
      input: { value: 42 },
      pluginId: 'acme.testkit',
      contributionId: 'echo',
      qualifiedContributionId: 'acme.testkit/actions/echo',
      serviceAvailability: 'unavailable',
      loggerAvailability: 'available',
      loggerIsFixture: true,
      presentationIsFixture: true,
    });
    expect(logCalls).toEqual(['info:invoked']);
    expect(presentationCalls).toEqual(['notify:Finished']);
    expect(testkit.registrations()).toEqual([{ family: 'actions', localId: 'echo' }]);
    expect(testkit).not.toHaveProperty('install');
    expect(testkit).not.toHaveProperty('currentGeneration');

    await testkit.dispose();
    await expect(testkit.invokeAction('echo', null)).rejects.toThrow(/disposed/u);
  });

  it('provides typed unavailable service and presentation facades when fixtures do not opt in', async () => {
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            const invocationPresentation = context.ui;
            if (invocationPresentation === undefined) {
              throw new Error('Expected the test presentation facade');
            }
            await invocationPresentation.notify('Finished');
            return null;
          });
        },
      },
    });

    await expect(testkit.invokeAction('echo', null)).rejects.toMatchObject({
      code: 'plugin_presentation_unavailable',
    });
    await testkit.dispose();

    const missingService = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            await context.services.fs.readFile({ root: 'workspace', relativePath: 'README.md' });
            return null;
          });
        },
      },
    });
    await expect(missingService.invokeAction('echo', null)).rejects.toMatchObject({
      code: 'plugin_test_service_unavailable',
    });
    await missingService.dispose();
  });

  it('binds an explicit Provider service fixture and leaves it unavailable by default', async () => {
    const describe = vi.fn(async () => ({
      status: 'success' as const,
      connections: [],
      available: [],
      availableTruncated: false,
      discoveryCandidates: [],
      discoveryCandidatesTruncated: false,
      localInstallations: [],
      diagnostics: [],
      diagnosticsTruncated: false,
    }));
    const unused = vi.fn(async (): Promise<never> => {
      throw new Error('unused Provider fixture operation');
    });
    const providers = Object.freeze({
      connections: Object.freeze({
        describe,
        mutate: unused,
        bindingStatus: unused,
      }),
      catalog: Object.freeze({
        probe: unused,
        listModels: unused,
        setModelLoad: unused,
        projectModels: unused,
        mutateModelSettings: unused,
      }),
      migrations: Object.freeze({
        preview: unused,
        confirm: unused,
        confirmConflict: unused,
      }),
    }) satisfies ProvidersService;
    const testkit = await createPluginTestkit({
      manifest,
      services: { providers },
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => ({
            availability: context.services.availability('providers').status,
            result: await context.services.providers.connections.describe({}),
          }));
        },
      },
    });

    await expect(testkit.invokeAction('echo', null)).resolves.toMatchObject({
      availability: 'available',
      result: { status: 'success' },
    });
    expect(describe).toHaveBeenCalledWith({});
    await testkit.dispose();
  });

  it('binds an explicit Targeted Contributions fixture and leaves the host-owned admission boundary unavailable by default', async () => {
    const onInvalidated = vi.fn();
    let observedSnapshot: unknown = null;
    const targetedContributions: TargetedContributionsService = Object.freeze({
      observeForSelf<TContribution>(
        _point: TargetedContributionPointRef<TContribution>,
        _options: Readonly<{ onInvalidated: () => void }>,
      ): TargetedContributionObservation<TContribution> {
        return Object.freeze({
          dispose: vi.fn(),
          async readCurrent() {
            return Object.freeze({
              generation: 'immutable-target',
              contributions: Object.freeze([]),
            });
          },
        });
      },
    });
    const testkit = await createPluginTestkit({
      manifest,
      services: { targetedContributions },
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            const active = context.services.targetedContributions;
            const observed = active.observeForSelf(
              { targetPluginId: 'acme.testkit', id: 'providers', protocol: { id: 'example-providers', version: 1 } },
              { onInvalidated },
            );
            observedSnapshot = await observed.readCurrent();
            return {
              availability: context.services.availability('targetedContributions').status,
            };
          });
        },
      },
    });

    await expect(testkit.invokeAction('echo', null)).resolves.toEqual({
      availability: 'available',
    });
    expect(observedSnapshot).toEqual({ generation: 'immutable-target', contributions: [] });
    await testkit.dispose();

    const missing = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            context.services.targetedContributions.observeForSelf(
              { targetPluginId: 'acme.testkit', id: 'providers', protocol: { id: 'example-providers', version: 1 } },
              { onInvalidated },
            );
            return null;
          });
        },
      },
    });
    await expect(missing.invokeAction('echo', null)).rejects.toMatchObject({
      code: 'plugin_test_service_unavailable',
    });
    await missing.dispose();
  });

  it('applies per-invocation fixtures only to that invocation and composes caller cancellation', async () => {
    const defaultInfo = vi.fn();
    const overrideInfo = vi.fn();
    const logger = (info: PluginLoggerService['info']): PluginLoggerService => ({
      debug() {},
      info,
      warn() {},
      error() {},
      diagnostic() {},
    });
    const testkit = await createPluginTestkit({
      manifest,
      services: { logger: logger(defaultInfo) },
      module: {
        activate(api) {
          api.actions.register('echo', async (input, context) => {
            context.services.logger.info('invoked');
            if (input === 'wait') {
              await new Promise<void>((_resolve, reject) => {
                context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
              });
            }
            return null;
          });
        },
      },
    });

    await testkit.invokeAction('echo', null, { services: { logger: logger(overrideInfo) } });
    await testkit.invokeAction('echo', null);
    expect(overrideInfo).toHaveBeenCalledOnce();
    expect(defaultInfo).toHaveBeenCalledOnce();

    const caller = new AbortController();
    const pending = testkit.invokeAction('echo', 'wait', { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error('caller stopped'));
    await expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    await testkit.dispose();
  });

  it('rejects undeclared or missing registrations through canonical manifest rights', async () => {
    await expect(createPluginTestkit({
      manifest,
      module: { activate(api) { api.actions.register('other', () => undefined); } },
    })).rejects.toThrow(/undeclared contribution/u);

    await expect(createPluginTestkit({
      manifest,
      module: { activate() {} },
    })).rejects.toThrow(/missing registration/u);
  });

  it('binds the parsed Voice declaration while preserving shared correspondence checks', async () => {
    const runtime = voiceRuntime();
    const testkit = await createPluginTestkit({
      manifest: voiceManifest,
      module: {
        activate(api) {
          api.voiceProviders.register('speech', runtime);
        },
      },
    });

    expect(testkit.registration('voiceProviders', 'speech')).toEqual({
      kind: 'speech',
      synthesize: expect.any(Function),
    });
    await testkit.dispose();

    await expect(createPluginTestkit({
      manifest: voiceManifest,
      module: {
        activate(api) {
          api.voiceProviders.register('speech', voiceRuntime(true));
        },
      },
    })).rejects.toThrow(/mismatched STT/u);
  });

  it('exposes canonical snapshots while rejecting undeclared, duplicate, and incomplete Agent facets', async () => {
    const testkit = await createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory, { sessionRunnerFactory });
        },
      },
    });
    const assistantRegistration = testkit.registration('agents', 'assistant');
    expectTypeOf(assistantRegistration).toEqualTypeOf<
      Extract<PluginRuntimeRegistration, { family: 'agents' }>['value'] | undefined
    >();
    expect(assistantRegistration).toEqual({
      factory: agentFactory,
      sessionRunnerFactory,
    });
    await testkit.dispose();

    await expect(createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('other', agentFactory);
        },
      },
    })).rejects.toThrow(/undeclared contribution/u);

    await expect(createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory, { sessionRunnerFactory });
          api.agents.register('assistant', agentFactory, { sessionRunnerFactory });
        },
      },
    })).rejects.toThrow(/duplicate Agent runtime/u);

    await expect(createPluginTestkit({
      manifest: agentWithExternalSessionsManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory, { sessionRunnerFactory });
        },
      },
    })).rejects.toThrow(/missing Agent External Sessions contribution/u);
  });

  it('captures class, prototype, and accessor-backed Agent provider bindings', async () => {
    class StructuralProviderBinding {
      readonly ignoredByRegistration = true;
      readonly owner = 'structural-provider-binding';

      get v() {
        return 1 as const;
      }

      get adapterVersion() {
        return 1;
      }

      get prepare() {
        return this.prepareImplementation;
      }

      prepareImplementation() {
        return {
          v: 1 as const,
          materialization: 'spawnEnv' as const,
          owner: this.owner,
        };
      }

      async materialize() {
        return {
          v: 1 as const,
          kind: 'spawnEnv' as const,
          env: [],
          owner: this.owner,
        };
      }
    }
    const providerBinding = new StructuralProviderBinding();
    const testkit = await createPluginTestkit({
      manifest: agentManifest,
      module: {
        activate(api) {
          api.agents.register('assistant', agentFactory, {
            providerBinding: providerBinding as never,
            sessionRunnerFactory,
          });
        },
      },
    });
    const registered = testkit.registration('agents', 'assistant');
    const snapshot = registered?.providerBinding;
    expect(snapshot).toMatchObject({ v: 1, adapterVersion: 1 });
    expect(snapshot).not.toBe(providerBinding);
    expect(snapshot).not.toHaveProperty('ignoredByRegistration');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.apply(snapshot!.prepare, { owner: 'foreign' }, [])).toMatchObject({
      owner: 'structural-provider-binding',
    });
    await testkit.dispose();
  });

  it('rejects missing or non-callable Agent provider binding operations', async () => {
    const materialize = async () => ({ v: 1 as const, kind: 'spawnEnv' as const, env: [] });
    for (const providerBinding of [
      { v: 1, adapterVersion: 1, materialize },
      { v: 1, adapterVersion: 1, prepare: null, materialize },
    ]) {
      await expect(createPluginTestkit({
        manifest: agentManifest,
        module: {
          activate(api) {
            api.agents.register('assistant', agentFactory, {
              providerBinding: providerBinding as never,
              sessionRunnerFactory,
            });
          },
        },
      })).rejects.toThrow(/invalid 'agents\/assistant' runtime/u);
    }
  });

  it('aborts testkit-owned invocation signals when the testkit is disposed', async () => {
    let invocationSignal: AbortSignal | undefined;
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', async (_input, context) => {
            invocationSignal = context.signal;
            await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
            return null;
          });
        },
      },
    });

    const invocation = testkit.invokeAction('echo', null);
    await Promise.resolve();
    expect(invocationSignal?.aborted).toBe(false);
    await testkit.dispose();
    expect(invocationSignal?.aborted).toBe(true);
    await expect(invocation).rejects.toMatchObject({
      code: 'plugin_action_generation_retired',
    });
  });

  it('runs the activation cleanup once when the testkit is disposed', async () => {
    const cleanup = vi.fn(async () => undefined);
    const testkit = await createPluginTestkit({
      manifest,
      module: {
        activate(api) {
          api.actions.register('echo', () => null);
          return cleanup;
        },
      },
    });

    await testkit.dispose();
    await testkit.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('awaits registered dynamic MCP disposal before activation cleanup', async () => {
    const cleanupOrder: string[] = [];
    const disposeRuntime = vi.fn(async () => { cleanupOrder.push('mcp'); });
    const cleanup = vi.fn(async () => { cleanupOrder.push('activation'); });
    const testkit = await createPluginTestkit({
      manifest: mcpManifest,
      module: {
        activate(api) {
          api.actions.register('echo', () => null);
          api.mcp.registerServer('tools', mcpRuntime(disposeRuntime));
          return cleanup;
        },
      },
    });

    await testkit.dispose();
    await testkit.dispose();

    expect(cleanupOrder).toEqual(['mcp', 'activation']);
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs the resolved activation cleanup when registration validation fails', async () => {
    const cleanup = vi.fn(async () => undefined);

    await expect(createPluginTestkit({
      manifest,
      module: { activate: () => cleanup },
    })).rejects.toThrow(/missing registration/u);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('unwinds committed registrations and activation cleanup when invocation schema compilation fails', async () => {
    const cleanup = vi.fn(async () => undefined);
    const invalidSchemaManifest = {
      ...manifest,
      contributes: {
        actions: [{
          ...manifest.contributes.actions[0],
          inputSchema: { anyOf: [] },
        }],
      },
    } satisfies PluginManifest;

    await expect(createPluginTestkit({
      manifest: invalidSchemaManifest,
      module: {
        activate(api) {
          api.actions.register('echo', () => null);
          return cleanup;
        },
      },
    })).rejects.toThrow(/anyOf/u);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
