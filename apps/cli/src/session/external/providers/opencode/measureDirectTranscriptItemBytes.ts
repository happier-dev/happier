import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

export function measureDirectTranscriptItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
    return Buffer.byteLength(JSON.stringify(item), 'utf8');
}
