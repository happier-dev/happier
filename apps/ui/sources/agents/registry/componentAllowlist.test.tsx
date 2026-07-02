import { describe, expect, it } from 'vitest';

import { resolveFirstPartyUiComponent } from './componentAllowlist';

describe('resolveFirstPartyUiComponent', () => {
    it('resolves first-party component ids through the host allowlist', () => {
        const resolved = resolveFirstPartyUiComponent('firstParty.claude.subagentLaunchCards');

        expect(resolved.diagnostic).toBeUndefined();
        expect(resolved.render).toBeTypeOf('function');
    });

    it('fails closed with a stable diagnostic for unknown component ids', () => {
        const resolved = resolveFirstPartyUiComponent('firstParty.acme.unknown');

        expect(resolved.render).toBeNull();
        expect(resolved.diagnostic).toMatchObject({
            code: 'A16X1_UNKNOWN_COMPONENT_ID',
            path: 'componentId',
        });
    });
});
