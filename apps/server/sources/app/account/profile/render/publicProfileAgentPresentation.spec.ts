import { describe, expect, it } from 'vitest';

import { publicProfileAgentPresentation } from './publicProfileAgentPresentation';

describe('public profile Agent presentation', () => {
    it('uses Usage catalog fallbacks for unattributed and configurable Agent ids', () => {
        expect(publicProfileAgentPresentation('legacy', 'light')).toEqual({
            id: 'legacy', name: 'Unknown', color: '#A3A3A8',
        });
        expect(publicProfileAgentPresentation('custom-acp', 'light')).toEqual({
            id: 'custom-acp', name: 'Custom ACP Agent', color: '#A3A3A8',
        });
        expect(publicProfileAgentPresentation('codex', 'dark')).toEqual({
            id: 'codex', name: 'Codex', color: '#3987e5',
        });
    });
});
