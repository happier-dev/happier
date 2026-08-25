import { describe, expect, it } from 'vitest';

import { resolveSessionDraftsFeature } from './sessionDraftsFeature';

describe('resolveSessionDraftsFeature', () => {
    it('defaults on and honors an explicit fail-closed operator disable', () => {
        expect(resolveSessionDraftsFeature({}).features?.sessions?.drafts?.enabled).toBe(true);
        expect(resolveSessionDraftsFeature({
            HAPPIER_FEATURE_SESSIONS_DRAFTS__ENABLED: '0',
        }).features?.sessions?.drafts?.enabled).toBe(false);
    });
});
