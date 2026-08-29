import { definePlugin } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  admitCheckpointedPluginEventObservationV1,
  createPluginEventAutomationSetupResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';

const PLUGIN_ID = 'examples.automation-event-source';
const EVENT_ID = 'repository-pushed';

/**
 * Deterministic upstream facts keep this copyable example executable without
 * credentials. A real source replaces this array with its provider poll and
 * persists its provider cursor only after the helper returns checkpoint-safe.
 */
const EXAMPLE_PUSHES = Object.freeze([
  Object.freeze({
    occurrenceId: 'example/repository:refs/heads/main:7f6d9d4',
    repository: 'example/repository',
    ref: 'refs/heads/main',
    occurredAt: 1_725_000_000_000,
  }),
]);

function waitForRetirement(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Complete public source lifecycle: the SDK helper performs the current,
 * revision-stable source scan, canonical admission, catalog report and source
 * status report. The plugin remains only the upstream observation owner.
 */
export async function runRepositoryPushObserver(context: BackgroundServiceContext): Promise<void> {
  for (const push of EXAMPLE_PUSHES) {
    context.signal.throwIfAborted();
    const disposition = await admitCheckpointedPluginEventObservationV1({
      eventRef: { pluginId: PLUGIN_ID, localId: EVENT_ID },
      sourceInstanceId: push.repository,
      sourceContractVersion: 1,
      occurrenceId: push.occurrenceId,
      occurredAt: push.occurredAt,
      observationReceivedAt: push.occurredAt + 1,
      observedDelta: 1,
      payload: { repository: push.repository, ref: push.ref },
    }, context);
    context.services.logger.info('automation_event_source.observation_settled', {
      occurrenceId: push.occurrenceId,
      disposition,
    });
    if (disposition.kind !== 'checkpointSafe') {
      throw new Error('The example repository push remains unsettled; its provider checkpoint was not advanced.');
    }
  }

  // A background service that resolves is no longer available. Stay healthy
  // and idle until this exact plugin generation is retired by the host.
  await waitForRetirement(context.signal);
}

const repositoryInputSchema = {
  type: 'object',
  properties: { repository: { type: 'string', minLength: 1 } },
  required: ['repository'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

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
      inputSchema: repositoryInputSchema,
      inputHints: {
        title: 'Repository',
        fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }],
      },
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, repositoryInputSchema),
      run: async (input) => {
        // The host validates this input against `inputSchema` before dispatch;
        // the narrowing below mirrors that admitted shape.
        const { repository } = input as Readonly<{ repository: string }>;
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
        payloadSchema: {
          type: 'object',
          properties: {
            repository: { type: 'string' },
            ref: { type: 'string' },
          },
          required: ['repository', 'ref'],
          additionalProperties: false,
        },
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: repositoryInputSchema,
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
