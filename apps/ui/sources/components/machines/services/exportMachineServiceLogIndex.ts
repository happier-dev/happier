import { requestSaveFile } from '@/sync/runtime/files/requestSaveFile';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Saves only already-redacted loaded pages, through the shared client file Action. */
export async function exportMachineServiceLogIndex(input: Readonly<{
  index: import('@happier-dev/forge-ci/runtime').LogIndexV1;
  fileName: string;
  isCurrent(): boolean;
  scope?: ServerAccountScope;
}>): Promise<'saved' | 'canceled' | 'failed'> {
  if (!input.isCurrent()) return 'canceled';
  const log = input.index.log;
  const text = 'text' in log ? log.text : log.fragments.map(fragment => fragment.text).join('');
  return requestSaveFile({ fileName: input.fileName, source: { kind: 'text', text } }, input.scope);
}
