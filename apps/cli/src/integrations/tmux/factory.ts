import { formatTmuxSessionIdentifier, TmuxSessionIdentifierError } from './identifiers';
import { TmuxUtilities } from './TmuxUtilities';
import type { TmuxSessionIdentifier } from './types';

// Global instance for consistent usage
const tmuxUtilsByKey = new Map<string, TmuxUtilities>();

function tmuxUtilitiesCacheKey(
  sessionName?: string,
  tmuxCommandEnv?: Record<string, string>,
  tmuxSocketPath?: string,
): string {
  const resolvedSessionName = sessionName ?? TmuxUtilities.DEFAULT_SESSION_NAME;
  const resolvedSocketPath = tmuxSocketPath ?? '';
  const envKey = tmuxCommandEnv
    ? Object.entries(tmuxCommandEnv)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : '';

  return `${resolvedSessionName}\n${resolvedSocketPath}\n${envKey}`;
}

export function getTmuxUtilities(
  sessionName?: string,
  tmuxCommandEnv?: Record<string, string>,
  tmuxSocketPath?: string,
): TmuxUtilities {
  const key = tmuxUtilitiesCacheKey(sessionName, tmuxCommandEnv, tmuxSocketPath);
  const existing = tmuxUtilsByKey.get(key);
  if (existing) return existing;

  const created = new TmuxUtilities(sessionName, tmuxCommandEnv, tmuxSocketPath);
  tmuxUtilsByKey.set(key, created);
  return created;
}

export async function isTmuxAvailable(): Promise<boolean> {
  try {
    const utils = new TmuxUtilities();
    const result = await utils.executeTmuxCommand(['list-sessions']);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Create a new tmux session with proper typing and validation
 */
export async function createTmuxSession(
  sessionName: string,
  options?: {
    windowName?: string;
    detached?: boolean;
    attach?: boolean;
  },
): Promise<{ success: boolean; sessionIdentifier?: string; error?: string }> {
  try {
    const trimmedSessionName = sessionName?.trim();
    if (!trimmedSessionName || !/^[a-zA-Z0-9._ -]+$/.test(trimmedSessionName)) {
      throw new TmuxSessionIdentifierError(`Invalid session name: "${sessionName}"`);
    }

    const utils = new TmuxUtilities(trimmedSessionName);
    const windowName = options?.windowName || 'main';

    const cmd = ['new-session'];
    if (options?.detached !== false) {
      cmd.push('-d');
    }
    cmd.push('-s', trimmedSessionName);
    cmd.push('-n', windowName);

    const result = await utils.executeTmuxCommand(cmd);
    if (result && result.returncode === 0) {
      const sessionIdentifier: TmuxSessionIdentifier = {
        session: trimmedSessionName,
        window: windowName,
      };
      return {
        success: true,
        sessionIdentifier: formatTmuxSessionIdentifier(sessionIdentifier),
      };
    }

    return {
      success: false,
      error: result?.stderr || 'Failed to create tmux session',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
