import type { Capability, CapabilitiesDetectContext } from '../service';
import { resolveCliFeatureDecision } from '../../features/featureDecisionService';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, delimiter as PATH_DELIMITER } from 'node:path';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import {
  CANONICAL_AGENT_IDS,
  hasBuiltInAcpConfig,
  isAgentId,
  resolveAgentRuntimeControlSurface,
  resolveDefaultAgentRuntimeKind,
  resolveCodexSpawnExtrasForRuntime,
} from '@happier-dev/agents';
import {
  buildExecutionRunProfileCatalog,
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
} from '../../agent/executionRuns/profiles/intentRegistry';
import { resolveCliEngineRegistry } from '../../agent/runtime/registry/engineRegistry';
import type { ResolvedBackendContribution } from '../../plugins/projection/registry/types';

const CODERABBIT_INTENTS = ['review'] as const;

function isCliAvailable(context: CapabilitiesDetectContext, agentId: string): boolean {
  const clis = context?.cliSnapshot?.clis;
  if (!clis || !Object.prototype.hasOwnProperty.call(clis, agentId)) {
    return false;
  }

  const entry = clis[agentId as keyof typeof clis];
  return entry?.available === true;
}

function hasExecutionRunCatalogOwner(entry: Readonly<{
  getAcpBackendFactory?: unknown;
  getRuntimeCore?: unknown;
}> | null | undefined): boolean {
  return typeof entry?.getAcpBackendFactory === 'function' || typeof entry?.getRuntimeCore === 'function';
}

function resolveExecutionRunBackendAvailability(params: Readonly<{
  context: CapabilitiesDetectContext;
  backendId: string;
  isKnownBuiltInAgentId: boolean;
  entry: Readonly<{
    getAcpBackendFactory?: unknown;
    getRuntimeCore?: unknown;
  }> | null | undefined;
  backendContribution?: ResolvedBackendContribution;
}>): boolean {
  if (params.backendId === 'customAcp') {
    // Compatibility backend id used as the UI "configured ACP" entrypoint.
    return true;
  }

  if (params.isKnownBuiltInAgentId && isAgentId(params.backendId) && hasBuiltInAcpConfig(params.backendId)) {
    // Built-in ACP backends are catalog-defined and do not rely on CLI snapshot probing for
    // UI discovery in this wave.
    return true;
  }

  if (hasExecutionRunCatalogOwner(params.entry) || typeof params.backendContribution?.getRuntimeCore === 'function') {
    return true;
  }

  if (params.backendContribution?.provenance === 'external') {
    // Plugin-contributed backends are discovered from the merged contribution
    // registry, not from PATH-backed CLI probing.
    return true;
  }

  return isCliAvailable(params.context, params.backendId);
}

async function resolveCommandOnPath(command: string, pathEnv: string | null | undefined): Promise<string | null> {
  const pathRaw = typeof pathEnv === 'string' ? pathEnv.trim() : '';
  if (!pathRaw) return null;

  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(command, { ...process.env, PATH: pathRaw });
  }

  const segments = pathRaw
    .split(PATH_DELIMITER)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const dir of segments) {
    const candidate = join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }

  return null;
}

export const executionRunsCapability: Capability = {
  descriptor: { id: 'tool.executionRuns', kind: 'tool', title: 'Execution runs' },
  detect: async ({ context }) => {
    const gate = resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env });
    if (gate.state !== 'enabled') {
      return {
        available: false,
        intents: [],
        backends: {},
        disabledBy: gate.blockedBy ?? 'local_policy',
        disabledReason: gate.blockerCode,
      };
    }
    const voiceEnabled = resolveCliFeatureDecision({ featureId: 'voice', env: process.env }).state === 'enabled';

    const coderabbitOverride =
      typeof process.env.HAPPIER_CODERABBIT_REVIEW_CMD === 'string' && process.env.HAPPIER_CODERABBIT_REVIEW_CMD.trim().length > 0;
    const mergedPath = (() => {
      const snapshotPath = typeof context?.cliSnapshot?.path === 'string' ? context.cliSnapshot.path.trim() : '';
      const envPath = typeof process.env.PATH === 'string' ? process.env.PATH.trim() : '';
      if (snapshotPath && envPath) return `${snapshotPath}${PATH_DELIMITER}${envPath}`;
      return snapshotPath || envPath || '';
    })();
    const coderabbitOnPath = coderabbitOverride
      ? true
      : Boolean(await resolveCommandOnPath('coderabbit', mergedPath || null));
    const cliEngineRegistry = await resolveCliEngineRegistry();
    const executionRunProfileCatalog = buildExecutionRunProfileCatalog(
      (cliEngineRegistry.contributions.executionRunProfiles ?? []).map((profile) => profile.definition),
    );
    const executionRunProfiles = listExecutionRunProfileContributionDescriptors(executionRunProfileCatalog);
    const intents = voiceEnabled
      ? listExecutionRunSupportedIntents()
      : listExecutionRunSupportedIntents().filter((intent) => intent !== 'voice_agent');
    const contributedBackendIds = Array.from(cliEngineRegistry.contributions.backendDefinitionsById.keys());
    const catalogBackendIds = Object.keys(cliEngineRegistry.contributions.catalogEntriesById);
    const knownBuiltInAgentIds = CANONICAL_AGENT_IDS;
    const backendIds = Array.from(new Set([
      ...knownBuiltInAgentIds,
      'customAcp',
      ...contributedBackendIds,
      ...catalogBackendIds,
    ]));

    const supportsVendorResumeByBackend = Object.fromEntries(
      backendIds.map((backendId) => {
        const isKnownBuiltInAgentId = isAgentId(backendId);
        if (isKnownBuiltInAgentId) {
          const surface = backendId === 'codex'
            ? (() => {
              const codexExtras = resolveCodexSpawnExtrasForRuntime({ settings: {}, processEnv: process.env });
              const runtimeKind = (codexExtras.codexBackendMode ?? resolveDefaultAgentRuntimeKind('codex')) ?? null;
              return resolveAgentRuntimeControlSurface('codex', runtimeKind);
            })()
            : resolveAgentRuntimeControlSurface(backendId, null);
          return [backendId, surface.resume.vendorResume !== 'unsupported'] as const;
        }
        return [backendId, false] as const;
      }),
    ) as Record<string, boolean>;

    const backends = Object.fromEntries(
      [
        ...backendIds.map((backendId) => {
          const backendContribution = cliEngineRegistry.contributions.backendDefinitionsById.get(backendId);
          const entry = cliEngineRegistry.contributions.catalogEntriesById[backendId];
          const isKnownBuiltInAgentId = isAgentId(backendId);
          const available = resolveExecutionRunBackendAvailability({
            context,
            backendId,
            isKnownBuiltInAgentId,
            entry,
            backendContribution,
          });
          return [
            backendId,
            {
              available,
              intents,
              supportsVendorResume: supportsVendorResumeByBackend[backendId] === true,
            },
          ] as const;
        }),
        [
          'coderabbit',
          {
            available: coderabbitOnPath,
            intents: CODERABBIT_INTENTS,
            supportsVendorResume: false,
          },
        ] as const,
      ],
    ) as Record<string, { available: boolean; intents: readonly string[]; supportsVendorResume: boolean }>;

    return {
      available: true,
      intents,
      executionRunProfiles,
      // Backend catalog is best-effort and intended for UI affordances (pickers, warnings).
      // Runtime enforcement still happens at execution-run start/send time.
      backends,
    };
  },
};
