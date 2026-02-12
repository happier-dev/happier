import * as React from 'react';

import { Modal } from '@/modal';

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

      const Wrapper = ({ onClose }: { onClose: () => void }) => (
        <BugReportDiagnosticsPreviewModal artifacts={artifacts} onClose={onClose} />
      );

      Modal.show({
        component: Wrapper,
        props: {},
      });
    } catch (error) {
      await Modal.alert('Preview unavailable', error instanceof Error ? error.message : 'Could not build diagnostics preview.');
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
