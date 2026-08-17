import { describe, expect, it } from 'vitest';
import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { resolveCompatibleExternalSessionBrowseLinkSource } from './resolveCompatibleExternalSessionBrowseLinkSource';

describe('resolveCompatibleExternalSessionBrowseLinkSource', () => {
    it('preserves the selected source when no plugin compatibility resolver is declared', () => {
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
            connectedServiceProfileId: 'work',
            homePath: '/tmp/work-home',
        };

        expect(resolveCompatibleExternalSessionBrowseLinkSource({
            selectedSource,
            candidateSource,
        })).toEqual(selectedSource);
    });

    it('uses the candidate only when the plugin compatibility resolver accepts it', () => {
        const selectedSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'user',
        };
        const candidateSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'user',
            homePath: '/tmp/custom-home',
        };

        const resolveCompatibleLinkSource = () => candidateSource;

        expect(resolveCompatibleExternalSessionBrowseLinkSource({
            selectedSource,
            candidateSource,
            resolveCompatibleLinkSource,
        })).toEqual(candidateSource);
    });

    it('preserves the selected source when the plugin compatibility resolver rejects the candidate', () => {
        const selectedSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'member-a',
            connectedServiceGroupId: 'primary-pool',
        };
        const candidateSource: ExternalSessionsSource = {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'member-b',
            connectedServiceGroupId: 'other-pool',
        };

        expect(resolveCompatibleExternalSessionBrowseLinkSource({
            selectedSource,
            candidateSource,
            resolveCompatibleLinkSource: () => null,
        })).toEqual(selectedSource);
    });

});
