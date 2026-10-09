import { describe, expect, it } from 'vitest';
import { createToolCallMessageFixture } from '@/dev/testkit';
import { isToolCallMessageGroupableInTranscript } from './isToolCallMessageGroupableInTranscript';

describe('transcript tool group admission', () => {
    it('keeps an unanswered permission outside disclosure without excluding ordinary tools', () => {
        const ordinary = createToolCallMessageFixture();
        const approval = createToolCallMessageFixture({ tool: { ...ordinary.tool,
            permission: { id: 'approval', status: 'pending', kind: 'permission' },
        } });
        expect(isToolCallMessageGroupableInTranscript(ordinary)).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(approval)).toBe(false);
    });
});
