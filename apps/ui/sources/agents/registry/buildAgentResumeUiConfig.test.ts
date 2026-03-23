import { describe, expect, it } from 'vitest';

import { buildAgentResumeUiConfig } from './buildAgentResumeUiConfig';

describe('buildAgentResumeUiConfig', () => {
    it('fails closed when the agent manifest does not define resume support', () => {
        expect(buildAgentResumeUiConfig({
            agentId: 'missing-agent' as never,
            uiVendorResumeIdLabelKey: null,
            uiVendorResumeIdCopiedKey: null,
        })).toMatchObject({
            supportsVendorResume: false,
            experimental: false,
            vendorResumeIdField: null,
        });
    });
});
