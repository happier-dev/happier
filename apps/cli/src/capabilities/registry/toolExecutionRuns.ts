import type { Capability } from '../service';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, delimiter as PATH_DELIMITER } from 'node:path';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { getVendorResumeSupport } from '@/backends/catalog';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { CODEX_PROVIDER_SETTINGS_DEFAULTS } from '@happier-dev/agents';
import { resolveProviderSpawnExtrasForRuntime } from '@/settings/providerSettings';

const EXECUTION_RUN_INTENTS = ['review', 'plan', 'delegate'] as const;
const EXECUTION_RUN_VOICE_INTENTS = [...EXECUTION_RUN_INTENTS, 'voice_agent'] as const;
const CODERABBIT_INTENTS = ['review'] as const;

function isCliAvailable(context: any, agentId: string): boolean {
  const entry = context?.cliSnapshot?.clis?.[agentId];
  return Boolean(entry && typeof entry === 'object' && (entry as any).available === true);
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
    const intents = voiceEnabled ? EXECUTION_RUN_VOICE_INTENTS : EXECUTION_RUN_INTENTS;
    const catalogBackendIds = Object.keys(AGENTS) as CatalogAgentId[];

    const codexDefaultVendorResumeParams = resolveProviderSpawnExtrasForRuntime({
      agentId: 'codex',
      settings: CODEX_PROVIDER_SETTINGS_DEFAULTS,
      processEnv: process.env,
    });

    const resolveSupportsVendorResume = async (backendId: CatalogAgentId): Promise<boolean> => {
      try {
        const fn = await getVendorResumeSupport(backendId);
        return backendId === 'codex' ? fn(codexDefaultVendorResumeParams) : fn({});
      } catch {
        return false;
      }
    };
    const supportEntries = await Promise.all(
      catalogBackendIds.map(async (backendId) => [
        backendId,
        await resolveSupportsVendorResume(backendId),
      ] as const),
    );
    const supportsVendorResumeByBackend = Object.fromEntries(supportEntries) as Record<string, boolean>;
    const backends = Object.fromEntries(
      [
        ...catalogBackendIds.map((backendId) => {
          const available = backendId === 'claude' || backendId === 'customAcp' ? true : isCliAvailable(context, backendId);
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
      // Backend catalog is best-effort and intended for UI affordances (pickers, warnings).
      // Runtime enforcement still happens at execution-run start/send time.
      backends,
    };
  },
};
