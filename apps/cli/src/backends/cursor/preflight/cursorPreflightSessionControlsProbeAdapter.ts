import { resolveCursorSpawnExtrasFromSettings } from '@happier-dev/agents';

import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import type { AgentBackend } from '@/agent/core';
import type { PreflightSessionControlsProbeAdapter, PreflightSessionControlsProbeParams } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import type { ProbedAgentMode } from '@/capabilities/probes/agentModesProbe';
import { probeModelsFromAcpBackend, type ProbedAgentModel } from '@/capabilities/probes/agentModelsProbe';
import { probeAcpCatalogs } from '@/capabilities/probes/probeAcpCatalogs';
import {
  buildCursorSessionModesFromConfigOptions,
  buildCursorSessionModelsFromConfigOptions,
} from '@/backends/cursor/acp/cursorModelConfig';
import { CursorAcpBackend, createCursorBackend } from '@/backends/cursor/acp/backend';
import { projectCursorAvailableModels } from '@/backends/cursor/acp/models';
import { logger } from '@/ui/logger';
import {
  mergeCursorCliModelsIntoAcpModels,
  probeCursorCliModels,
} from './cursorCliModelsProbe';

type CursorSessionControlsBackend = AgentBackend & Partial<{
  getSessionConfigOptionsState: () => ReadonlyArray<SessionConfigOption> | null;
  getCursorAvailableModelsContribution: CursorAcpBackend['getCursorAvailableModelsContribution'];
}>;

function buildCursorProbeEnv(accountSettings: Readonly<Record<string, unknown>> | null | undefined): NodeJS.ProcessEnv {
  const extras = resolveCursorSpawnExtrasFromSettings(accountSettings ?? {});
  return {
    ...(extras.cursorBinaryPath ? { HAPPIER_CURSOR_PATH: extras.cursorBinaryPath } : {}),
    ...(extras.cursorAgentFallbackEnabled === false ? { HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED: '0' } : {}),
    ...(extras.cursorApiEndpoint ? { HAPPIER_CURSOR_API_ENDPOINT: extras.cursorApiEndpoint } : {}),
  };
}

function createCursorProbeBackend(params: PreflightSessionControlsProbeParams): CursorSessionControlsBackend {
  return createCursorBackend({
    cwd: params.cwd,
    env: {
      ...(params.processEnv ?? process.env),
      ...buildCursorProbeEnv(params.accountSettings),
    },
    mcpServers: {},
    permissionMode: 'default',
    permissionHandler: {
      handleToolCall: async () => ({ decision: 'abort' }),
    },
  }) as CursorSessionControlsBackend;
}

async function startCursorProbeBackend(params: PreflightSessionControlsProbeParams): Promise<CursorSessionControlsBackend> {
  const backend = createCursorProbeBackend(params);
  const timeoutMs = Math.max(250, params.timeoutMs);
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`Cursor ACP startSession timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([backend.startSession(), timeoutPromise]);
    return backend;
  } catch (error) {
    await backend.dispose().catch(() => {});
    throw error;
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

async function probeCursorModelsRaw(params: PreflightSessionControlsProbeParams): Promise<ReadonlyArray<ProbedAgentModel> | null> {
  const backend = await startCursorProbeBackend(params).catch(() => {
    logger.infoFile('[cursor] ACP model discovery failed; using the CLI catalog');
    return null;
  });
  try {
    const cliModels = await probeCursorCliModels({
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
      processEnv: {
        ...(params.processEnv ?? process.env),
        ...buildCursorProbeEnv(params.accountSettings),
      },
    }).catch(() => null);
    if (!backend) return cliModels;
    const standardProjection = buildCursorSessionModelsFromConfigOptions(
      backend.getSessionConfigOptionsState?.() ?? null,
    );
    const proprietaryModels = backend.getCursorAvailableModelsContribution?.() ?? [];
    const groupedModels = projectCursorAvailableModels({ proprietaryModels, standardProjection });
    if (groupedModels) {
      const acpModels = groupedModels.availableModels.map((model) => ({
        id: model.id,
        name: model.name,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(model.modelOptions ? { modelOptions: model.modelOptions } : {}),
      }));
      return mergeCursorCliModelsIntoAcpModels({ acpModels, cliModels });
    }
    return cliModels ?? await probeModelsFromAcpBackend({ backend, timeoutMs: params.timeoutMs });
  } finally {
    await backend?.dispose().catch(() => {});
  }
}

async function probeCursorConfigOptionsRaw(params: PreflightSessionControlsProbeParams): Promise<ReadonlyArray<SessionConfigOption> | null> {
  const backend = await startCursorProbeBackend(params);
  try {
    return backend.getSessionConfigOptionsState?.() ?? null;
  } finally {
    await backend.dispose().catch(() => {});
  }
}

async function probeCursorModesRaw(params: PreflightSessionControlsProbeParams): Promise<ReadonlyArray<ProbedAgentMode> | null> {
  const backend = await startCursorProbeBackend(params);
  try {
    const modes = buildCursorSessionModesFromConfigOptions(backend.getSessionConfigOptionsState?.() ?? null);
    return modes?.availableModes ?? null;
  } finally {
    await backend.dispose().catch(() => {});
  }
}

export const cursorPreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
  failureCacheStrategy: 'cooldown',
  probeCatalogsRaw: (params) => probeAcpCatalogs({
    ...params,
    agentId: 'cursor',
    processEnv: { ...(params.processEnv ?? process.env), ...buildCursorProbeEnv(params.accountSettings) },
  }),
  probeModelsRaw: probeCursorModelsRaw,
  probeModesRaw: probeCursorModesRaw,
  probeConfigOptionsRaw: probeCursorConfigOptionsRaw,
};
