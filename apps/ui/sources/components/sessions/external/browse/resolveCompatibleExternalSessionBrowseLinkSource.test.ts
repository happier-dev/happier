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

    it('treats a codex connected-service group as identity across active-member rotation', () => {
        const selectedSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'member-a',
            connectedServiceGroupId: 'primary-pool',
        };
        const rotatedCandidate: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'member-b',
            connectedServiceGroupId: 'primary-pool',
            homePath: '/tmp/member-b',
        };
        const otherGroupCandidate: ExternalSessionsSource = {
            ...rotatedCandidate,
            connectedServiceProfileId: 'member-a',
            connectedServiceGroupId: 'other-pool',
        };

        expect(resolveCompatibleExternalSessionBrowseLinkSource({
            selectedSource,
            candidateSource: rotatedCandidate,
        })).toEqual(rotatedCandidate);
        expect(resolveCompatibleExternalSessionBrowseLinkSource({
            selectedSource,
            candidateSource: otherGroupCandidate,
        })).toEqual(selectedSource);
    });

});
