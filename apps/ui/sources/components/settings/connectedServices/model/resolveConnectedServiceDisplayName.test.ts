import { describe, expect, it } from 'vitest';

import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import { resolveConnectedServiceDisplayName, resolveConnectedServiceShortName } from './resolveConnectedServiceDisplayName';

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

describe('resolveConnectedServiceShortName', () => {
    it('projects the descriptor short brand name for compact surfaces', () => {
        expect(resolveConnectedServiceShortName('openai-codex', (key) => key)).toBe('Codex');
        expect(resolveConnectedServiceShortName('claude-subscription', (key) => key)).toBe('Claude');
    });

    it('falls back to the localized display name when the registry has no short name', () => {
        const entry = getConnectedServiceRegistryEntry('bitbucket');

        expect(entry.shortName).toBeUndefined();
        expect(resolveConnectedServiceShortName('bitbucket', (key) => key)).toBe('connectedServices.fallbackName');
    });
});
