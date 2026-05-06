import { describe, expect, it } from 'vitest';

import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import { resolveConnectedServiceDisplayName } from './resolveConnectedServiceDisplayName';

describe('resolveConnectedServiceDisplayName', () => {
    it('projects the service display name from the connected service registry metadata', () => {
        const entry = getConnectedServiceRegistryEntry('claude-subscription');

        expect(resolveConnectedServiceDisplayName('claude-subscription', (key) => key)).toBe(entry.displayNameKey);
    });

    it('projects the GitHub display name from descriptor metadata', () => {
        const entry = getConnectedServiceRegistryEntry('github');

        expect(resolveConnectedServiceDisplayName('github', (key) => key)).toBe(entry.displayNameKey);
    });
});
