import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';

import { BugReportDiagnosticsPreviewModal, type BugReportDiagnosticsPreviewArtifact } from '../BugReportDiagnosticsPreviewModal';
import type { BugReportDiagnosticsArtifact } from '../bugReportDiagnostics';

function utf8ByteLength(value: string): number {
  try {
    const encoder = new TextEncoder();
    return encoder.encode(value).byteLength;
  } catch {
    return value.length;
  }
}

export function useBugReportDiagnosticsPreview(input: {
  disabled: boolean;
  includeDiagnostics: boolean;
  selectedKinds: string[];
  collectDiagnosticsArtifacts: () => Promise<{ artifacts: BugReportDiagnosticsArtifact[] }>;
}): {
  previewing: boolean;
  previewDisabled: boolean;
  handlePreview: () => Promise<void>;
} {
  const { disabled, includeDiagnostics, selectedKinds, collectDiagnosticsArtifacts } = input;
  const [previewing, setPreviewing] = React.useState(false);
  const previewDisabled = disabled || previewing || !includeDiagnostics || selectedKinds.length === 0;

  const handlePreview = React.useCallback(async () => {
    if (previewDisabled) return;

    setPreviewing(true);
    try {
      const collected = await collectDiagnosticsArtifacts();
      const artifacts: BugReportDiagnosticsPreviewArtifact[] = collected.artifacts.map((artifact) => ({
        filename: artifact.filename,
        sourceKind: artifact.sourceKind,
        contentType: artifact.contentType,
        sizeBytes: utf8ByteLength(String(artifact.content ?? '')),
        content: String(artifact.content ?? ''),
      }));

      Modal.show({
        component: BugReportDiagnosticsPreviewModal,
        props: {
          artifacts,
        },
        chrome: {
          kind: 'card',
          title: t('bugReports.composer.diagnostics.preview.title'),
          testID: 'bug-report-diagnostics-preview-modal',
          layout: 'fill',
          dimensions: { size: 'md', width: 560, maxHeightRatio: 0.92 },
        },
        closeOnBackdrop: true,
      });
    } catch (error) {
      await Modal.alert(
        t('bugReports.composer.alerts.previewUnavailableTitle'),
        error instanceof Error ? error.message : t('bugReports.composer.alerts.previewUnavailableBody'),
      );
    } finally {
      setPreviewing(false);
    }
  }, [collectDiagnosticsArtifacts, previewDisabled]);

  return {
    previewing,
    previewDisabled,
    handlePreview,
  };
}
