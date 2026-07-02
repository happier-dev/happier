import { describe, expect, it } from 'vitest';
import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { resolveCompatibleExternalSessionBrowseLinkSource } from './resolveCompatibleExternalSessionBrowseLinkSource';

describe('resolveCompatibleExternalSessionBrowseLinkSource', () => {
    it('preserves the selected codex connected-service source when the candidate source points at a different service profile', () => {
        const selectedSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
        };
        const candidateSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'personal',
            homePath: '/tmp/personal-home',
        };

        expect(resolveCompatibleExternalSessionBrowseLinkSource({
            selectedSource,
            candidateSource,
        })).toEqual(selectedSource);
    });

    it('allows the candidate codex source to add a compatible homePath to the selected source', () => {
        const selectedSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'user',
        };
        const candidateSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'user',
            homePath: '/tmp/custom-home',
        };

        expect(resolveCompatibleExternalSessionBrowseLinkSource({
            selectedSource,
            candidateSource,
        })).toEqual(candidateSource);
    });

});
