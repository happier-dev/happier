import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/sessions';
import { homeEntries } from './homeEntries.js';

export async function homes(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const entries = await homeEntries(params);
  return entries.map((entry) => entry.codexHome);
}
