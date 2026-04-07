import {
  pushBugReportArtifact,
  sanitizeBugReportArtifactFileSegment,
  type BugReportArtifactPayload,
} from '@happier-dev/protocol';

import type { SupportReport } from '../types.js';
import { sanitizeSupportInventoryForArtifactUpload } from './sanitizeSupportInventory.js';

export function collectSupportBugReportArtifacts(
  report: SupportReport,
  input: Readonly<{
    acceptedKinds: readonly string[];
    maxArtifactBytes: number;
  }>,
): BugReportArtifactPayload[] {
  const artifacts: BugReportArtifactPayload[] = [];
  const maxArtifactBytes = Number.isFinite(input.maxArtifactBytes) ? Math.max(1024, Math.floor(input.maxArtifactBytes)) : 10 * 1024 * 1024;
  const sanitizedInventory = sanitizeSupportInventoryForArtifactUpload(report.inventory);

  pushBugReportArtifact(
    artifacts,
    {
      filename: `${sanitizeBugReportArtifactFileSegment('support')}-cli.json`,
      sourceKind: 'cli',
      contentType: 'application/json',
      content: JSON.stringify({
        capturedAt: report.capturedAt,
        inventory: {
          invokedBinaryPath: sanitizedInventory.invokedBinaryPath,
          invokedVersion: sanitizedInventory.invokedVersion,
          nodeVersion: sanitizedInventory.nodeVersion,
          platform: sanitizedInventory.platform,
          installations: sanitizedInventory.installations,
          warnings: sanitizedInventory.warnings,
        },
      }, null, 2),
    },
    { maxArtifactBytes, acceptedKinds: [...input.acceptedKinds] },
  );

  pushBugReportArtifact(
    artifacts,
    {
      filename: `${sanitizeBugReportArtifactFileSegment('support')}-daemon.json`,
      sourceKind: 'daemon',
      contentType: 'application/json',
      content: JSON.stringify({
        services: sanitizedInventory.services.filter((entry) => entry.kind === 'daemon'),
      }, null, 2),
    },
    { maxArtifactBytes, acceptedKinds: [...input.acceptedKinds] },
  );

  pushBugReportArtifact(
    artifacts,
    {
      filename: `${sanitizeBugReportArtifactFileSegment('support')}-stack-service.json`,
      sourceKind: 'stack-service',
      contentType: 'application/json',
      content: JSON.stringify({
        services: sanitizedInventory.services.filter((entry) => entry.kind === 'stack-service'),
      }, null, 2),
    },
    { maxArtifactBytes, acceptedKinds: [...input.acceptedKinds] },
  );

  if (sanitizedInventory.note?.trim()) {
    pushBugReportArtifact(
      artifacts,
      {
        filename: `${sanitizeBugReportArtifactFileSegment('support')}-note.txt`,
        sourceKind: 'user-note',
        contentType: 'text/plain',
        content: sanitizedInventory.note.trim(),
      },
      { maxArtifactBytes, acceptedKinds: [...input.acceptedKinds] },
    );
  }

  return artifacts;
}
