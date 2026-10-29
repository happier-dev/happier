import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { formatPreRestartBugReportSnapshotDetails, type PreRestartBugReportSnapshotV1 } from '@/utils/system/preRestartBugReportSnapshot';
import { t } from '@/text';
import {
  buildBugReportExportBundle,
  serializeBugReportExportBundle,
  redactBugReportSensitiveText,
  inferBugReportDeploymentTypeFromServerUrl,
  type BugReportArtifactPayload,
  type BugReportEnvironmentPayload,
  type BugReportFormPayload,
} from '@happier-dev/protocol';

export async function exportBugReportDiagnosticsBundle(input: {
  environment: BugReportEnvironmentPayload;
  artifacts: readonly BugReportArtifactPayload[];
  form?: BugReportFormPayload;
  exportedAt?: string;
}): Promise<void> {
  const name = 'happier-diagnostics-' + String(Date.now()) + '.json';
  const bundle = buildBugReportExportBundle({
    exportedAt: input.exportedAt,
    form: input.form,
    environment: input.environment,
    artifacts: input.artifacts.map((artifact) => ({ ...artifact, content: redactBugReportSensitiveText(artifact.content) })),
  });
  const contents = serializeBugReportExportBundle(bundle);

  await saveFileBytes({
    name,
    bytes: new TextEncoder().encode(contents),
    mimeType: 'application/json',
    dialogTitle: t('common.saveAs'),
    UTI: 'public.json',
  });
}

export async function exportPreRestartBugReportSnapshot(snapshot: PreRestartBugReportSnapshotV1): Promise<void> {
  await exportBugReportDiagnosticsBundle({
    environment: {
      appVersion: snapshot.runtime?.appVersion || 'unknown',
      platform: snapshot.platform,
      osVersion: snapshot.runtime?.osVersion || undefined,
      deploymentType: inferBugReportDeploymentTypeFromServerUrl(snapshot.runtime?.serverUrl ?? ''),
    },
    artifacts: [
      { filename: 'crash.txt', sourceKind: 'ui-mobile', contentType: 'text/plain', content: formatPreRestartBugReportSnapshotDetails(snapshot) },
      { filename: 'app-console.log', sourceKind: 'ui-mobile', contentType: 'text/plain', content: snapshot.appLogs },
      { filename: 'user-actions.json', sourceKind: 'ui-mobile', contentType: 'application/json', content: JSON.stringify(snapshot.userActions, null, 2) },
    ],
  });
}
