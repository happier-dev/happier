import type { ExecutionRunIntentProfile } from '../profiles/ExecutionRunIntentProfile';

export function createExecutionRunSidechainStreamText(profile: ExecutionRunIntentProfile): (fullText: string) => string | null {
  return (fullText: string): string | null => profile.computeSidechainStreamText?.({ fullText }) ?? fullText;
}
