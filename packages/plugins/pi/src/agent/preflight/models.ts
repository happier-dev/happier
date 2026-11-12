import type { AgentSessionModel, AgentPreflightSessionControlsCommandV1, AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { PI_LAUNCH_ENV_KEYS } from '../launchEnvironment.js';
import { buildPiRuntimeModelsSnapshot } from '../models/catalog.js';
import { buildPiModelDiscoveryExtensionSource, parsePiModelDiscoveryLine } from '../models/discoveryExtension.js';
import { PI_REQUEST_AUTH_CAPABILITY_PATH_ENV, resolvePiRequestAuthExtensionPath } from '../auth/services/requestAuth/index.js';
import { buildPiCommandCatalogDiscoveryExtensionSource, parsePiPreflightCommandCatalog } from './catalogs.js';
import { preparePiQualifiedConnectedAccounts } from '../runtime/qualifiedConnectedAccounts.js';

export type PiPreflightModel = AgentSessionModel;

const PI_MODEL_DISCOVERY_ARGS = ['--mode', 'json', '--no-session', '--no-tools'] as const;
const PI_COMMAND_CATALOG_ARGS = ['--mode', 'json', '--no-session'] as const;

type PiPreflightModelObservation = Readonly<{
  availableModels: readonly PiPreflightModel[];
  source: 'static' | 'unavailable';
  refreshError?: true;
  refreshErrorMessage?: string;
}> | null;

function parsePiPreflightModelObservation(stderr: string): PiPreflightModelObservation {
  let result: PiPreflightModelObservation = null;
  for (const line of stderr.split('\n')) {
    const observation = parsePiModelDiscoveryLine(line);
    if (!observation) continue;
    const localFallback = 'error' in observation && observation.error === 'refresh-unsupported';
    if (('error' in observation && !localFallback) || !Array.isArray(observation.models)) {
      result = 'error' in observation && observation.refreshErrorMessage
        ? { availableModels: [], source: 'unavailable', refreshError: true, refreshErrorMessage: observation.refreshErrorMessage }
        : null;
      continue;
    }
    const models = buildPiRuntimeModelsSnapshot({ state: {}, availableModels: { models: observation.models } })?.models;
    // Registry refresh establishes candidates; it does not verify account entitlement.
    result = !models ? null : { availableModels: models, source: 'static',
      ...(localFallback ? { refreshError: true, ...('refreshErrorMessage' in observation
        ? { refreshErrorMessage: observation.refreshErrorMessage } : {}) } : {}) };
  }
  return result;
}

function createPiDiscoveryCommand(
  args: readonly string[],
  buildExtension: (input: Readonly<{ bypassCache?: boolean }>) => string,
): Extract<AgentPreflightSessionControlsCommandV1, { toolId: string }> {
  return Object.freeze({
    toolId: 'pi-cli',
    args,
    environmentKeys: PI_LAUNCH_ENV_KEYS,
    prepareCommand: ({ environment, bypassCache }) => ({
      args: [
        ...args,
        ...(environment.PI_CODING_AGENT_DIR && environment[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV] ? [
          '--extension',
          { kind: 'environmentPath' as const, key: 'PI_CODING_AGENT_DIR', relativePath: resolvePiRequestAuthExtensionPath('') },
        ] : []),
        '--extension',
        { kind: 'temporaryTextFile' as const, suffix: '.mjs', contents: buildExtension({ bypassCache }) },
      ],
    }),
  } satisfies AgentPreflightSessionControlsCommandV1);
}

export const PI_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  prepareLaunchEnvironment: async ({ environment, connectedAccounts, signal }) => {
    const prepared = await preparePiQualifiedConnectedAccounts({
      launchEnvironment: { values: environment, unset: [] },
      context: { signal, services: { connectedAccounts } },
    });
    return { environment: prepared.launchEnvironment.values, unset: prepared.launchEnvironment.unset,
      dispose: prepared.dispose };
  },
  models: Object.freeze({
    command: createPiDiscoveryCommand(PI_MODEL_DISCOVERY_ARGS, buildPiModelDiscoveryExtensionSource),
    parseOutput: ({ stderr }) => parsePiPreflightModelObservation(stderr),
  }),
  catalogs: Object.freeze({
    command: createPiDiscoveryCommand(PI_COMMAND_CATALOG_ARGS, buildPiCommandCatalogDiscoveryExtensionSource),
    parseOutput: parsePiPreflightCommandCatalog,
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
