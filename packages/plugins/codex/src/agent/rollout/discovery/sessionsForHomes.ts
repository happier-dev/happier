import type { CodexExternalSessionSource } from '../../surfaces/sessions/external/models.js';
import { homeEntries } from './homeEntries.js';

export async function homes(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const entries = await homeEntries(params);
  return entries.map((entry) => entry.codexHome);
}
