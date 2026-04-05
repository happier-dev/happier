import { readClaudeJsonlSessionTitle } from '../transcripts/sessionStore/operations/readClaudeJsonlSessionTitle';

export async function readClaudeSessionTitle(filePath: string): Promise<string | null> {
  return readClaudeJsonlSessionTitle(filePath);
}
