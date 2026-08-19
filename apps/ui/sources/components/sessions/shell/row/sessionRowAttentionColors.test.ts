import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';
import {
    resolveSessionRowAttentionIndicatorColor,
    resolveSessionRowAttentionStateColor,
} from './sessionRowAttentionColors';

describe('resolveSessionRowAttentionIndicatorColor', () => {
    it('draws the standing marker in muted ink so it never competes with a real signal', () => {
        const standing = resolveSessionRowAttentionIndicatorColor({ indicator: 'standing', theme: lightTheme });

        // The same ink the row's status sentence takes, so the marker and its
        // copy read as one line instead of a signal with a caption.
        expect(standing).toBe(lightTheme.colors.text.secondary);
        expect(standing).toBe(resolveSessionRowAttentionStateColor('quiet', lightTheme));
        expect(standing).not.toBe(resolveSessionRowAttentionIndicatorColor({ indicator: 'unread', theme: lightTheme }));
        expect(standing).not.toBe(resolveSessionRowAttentionIndicatorColor({ indicator: 'action', theme: lightTheme }));
    });
});
