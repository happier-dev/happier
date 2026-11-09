import { definePlugin } from '@happier-dev/plugin-sdk';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext, type PluginCheckpointedEventSourceAdapterV1 } from '@happier-dev/plugin-sdk/background-services';
import {
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import {
  createPluginEventAutomationSetupResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';

const PLUGIN_ID = 'examples.automation-event-source';
const EVENT_ID = 'repository-pushed';

/**
 * Deterministic upstream facts keep this copyable example executable without
 * credentials. A real source replaces this array with its provider poll and
 * keeps its existing provider cursor format at the adapter's save port.
 */
const EXAMPLE_PUSHES = Object.freeze([
  Object.freeze({
    occurrenceId: 'example/repository:refs/heads/main:7f6d9d4',
    repository: 'example/repository',
    ref: 'refs/heads/main',
    occurredAt: 1_725_000_000_000,
  }),
]);

/**
 * The deterministic feed has no future deadline or durable cursor. The SDK
 * owns assignment, admission, invalidation and retirement; only these finite
 * provider operations belong to the example.
 */
export async function runRepositoryPushObserver(context: BackgroundServiceContext): Promise<void> {
  const source: PluginCheckpointedEventSourceAdapterV1<string, readonly string[]> = {
    decode(definition) {
      if (definition.eventRef.pluginId !== PLUGIN_ID || definition.eventRef.localId !== EVENT_ID
        || definition.sourceContractVersion !== 1) return null;
      try {
        const { repository } = repositoryInputSchema.parse(definition.sourceConfig);
        return definition.sourceInstanceId === repository ? repository : null;
      } catch { return null; }
    },
    async observe({ source: repository }) {
      const pushes = EXAMPLE_PUSHES.filter(push => push.repository === repository);
      return {
        observations: pushes.map(push => ({
          eventRef: { pluginId: PLUGIN_ID, localId: EVENT_ID },
          sourceInstanceId: repository, sourceContractVersion: 1,
          occurrenceId: push.occurrenceId, occurredAt: push.occurredAt,
          observationReceivedAt: push.occurredAt + 1, observedDelta: 1 as const,
          payload: { repository: push.repository, ref: push.ref },
        })),
        ...(pushes.length === 0 ? {} : { checkpoint: pushes.map(push => push.occurrenceId) }),
        complete: true, nextEligibleAt: null,
      };
    },
    async save({ context: attemptContext, checkpoint, disposition }) {
      // This fixture only records settlement. A real provider commits its own
      // existing cursor/CAS here, never before all observations are safe.
      for (const occurrenceId of checkpoint) attemptContext.services.logger.info('automation_event_source.observation_settled', {
        occurrenceId, ...(disposition === undefined ? {} : { disposition }),
      });
    },
    retryAt: () => null,
  };
  await runCheckpointedPluginEventObserverV1({ context, source });
}

const repositoryInputSchema = defineProtocolObject({
  repository: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

const repositoryPushPayloadSchema = defineProtocolObject({
  repository: defineProtocolString(),
  ref: defineProtocolString(),
}, { policy: 'closed' });

export const { manifest, activate } = definePlugin({
  id: PLUGIN_ID,
  version: '0.1.0',
  displayName: 'Automation Event Source Example',
  description: 'External Event source declaration, setup presentation, and checkpoint-safe observer.',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: { required: [], optional: [] },
  actions: {
    'setup-repository': {
      title: 'Choose repository',
      description: 'Choose the repository whose pushes should trigger this Automation.',
      execution: { target: 'daemon' },
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: repositoryInputSchema.jsonSchema,
      inputHints: {
        title: 'Repository',
        fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }],
      },
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, repositoryInputSchema.jsonSchema),
      run: async (input) => {
        const { repository } = repositoryInputSchema.parse(input);
        return {
          v: 1,
          sourceInstanceId: repository,
          sourceContractVersion: 1,
          sourceConfig: { repository },
          displayLabel: repository,
        };
      },
    },
  },
  events: {
    'repository-pushed': {
      declaration: {
        kind: 'event',
        title: 'Repository pushed',
        description: 'A push was observed in the selected repository.',
        payloadSchema: repositoryPushPayloadSchema.jsonSchema,
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: repositoryInputSchema.jsonSchema,
            setupActionRef: {
              pluginId: PLUGIN_ID,
              localId: 'setup-repository',
            },
            setupSurface: {
              renderer: 'repository-picker',
              fallbackRenderers: ['repository-picker-fallback'],
            },
          },
        },
      },
    },
  },
  ui: {
    views: [],
    renderers: [{
      id: 'repository-picker',
      kind: 'hostedWeb',
      source: { kind: 'artifact', artifact: 'repository-picker' },
      requiredHostMethods: ['context', 'settleEphemeralInput'],
    }, {
      // A declarative fallback needs no build artifact and is the smallest
      // way to show that the setup surface is one renderer chain: the daemon
      // selects the available member and the host never falls back locally.
      id: 'repository-picker-fallback',
      kind: 'declarative',
      root: {
        kind: 'text',
        text: 'The hosted repository picker is unavailable here. Cancel this setup and retry on a supported surface.',
      },
    }],
    translations: [],
  },
  backgroundServices: [{
    declaration: {
      id: 'repository-push-observer',
      title: 'Repository push observer',
    },
    runner: runRepositoryPushObserver,
  }],
});
