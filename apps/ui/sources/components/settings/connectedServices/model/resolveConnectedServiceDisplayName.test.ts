import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceDisplayNameKey } from './resolveConnectedServiceDisplayName';

describe('resolveConnectedServiceDisplayNameKey', () => {
    it('resolves a dedicated translation key for GitHub', () => {
        expect(resolveConnectedServiceDisplayNameKey('github')).toBe('connectedServices.serviceNames.github');
    });
});
