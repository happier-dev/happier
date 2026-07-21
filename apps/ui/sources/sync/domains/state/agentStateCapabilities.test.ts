import { describe, expect, it } from 'vitest';

import {
    getPermissionsInUiWhileLocal,
    getStructuredQuestionAnswersV1Supported,
    getModelScopedConfigTombstonesV1Supported,
} from '@/sync/domains/state/agentStateCapabilities';

describe('getPermissionsInUiWhileLocal', () => {
    it('returns true when permissionsInUiWhileLocal is true', () => {
        expect(getPermissionsInUiWhileLocal({ permissionsInUiWhileLocal: true })).toBe(true);
    });

    it('returns true when the legacy localPermissionBridgeInLocalMode capability is true', () => {
        expect(getPermissionsInUiWhileLocal({ localPermissionBridgeInLocalMode: true })).toBe(true);
    });

    it('returns false when no capability is set', () => {
        expect(getPermissionsInUiWhileLocal(null)).toBe(false);
        expect(getPermissionsInUiWhileLocal(undefined)).toBe(false);
        expect(getPermissionsInUiWhileLocal({})).toBe(false);
    });
});

describe('getModelScopedConfigTombstonesV1Supported', () => {
    it('fails closed unless support is literal true', () => {
        expect(getModelScopedConfigTombstonesV1Supported({ modelScopedConfigTombstonesV1: true })).toBe(true);
        expect(getModelScopedConfigTombstonesV1Supported({ modelScopedConfigTombstonesV1: false })).toBe(false);
        expect(getModelScopedConfigTombstonesV1Supported({ modelScopedConfigTombstonesV1: 'true' })).toBe(false);
        expect(getModelScopedConfigTombstonesV1Supported(undefined)).toBe(false);
    });
});

describe('getStructuredQuestionAnswersV1Supported', () => {
    it('treats only literal true as support', () => {
        expect(getStructuredQuestionAnswersV1Supported({ structuredQuestionAnswersV1Supported: true })).toBe(true);
        expect(getStructuredQuestionAnswersV1Supported({ structuredQuestionAnswersV1Supported: false })).toBe(false);
        expect(getStructuredQuestionAnswersV1Supported(undefined)).toBe(false);
    });
});
