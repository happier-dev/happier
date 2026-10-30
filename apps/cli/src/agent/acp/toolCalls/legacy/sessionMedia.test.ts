import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { AcpToolCallAccumulator } from '../AcpToolCallAccumulator';
import { LegacyAcpSessionMediaPublisher } from './sessionMedia';

describe('LegacyAcpSessionMediaPublisher', () => {
    it('deduplicates all published media until the owning session resets', () => {
        const messages: AgentMessage[] = [];
        const publisher = new LegacyAcpSessionMediaPublisher((message) => messages.push(message));
        const accumulator = new AcpToolCallAccumulator();
        const media = [{ type: 'image', mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=' }];
        const completed = (index: number) => {
            const emission = accumulator.observe({
                sessionId: 'session', turnId: 'turn', sidechainId: null, toolCallId: `image-${index}`,
                revision: 1, observedAtMs: index, source: 'tool_call_update',
                patch: { status: 'completed', rawOutput: media },
            });
            if (emission.kind !== 'terminal' || !emission.result) throw new Error('Expected completed media result');
            return emission.result;
        };
        const first = completed(0);
        publisher.publish(first, media, 'other');
        const imageCount = 1_025;
        for (let index = 1; index < imageCount; index += 1) publisher.publish(completed(index), media, 'other');
        publisher.publish(first, media, 'other');
        expect(messages.filter((message) => message.type === 'event' && message.name === 'session_media'))
            .toHaveLength(imageCount);
        publisher.reset();
        expect(publisher.size).toBe(0);
        publisher.publish(first, media, 'other');
        expect(messages.filter((message) => message.type === 'event' && message.name === 'session_media'))
            .toHaveLength(imageCount + 1);
        accumulator.dispose();
    });
});
