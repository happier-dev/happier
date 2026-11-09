import { buildBugReportExportBundle, serializeBugReportExportBundle } from '@happier-dev/protocol/bugs/reports/export';
import type { BugReportArtifactPayload, BugReportEnvironmentPayload, BugReportFormPayload } from '@happier-dev/protocol/bugs/reports/types';

import { t } from '@/text';
import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { formatPreRestartBugReportSnapshotDetails, type PreRestartBugReportSnapshotV1 } from '@/utils/system/preRestartBugReportSnapshot';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { inferBugReportDeploymentTypeFromServerUrl } from '@happier-dev/protocol/bugs/reports/sanitize';

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
    artifacts: input.artifacts.map((artifact) => ({ ...artifact, content: redactBugReportSensitiveText(artifact.content) })),
  });
  const name = `happier-diagnostics-${Date.now()}.json`;
  await saveFileBytes({
    fileName: name,
    bytes: new TextEncoder().encode(serializeBugReportExportBundle(bundle)),
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
