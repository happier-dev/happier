import { describe, expect, it } from 'vitest';

import { publishStructuredQuestionAnswersV1Capability } from './publishStructuredQuestionAnswersV1Capability';

describe('publishStructuredQuestionAnswersV1Capability', () => {
    it('preserves unrelated state while publishing the literal support hint', () => {
        const update = publishStructuredQuestionAnswersV1Capability({ requests: {}, capabilities: { inFlightSteer: true } });
        expect(update).toEqual({
            requests: {},
            capabilities: { inFlightSteer: true, structuredQuestionAnswersV1Supported: true },
        });
    });
});
