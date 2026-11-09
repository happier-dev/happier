import { describe, expect, it } from 'vitest';

import {
    resolveFirstPartyLegacyAgentConnectedAccountServiceId,
    resolveFirstPartyLegacyRequestAuthServiceId,
    resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput,
} from './connectedAccountPurposeCompatibility';

describe('resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput', () => {
    it('preserves generated Agent operation eligibility without authorizing SCM or unknown services', () => {
        const codex = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        expect(resolveFirstPartyLegacyAgentConnectedAccountServiceId(codex)).toBe('openai-codex');
        expect(resolveFirstPartyLegacyRequestAuthServiceId(codex)).toBe('openai-codex');
        for (const service of [
            { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
            { pluginId: 'external.service', localId: 'openai-codex' },
        ]) {
            expect(resolveFirstPartyLegacyAgentConnectedAccountServiceId(service)).toBeNull();
            expect(resolveFirstPartyLegacyRequestAuthServiceId(service)).toBeNull();
        }
    });

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
