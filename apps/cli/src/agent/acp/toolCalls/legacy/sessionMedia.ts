import type { AgentMessage } from '@/agent/core/AgentMessage';

import { extractAcpMediaContentBlocks } from '../../media/extractAcpMediaContentBlocks';
import type { MergedAcpToolResult } from '../types';

const MAX_MEDIA_FINGERPRINTS = 1_024;

export class LegacyAcpSessionMediaPublisher {
    private readonly publishedFingerprints = new Set<string>();

    constructor(private readonly emit: (message: AgentMessage) => void) {}

    publish(result: MergedAcpToolResult, value: unknown, callKind: string | null): void {
        const source = callKind === 'mcp' || result.toolName.startsWith('mcp__') ? 'mcp-content' : 'tool-output';
        const extracted = extractAcpMediaContentBlocks(value, {
            originSource: source,
            toolCallId: result.toolCallId,
        });
        const fingerprint = `${result.localId}\0${JSON.stringify(extracted.media)}`;
        if (extracted.media.length > 0 && !this.publishedFingerprints.has(fingerprint)) {
            this.publishedFingerprints.add(fingerprint);
            while (this.publishedFingerprints.size > MAX_MEDIA_FINGERPRINTS) {
                const oldest = this.publishedFingerprints.values().next().value;
                if (typeof oldest !== 'string') break;
                this.publishedFingerprints.delete(oldest);
            }
            this.emit({
                type: 'event',
                name: 'session_media',
                payload: {
                    localId: `acp-media-${result.localId}`,
                    role: 'output',
                    category: 'tool-artifact',
                    media: extracted.media,
                },
            });
        }
        if (extracted.diagnostics.length > 0) {
            this.emit({
                type: 'event',
                name: 'session_media_diagnostics',
                payload: { diagnostics: extracted.diagnostics },
            });
        }
    }

    reset(): void {
        this.publishedFingerprints.clear();
    }

    get size(): number {
        return this.publishedFingerprints.size;
    }
}
