import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/theme', () => ({
    lightTheme: {
        colors: {
            success: '#0f0',
            textSecondary: '#666',
            textTertiary: '#999',
            divider: '#ddd',
            surfaceHigh: '#f5f5f5',
            accent: { orange: '#f90' },
        },
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => {
        return key;
    } });
});

describe('buildDirectBrowseCandidatePresentation', () => {
    it('renders full-path metadata with item-aligned text hierarchy and hides remote ids when a meaningful title exists', async () => {
        const { buildDirectBrowseCandidateSubtitle } = await import('./buildDirectBrowseCandidatePresentation');
        const mockTheme = {
            colors: {
                success: '#0f0',
                textSecondary: '#666',
                textTertiary: '#999',
                divider: '#ddd',
                surfaceHigh: '#f5f5f5',
                accent: { orange: '#f90' },
            },
        } as any;

        const subtitle = buildDirectBrowseCandidateSubtitle({
            remoteSessionId: 'codex-session-1',
            title: 'Improve browse session UX',
            updatedAtMs: 1_700_000_000_000,
            activity: 'active_recently',
            details: {
                path: '/Users/leeroy/Documents/Development/happier/dev',
            },
        }, mockTheme, 'compact');

        expect(React.isValidElement(subtitle)).toBe(true);
        expect((subtitle as any).type).toBe('Text');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement('View', null, subtitle))).tree;
        const textNodes = tree.root.findAllByType('Text');
        expect(String(textNodes[1]?.props?.children)).toMatch(/\d+y ago/);
        expect(textNodes[1]?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: '#666' })]));
        expect(String(textNodes[3]?.props?.children)).toBe('/Users/leeroy/Documents/Development/happier/dev');
        expect(textNodes[3]?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: '#999' })]));
        expect(JSON.stringify(tree.toJSON())).not.toContain('codex-session-1');
    });

    it('falls back to the remote session id when there is no meaningful title or path', async () => {
        const { buildDirectBrowseCandidateDisplayTitle, buildDirectBrowseCandidateSubtitle } = await import('./buildDirectBrowseCandidatePresentation');
        const mockTheme = {
            colors: {
                success: '#0f0',
                textSecondary: '#666',
                textTertiary: '#999',
                divider: '#ddd',
                surfaceHigh: '#f5f5f5',
                accent: { orange: '#f90' },
            },
        } as any;

        expect(buildDirectBrowseCandidateDisplayTitle({
            remoteSessionId: 'sess_raw_1',
            updatedAtMs: 1_700_000_000_000,
        })).toBe('sess_raw_1');
        const subtitle = buildDirectBrowseCandidateSubtitle({
            remoteSessionId: 'sess_raw_1',
            updatedAtMs: 1_700_000_000_000,
            activity: 'idle',
        }, mockTheme, 'compact');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement('View', null, subtitle))).tree;
        expect(JSON.stringify(tree.toJSON())).toContain('sess_raw_1');
    });

    it('shows running now instead of a stale relative timestamp for running sessions', async () => {
        const { buildDirectBrowseCandidateSubtitle } = await import('./buildDirectBrowseCandidatePresentation');
        const mockTheme = {
            colors: {
                success: '#0f0',
                textSecondary: '#666',
                textTertiary: '#999',
                divider: '#ddd',
                surfaceHigh: '#f5f5f5',
                accent: { orange: '#f90' },
            },
        } as any;

        const subtitle = buildDirectBrowseCandidateSubtitle({
            remoteSessionId: 'sess_live_1',
            title: 'Live codex session',
            updatedAtMs: 1_700_000_000_000,
            activity: 'running',
            details: {
                cwd: '/tmp/happier/dev',
            },
        }, mockTheme, 'compact');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement('View', null, subtitle))).tree;
        expect(JSON.stringify(tree.toJSON())).toContain('directSessions.browseActivityRunningNow');
        expect(JSON.stringify(tree.toJSON())).toContain('/tmp/happier/dev');
        expect(JSON.stringify(tree.toJSON())).not.toContain('3y ago');
    });
});
