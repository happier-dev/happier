import { Modal } from '@/modal';
import { tLoose } from '@/text';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { createVoiceDiagnosticArtifactExportTarget } from './artifactExportTarget';
import type { VoiceDiagnosticsClient } from './client';

/** Settings and Actions share consent, exact-machine download and the OS save/share boundary. */
export async function exportVoiceDiagnosticArtifact(input: Readonly<{
  client: VoiceDiagnosticsClient;
  artifact: Awaited<ReturnType<VoiceDiagnosticsClient['status']>>['artifacts'][number];
  signal?: AbortSignal;
  isCurrent?: () => boolean | Promise<boolean>;
}>): Promise<'completed' | 'cancelled'> {
  const confirmed = await Modal.confirm(
    tLoose('settingsVoice.diagnostics.exportConfirmTitle'),
    tLoose('settingsVoice.diagnostics.exportConfirmBody'),
    { confirmText: tLoose('settingsVoice.diagnostics.exportAction') },
  );
  throwIfAborted(input.signal);
  if (!confirmed || await input.isCurrent?.() === false) return 'cancelled';
  const artifact = input.artifact;
  const name = `voice-diagnostic-${artifact.createdAtMs}-${artifact.direction}.${artifact.format}`;
  const target = await createVoiceDiagnosticArtifactExportTarget({ name, sizeBytes: artifact.byteLength });
  if (!target.ok) throw new Error(target.error);
  try {
    throwIfAborted(input.signal);
    if (await input.isCurrent?.() === false) return 'cancelled';
    const result = await input.client.downloadArtifact({ artifactId: artifact.id, destination: target.target.destination, signal: input.signal });
    if (!result.ok) throw new Error('voice_diagnostics_export_failed');
    throwIfAborted(input.signal);
    if (await input.isCurrent?.() === false) return 'cancelled';
    await target.target.complete(result.name);
    return 'completed';
  } finally {
    await target.target.cleanup();
  }
}
