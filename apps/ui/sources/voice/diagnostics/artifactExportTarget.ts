import { Platform } from 'react-native';

import { createNativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';
import type { BulkTransferFileDestination } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/bulkTransferFileDestination';

const MAX_BUFFERED_WEB_EXPORT_BYTES = 128 * 1024 * 1024;

export type VoiceDiagnosticArtifactExportTarget = Readonly<{
  destination: BulkTransferFileDestination;
  complete(name: string): Promise<void>;
  cleanup(): Promise<void>;
}>;

export async function createVoiceDiagnosticArtifactExportTarget(input: Readonly<{
  name: string;
  sizeBytes: number;
}>): Promise<Readonly<
  | { ok: true; target: VoiceDiagnosticArtifactExportTarget }
  | { ok: false; error: string }
>> {
  if (Platform.OS === 'web') {
    if (input.sizeBytes > MAX_BUFFERED_WEB_EXPORT_BYTES) {
      return { ok: false, error: 'voice_diagnostics_web_export_too_large' };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const cleanup = async () => { chunks.length = 0; bytes = 0; };
    return {
      ok: true,
      target: {
        destination: {
          writeBytes: async (chunk) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_BUFFERED_WEB_EXPORT_BYTES) throw new Error('voice_diagnostics_web_export_too_large');
            chunks.push(new Uint8Array(chunk));
          },
          close: async () => {},
          cleanup,
        },
        complete: async (name) => {
          const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
          chunks.length = 0;
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = name || input.name;
          anchor.rel = 'noopener noreferrer';
          anchor.style.display = 'none';
          document.body?.appendChild(anchor);
          anchor.click();
          setTimeout(() => anchor.remove(), 0);
          setTimeout(() => URL.revokeObjectURL(url), 1_000);
        },
        cleanup,
      },
    };
  }

  const sink = await createNativeCacheFileSink({
    directoryName: 'happier-voice-diagnostics-export',
    fileName: input.name,
  });
  if (!sink.ok) return sink;
  return {
    ok: true,
    target: {
      destination: sink,
      complete: async () => {
        const Sharing = await import('expo-sharing');
        if (!await Sharing.isAvailableAsync()) throw new Error('voice_diagnostics_share_unavailable');
        await Sharing.shareAsync(sink.fileUri);
      },
      cleanup: sink.cleanup,
    },
  };
}
