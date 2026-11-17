import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';
import { resolveSessionHeaderPaint } from '@/components/sessions/shell/view/sessionHeaderPaint';
import { resolveToolRowPaint } from '@/components/tools/shell/views/toolRowPaint';
import { resolveTranscriptPaint } from '@/components/sessions/transcript/transcriptPaint';
import { resolveSessionRowPaint } from '@/components/sessions/shell/row/sessionRowPaint';
import { sessionRowTitleInk } from '@/components/sessions/shell/row/sessionRowTitleColorRole';
import { resolveSidebarPaint } from '@/components/navigation/shell/appRail/sidebarPaint';
import { resolveTabBarPaint, tabBarLabelPaint } from '@/components/ui/navigation/tabBarPaint';
import { resolveSelectionListPaint } from '@/components/ui/selectionList/selectionListPaint';

describe('content surface paint provenance', () => {
    it('keeps direct title ink tied to the actual editable token after a theme change', () => {
        const theme = { ...lightTheme, colors: { ...lightTheme.colors,
            text: { ...lightTheme.colors.text, primary: '#193251', secondary: '#517293' },
            chrome: { ...lightTheme.colors.chrome, header: { ...lightTheme.colors.chrome.header, foreground: '#714923' } },
        } };
        expect(resolveSessionHeaderPaint(theme, 'title').foreground).toEqual({ color: '#714923', source: { kind: 'token', ref: 'chrome.header.foreground' } });
        expect(resolveToolRowPaint(theme, 'title').foreground).toEqual({ color: '#193251', source: { kind: 'token', ref: 'text.primary' } });
        expect(resolveToolRowPaint(theme, 'detail').foreground).toEqual({ color: '#517293', source: { kind: 'token', ref: 'text.secondary' } });
    });

    it('does not mistake transparent wrappers or supplied Markdown ink for editable base paint', () => {
        expect(resolveSessionHeaderPaint(lightTheme, 'facts').background).toEqual({ color: 'transparent', source: { kind: 'fixed' } });
        expect(resolveTranscriptPaint(lightTheme, 'assistant-text', 'root').background.source).toEqual({ kind: 'fixed' });
        expect(resolveTranscriptPaint(lightTheme, 'user-bubble', 'text').foreground.source).toEqual({ kind: 'token', ref: 'text.primary' });
        expect(resolveTranscriptPaint(lightTheme, 'user-bubble', 'text', '#172939').foreground).toEqual({ color: '#172939', source: { kind: 'fixed' } });
    });

    it('does not infer an instance-dependent row or tab source from its selected state', () => {
        expect(resolveSessionRowPaint(lightTheme, 'title', 'selected').foreground.source).toEqual({ kind: 'fixed' });
        const offline = resolveSessionRowPaint(lightTheme, 'title', 'default', { titleRole: 'tertiary' });
        expect(offline.foreground).toEqual({ color: sessionRowTitleInk(lightTheme.colors, 'tertiary'), source: { kind: 'token', ref: 'text.tertiary' } });
        expect(resolveTabBarPaint(lightTheme, 'label', 'selected').foreground.source).toEqual({ kind: 'fixed' });
        expect(tabBarLabelPaint(lightTheme, true)).toEqual({ color: lightTheme.colors.text.primary, source: { kind: 'token', ref: 'text.primary' } });
        expect(resolveSelectionListPaint(lightTheme, 'row', 'selected', '#1947af').background).toEqual({ color: '#1947af', source: { kind: 'fixed' } });
        expect(resolveSelectionListPaint(lightTheme, 'provider').foreground.source).toEqual({ kind: 'token', ref: 'text.secondary' });
        expect(resolveSidebarPaint(lightTheme, 'header').background).toEqual({ color: 'transparent', source: { kind: 'fixed' } });
    });
});
