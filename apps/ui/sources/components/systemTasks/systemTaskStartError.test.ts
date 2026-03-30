import { describe, expect, it } from 'vitest';

import {
    isSystemTaskBridgeUnavailableError,
    readSystemTaskStartErrorMessage,
} from './systemTaskStartError';

describe('systemTaskStartError', () => {
    it('treats the canonical unavailable token as bridge-unavailable', () => {
        expect(isSystemTaskBridgeUnavailableError(new Error('system_tasks_unavailable'))).toBe(true);
    });

    it('does not classify unrelated bridge wording as bridge-unavailable', () => {
        expect(isSystemTaskBridgeUnavailableError(new Error('failed to start hsetup bridge probe'))).toBe(false);
    });

    it('returns a trimmed message for generic start failures', () => {
        expect(readSystemTaskStartErrorMessage(new Error('  failed to start hsetup  '))).toBe('failed to start hsetup');
    });
});
