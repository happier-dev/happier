import type { DirectSessionsSource } from '@happier-dev/protocol';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';

export async function resolveCodexHomesForDirectSessionsSource(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const entries = await resolveCodexHomeEntriesForDirectSessionsSource(params);
  return entries.map((entry) => entry.codexHome);
}
