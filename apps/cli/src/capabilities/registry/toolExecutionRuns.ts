import type { Capability } from '../service';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, delimiter as PATH_DELIMITER } from 'node:path';
import { getVendorResumeSupport } from '@/backends/catalog';

function isCliAvailable(context: any, agentId: string): boolean {
  const entry = context?.cliSnapshot?.clis?.[agentId];
  return Boolean(entry && typeof entry === 'object' && (entry as any).available === true);
}

async function resolveCommandOnPath(command: string, pathEnv: string | null | undefined): Promise<string | null> {
  const pathRaw = typeof pathEnv === 'string' ? pathEnv.trim() : '';
  if (!pathRaw) return null;

  const segments = pathRaw
    .split(PATH_DELIMITER)
    .map((p) => p.trim())
    .filter(Boolean);

  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .map((e) => e.trim())
        .filter(Boolean)
    : [''];

  for (const dir of segments) {
    for (const ext of extensions) {
      const candidate = join(dir, isWindows ? `${command}${ext}` : command);
      try {
        await access(candidate, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // continue
      }
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

    const resolveSupportsVendorResume = async (backendId: string): Promise<boolean> => {
      try {
        const fn = await getVendorResumeSupport(backendId as any);
        return fn({});
      } catch {
        return false;
      }
    };
    const supportsVendorResumeByBackend = Object.fromEntries(
      await Promise.all(
        ['claude', 'codex', 'gemini', 'opencode', 'auggie', 'qwen', 'kimi', 'kilo', 'pi'].map(async (id) => [
          id,
          await resolveSupportsVendorResume(id),
        ]),
      ),
    ) as Record<string, boolean>;

    return {
      available: true,
      intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
      // Backend catalog is best-effort and intended for UI affordances (pickers, warnings).
      // Runtime enforcement still happens at execution-run start/send time.
      backends: {
        claude: {
          available: true,
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.claude === true,
        },
        codex: {
          available: isCliAvailable(context, 'codex'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.codex === true,
        },
        gemini: {
          available: isCliAvailable(context, 'gemini'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.gemini === true,
        },
        opencode: {
          available: isCliAvailable(context, 'opencode'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.opencode === true,
        },
        auggie: {
          available: isCliAvailable(context, 'auggie'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.auggie === true,
        },
        qwen: {
          available: isCliAvailable(context, 'qwen'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.qwen === true,
        },
        kimi: {
          available: isCliAvailable(context, 'kimi'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.kimi === true,
        },
        kilo: {
          available: isCliAvailable(context, 'kilo'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.kilo === true,
        },
        pi: {
          available: isCliAvailable(context, 'pi'),
          intents: voiceEnabled ? ['review', 'plan', 'delegate', 'voice_agent'] : ['review', 'plan', 'delegate'],
          supportsVendorResume: supportsVendorResumeByBackend.pi === true,
        },
        coderabbit: {
          available: coderabbitOnPath,
          intents: ['review'],
          supportsVendorResume: false,
        },
      },
    };
  },
};
