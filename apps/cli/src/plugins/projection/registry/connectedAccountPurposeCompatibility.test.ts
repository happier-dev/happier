import { describe, expect, it } from 'vitest';

import {
    resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput,
} from './connectedAccountPurposeCompatibility';

describe('resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput', () => {
    it('parses a released scalar service input and resolves its generated qualified owner', () => {
        expect(
            resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(
                'openai-codex',
            ),
        ).toEqual({
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        });
    });

    it('fails closed for a scalar outside the released service enum', () => {
        expect(
            resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(
                'unrecognized-service',
            ),
        ).toBeNull();
    });
});
