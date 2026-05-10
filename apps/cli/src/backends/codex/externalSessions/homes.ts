import type { ExternalSessionsSource } from '@happier-dev/protocol';
import { homeEntries } from './homeEntries';

export async function homes(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const entries = await homeEntries(params);
  return entries.map((entry) => entry.codexHome);
}
