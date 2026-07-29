import { describe, expect, it } from 'vitest';

import { readSessionPresentationAgentId } from './readSessionPresentationAgentId';

describe('readSessionPresentationAgentId', () => {
    it('reads layout-v1 Agent presentation only from the strict shared envelope', () => {
        expect(readSessionPresentationAgentId({
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                v: 1,
                agentPresentation: { agentId: 'claude' },
            },
            ownerMetadataView: null,
        })).toBe('claude');

        expect(readSessionPresentationAgentId({
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                flavor: 'codex',
                agentPresentation: { agentId: 'claude' },
            },
            ownerMetadataView: null,
        })).toBeNull();
    });

    it('does not let an owner-only runtime identity override layout-v1 shared presentation', () => {
        expect(readSessionPresentationAgentId({
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                agentPresentation: { agentId: 'pi' },
            },
            ownerMetadataView: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {},
                },
            },
        })).toBe('pi');
    });

    it('retains layout-0 legacy Agent identity resolution', () => {
        expect(readSessionPresentationAgentId({
            metadataLayoutVersion: 0,
            metadata: {
                flavor: 'codex',
            },
        })).toBe('codex');
    });

    it('fails closed for future layouts', () => {
        expect(readSessionPresentationAgentId({
            metadataLayoutVersion: 2,
            metadata: {
                v: 1,
                agentPresentation: { agentId: 'claude' },
            },
        })).toBeNull();
    });
});
