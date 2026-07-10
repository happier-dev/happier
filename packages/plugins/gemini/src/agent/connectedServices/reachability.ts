import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  findGeminiChatSessionFile,
  readGeminiChatSessionFileSessionId,
} from './chatSessionFiles.js';

type VerifyResumeReachableInput = Readonly<{
  targetMaterializedRoot: string;
  targetMaterializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string | null;
  cwd: string;
  candidatePersistedSessionFile?: string | null;
  targetStrict?: boolean;
}>;

type VerifyResumeReachableResult =
  | Readonly<{ ok: true; resolvedPath: string | null }>
  | Readonly<{ ok: false; reason: string }>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function verifyResumeReachableGemini(
  input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult> {
  const sessionId = asNonEmptyString(input.vendorResumeId);
  if (!sessionId) {
    return { ok: false, reason: 'gemini_session_file_not_found' };
  }
  const targetStrict = input.targetStrict === true;
  const cwd = asNonEmptyString(input.cwd);

  const candidatePersistedSessionFile = asNonEmptyString(input.candidatePersistedSessionFile);
  if (
    !targetStrict
    && candidatePersistedSessionFile
    && await readGeminiChatSessionFileSessionId(candidatePersistedSessionFile) === sessionId
  ) {
    return { ok: true, resolvedPath: candidatePersistedSessionFile };
  }

  const targetHome = asNonEmptyString(input.targetMaterializedEnv.GEMINI_CLI_HOME)
    ?? asNonEmptyString(input.targetMaterializedEnv.HOME)
    ?? join(input.targetMaterializedRoot, 'home');
  const targetMatch = await findGeminiChatSessionFile({
    geminiDir: join(targetHome, '.gemini'),
    sessionId,
    cwd,
  });
  if (targetMatch) {
    return { ok: true, resolvedPath: targetMatch.filePath };
  }
  if (targetStrict) {
    return { ok: false, reason: 'gemini_session_file_not_found' };
  }

  const nativeMatch = await findGeminiChatSessionFile({
    geminiDir: join(homedir(), '.gemini'),
    sessionId,
    cwd,
  });
  if (nativeMatch) {
    return { ok: true, resolvedPath: nativeMatch.filePath };
  }

  return { ok: false, reason: 'gemini_session_file_not_found' };
}
