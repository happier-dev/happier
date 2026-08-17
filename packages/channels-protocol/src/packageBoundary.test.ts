import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('Channels protocol public barrel', () => {
    it('projects the explicit V1 contribution contract from the root entry point', () => {
        expect(protocol.ConversationProvidersContributionPointV1).toMatchObject({
            maxContributionsPerContributor: 1,
            protocols: [{
                id: 'happier.channels/providers',
                version: 1,
            }],
        });
    });
});
