import { describe, expect, it } from 'vitest';

import { resolveMinimumInteractiveTargetSize } from './interactiveTargetSize';

describe('resolveMinimumInteractiveTargetSize', () => {
    it('uses the native platform minimum and keeps the stricter Android target', () => {
        expect(resolveMinimumInteractiveTargetSize('ios')).toBe(44);
        expect(resolveMinimumInteractiveTargetSize('web')).toBe(44);
        expect(resolveMinimumInteractiveTargetSize('android')).toBe(48);
    });
});
