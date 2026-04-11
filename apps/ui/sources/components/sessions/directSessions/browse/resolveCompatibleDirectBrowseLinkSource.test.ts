import { describe, expect, it } from 'vitest';
import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolveCompatibleDirectBrowseLinkSource } from './resolveCompatibleDirectBrowseLinkSource';

describe('resolveCompatibleDirectBrowseLinkSource', () => {
    it('preserves the selected codex connected-service source when the candidate source points at a different service profile', () => {
        const selectedSource: DirectSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
        };
        const candidateSource: DirectSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'personal',
            homePath: '/tmp/personal-home',
        };

        expect(resolveCompatibleDirectBrowseLinkSource({
            selectedSource,
            candidateSource,
        })).toEqual(selectedSource);
    });

    it('allows the candidate codex source to add a compatible homePath to the selected source', () => {
        const selectedSource: DirectSessionsSource = {
            kind: 'codexHome',
            home: 'user',
        };
        const candidateSource: DirectSessionsSource = {
            kind: 'codexHome',
            home: 'user',
            homePath: '/tmp/custom-home',
        };

        expect(resolveCompatibleDirectBrowseLinkSource({
            selectedSource,
            candidateSource,
        })).toEqual(candidateSource);
    });

    it('preserves the selected OpenCode server when the candidate source points at a different base URL', () => {
        const selectedSource: DirectSessionsSource = {
            kind: 'opencodeServer',
            baseUrl: 'http://127.0.0.1:4096',
        };
        const candidateSource: DirectSessionsSource = {
            kind: 'opencodeServer',
            baseUrl: 'http://127.0.0.1:5000',
            directory: '/tmp/other',
        };

        expect(resolveCompatibleDirectBrowseLinkSource({
            selectedSource,
            candidateSource,
        })).toEqual(selectedSource);
    });
});
