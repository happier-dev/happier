import { describe, expect, it } from 'vitest';

import {
    DEFAULT_TERMINAL_INTERACTION_POLICY,
    resolveOsc52ClipboardAction,
    resolveUnsupportedRichProtocolAction,
} from './security';

describe('terminal interaction security policy', () => {
    it('denies OSC52 clipboard writes by default', () => {
        expect(resolveOsc52ClipboardAction(DEFAULT_TERMINAL_INTERACTION_POLICY)).toEqual({
            kind: 'deny',
            reason: 'osc52_denied',
        });
    });

    it('classifies unsupported rich protocol payloads without exposing payload content', () => {
        expect(resolveUnsupportedRichProtocolAction('kitty-graphics', DEFAULT_TERMINAL_INTERACTION_POLICY)).toEqual({
            kind: 'unsupported',
            protocol: 'kitty-graphics',
        });
    });
});
