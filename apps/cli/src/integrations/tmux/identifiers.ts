import type { TmuxSessionIdentifier } from './types';

/** Validation error for tmux session identifiers */
export class TmuxSessionIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxSessionIdentifierError';
  }
}

// Helper to parse tmux session identifier from string with validation
export function parseTmuxSessionIdentifier(identifier: string): TmuxSessionIdentifier {
  if (!identifier || typeof identifier !== 'string') {
    throw new TmuxSessionIdentifierError('Session identifier must be a non-empty string');
  }

  // Format: session:window or session:window.pane or just session
  const parts = identifier.split(':');
  if (parts.length === 0 || !parts[0]) {
    throw new TmuxSessionIdentifierError('Invalid session identifier: missing session name');
  }

  const result: TmuxSessionIdentifier = {
    session: parts[0].trim(),
  };

  // Validate session name for our identifier format.
  // Allow spaces, since tmux sessions can be user-named with spaces.
  // Disallow characters that would make our identifier ambiguous (e.g. ':' separator).
  if (!/^[a-zA-Z0-9._ -]+$/.test(result.session)) {
    throw new TmuxSessionIdentifierError(
      `Invalid session name: "${result.session}". Only alphanumeric characters, spaces, dots, hyphens, and underscores are allowed.`,
    );
  }

  if (parts.length > 1) {
    const windowAndPane = parts[1].split('.');
    result.window = windowAndPane[0]?.trim();

    if (result.window && !/^[a-zA-Z0-9._ -]+$/.test(result.window)) {
      throw new TmuxSessionIdentifierError(
        `Invalid window name: "${result.window}". Only alphanumeric characters, spaces, dots, hyphens, and underscores are allowed.`,
      );
    }

    if (windowAndPane.length > 1) {
      result.pane = windowAndPane[1]?.trim();
      if (result.pane && !/^[0-9]+$/.test(result.pane)) {
        throw new TmuxSessionIdentifierError(
          `Invalid pane identifier: "${result.pane}". Only numeric values are allowed.`,
        );
      }
    }
  }

  return result;
}

// Helper to format tmux session identifier to string
export function formatTmuxSessionIdentifier(identifier: TmuxSessionIdentifier): string {
  if (!identifier.session) {
    throw new TmuxSessionIdentifierError('Session identifier must have a session name');
  }

  let result = identifier.session;
  if (identifier.window) {
    result += `:${identifier.window}`;
    if (identifier.pane) {
      result += `.${identifier.pane}`;
    }
  }
  return result;
}

// Helper to extract session and window from tmux output with improved validation
export function extractSessionAndWindow(tmuxOutput: string): { session: string; window: string } | null {
  if (!tmuxOutput || typeof tmuxOutput !== 'string') {
    return null;
  }

  // Look for session:window patterns in tmux output
  const lines = tmuxOutput.split('\n');
  const nameRegex = /^[a-zA-Z0-9._ -]+$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Allow spaces in names, but keep ':' as the session/window separator.
    // This helper is intended for extracting the canonical identifier shapes that tmux can emit
    // via format strings (e.g. '#S:#W' or '#S:#W.#P'), so we require end-of-line matches.
    const match = trimmed.match(/^(.+?):(.+?)(?:\.([0-9]+))?$/);
    if (!match) continue;

    const session = match[1]?.trim();
    const window = match[2]?.trim();

    if (!session || !window) continue;
    if (!nameRegex.test(session) || !nameRegex.test(window)) continue;

    return { session, window };
  }

  return null;
}

/**
 * Validate a tmux session identifier without throwing
 */
export function validateTmuxSessionIdentifier(identifier: string): { valid: boolean; error?: string } {
  try {
    parseTmuxSessionIdentifier(identifier);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

/**
 * Build a tmux session identifier with validation
 */
export function buildTmuxSessionIdentifier(params: {
  session: string;
  window?: string;
  pane?: string;
}): { success: boolean; identifier?: string; error?: string } {
  try {
    if (!params.session || !/^[a-zA-Z0-9._ -]+$/.test(params.session)) {
      throw new TmuxSessionIdentifierError(`Invalid session name: "${params.session}"`);
    }

    if (params.window && !/^[a-zA-Z0-9._ -]+$/.test(params.window)) {
      throw new TmuxSessionIdentifierError(`Invalid window name: "${params.window}"`);
    }

    if (params.pane && !/^[0-9]+$/.test(params.pane)) {
      throw new TmuxSessionIdentifierError(`Invalid pane identifier: "${params.pane}"`);
    }

    const identifier: TmuxSessionIdentifier = params;
    return {
      success: true,
      identifier: formatTmuxSessionIdentifier(identifier),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
