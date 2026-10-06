import {
  buildBugReportExportBundle,
  serializeBugReportExportBundle,
  type BugReportArtifactPayload,
  type BugReportEnvironmentPayload,
  type BugReportFormPayload,
} from '@happier-dev/protocol';

import { t } from '@/text';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';

export async function exportBugReportDiagnosticsBundle(input: {
  environment: BugReportEnvironmentPayload;
  artifacts: readonly BugReportArtifactPayload[];
  form?: BugReportFormPayload;
  exportedAt?: string;
}): Promise<void> {
  const bundle = buildBugReportExportBundle({
    exportedAt: input.exportedAt,
    form: input.form,
    environment: input.environment,
    artifacts: input.artifacts,
  });
  const name = `happier-diagnostics-${Date.now()}.json`;
  const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: name });
  if (!sink.ok) throw new Error(sink.error);
  let retainCacheFile = false;
  try {
    await sink.writeBytes(new TextEncoder().encode(serializeBugReportExportBundle(bundle)));
    await sink.close();
    const result = await shareNativeCacheFile({
      fileUri: sink.fileUri, name, mimeType: 'application/json', UTI: 'public.json', dialogTitle: t('common.saveAs'),
    });
    if (result.status !== 'shared') throw new Error(t('files.fileSharingUnavailable'));
    retainCacheFile = result.retainCacheFile;
  } finally {
    if (!retainCacheFile) await sink.cleanup();
  }
}
