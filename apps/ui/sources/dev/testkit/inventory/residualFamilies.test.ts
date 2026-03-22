import { describe, expect, it } from 'vitest';

import {
    collectResidualFamilyCounts,
    collectResidualFileCounts,
    formatResidualFileHotspots,
    type ResidualInventoryEntry,
} from './residualFamilies';

describe('collectResidualFamilyCounts', () => {
    it('counts residual families and canonical testkit adoption by area', () => {
        const entries: ResidualInventoryEntry[] = [
            {
                path: 'apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    "vi.mock('react-native', () => ({}));",
                    "renderer.create(<ChatList />);",
                    'vi.useFakeTimers();',
                    'vi.advanceTimersByTime(1000);',
                    'requestAnimationFrame(() => undefined);',
                    'await Promise.resolve();',
                    'await Promise.resolve();',
                    'const tree = screen.tree.toJSON();',
                    "tree.root.findAllByType('Pressable');",
                    'node.props.onPress();',
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/shell/SessionItem.activityTime.test.tsx',
                text: [
                    "import { renderScreen, standardCleanup } from '@/dev/testkit';",
                    "vi.mock('@/text', () => ({ t: (key: string) => key }));",
                    "vi.mock('@/modal', () => ({ Modal: {} }));",
                    "vi.mock('@/sync/domains/state/storage', () => ({}));",
                    'await renderScreen(<SessionItem />);',
                    'standardCleanup();',
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/tools/shell/views/ToolView.test.tsx',
                text: [
                    "import { renderScreen } from '@/dev/testkit';",
                    "vi.mock('expo-router', () => ({}));",
                    'await renderScreen(<ToolView />);',
                ].join('\n'),
            },
        ];

        const summary = collectResidualFamilyCounts(entries);

        expect(summary.totals.files).toBe(3);
        expect(summary.totals.rendererCreate).toBe(1);
        expect(summary.totals.renderScreen).toBe(2);
        expect(summary.totals.standardCleanup).toBe(1);
        expect(summary.totals.useFakeTimers).toBe(1);
        expect(summary.totals.advanceTimers).toBe(1);
        expect(summary.totals.requestAnimationFrame).toBe(1);
        expect(summary.totals.microtaskFlush).toBe(2);
        expect(summary.totals.toJSON).toBe(1);
        expect(summary.totals.onPressTreeWalk).toBe(2);
        expect(summary.totals.rootTreeWalk).toBe(1);
        expect(summary.totals.testkitImports).toBe(2);
        expect(summary.totals.inlineMocks.reactNative).toBe(1);
        expect(summary.totals.inlineMocks.text).toBe(1);
        expect(summary.totals.inlineMocks.modal).toBe(1);
        expect(summary.totals.inlineMocks.storage).toBe(1);
        expect(summary.totals.inlineMocks.router).toBe(1);
        expect(summary.areas.transcript.rendererCreate).toBe(1);
        expect(summary.areas.sessionShell.standardCleanup).toBe(1);
        expect(summary.areas.toolShell.testkitImports).toBe(1);
    });

    it('reports top residual hotspot files in descending score order', () => {
        const entries: ResidualInventoryEntry[] = [
            {
                path: 'apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    "vi.mock('react-native', () => ({}));",
                    "vi.mock('@/sync/domains/state/storage', () => ({}));",
                    "renderer.create(<ChatList />);",
                    'vi.useFakeTimers();',
                    'vi.advanceTimersByTime(1000);',
                    'requestAnimationFrame(() => undefined);',
                    'await Promise.resolve();',
                    "tree.root.findAllByType('Pressable');",
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/shell/SessionView.directSessions.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    "vi.mock('react-native', () => ({}));",
                    "vi.mock('expo-router', () => ({}));",
                    "vi.mock('@/text', () => ({ t: (key: string) => key }));",
                    "vi.mock('@/modal', () => ({ Modal: {} }));",
                    'renderer.create(<SessionView />);',
                    'vi.useFakeTimers();',
                    'vi.advanceTimersByTime(250);',
                    'screen.root.findAll((node) => Boolean(node.props?.testID));',
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/transcript/ChatList.jumpToBottom.test.tsx',
                text: [
                    "import { renderScreen } from '@/dev/testkit';",
                    'await renderScreen(<ChatList />);',
                ].join('\n'),
            },
        ];

        const fileSummaries = collectResidualFileCounts(entries);
        const formatted = formatResidualFileHotspots(fileSummaries, { limit: 2 });

        expect(fileSummaries.map((summary) => summary.path)).toEqual([
            'apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx',
            'apps/ui/sources/components/sessions/shell/SessionView.directSessions.test.tsx',
            'apps/ui/sources/components/sessions/transcript/ChatList.jumpToBottom.test.tsx',
        ]);
        expect(fileSummaries[0]?.hotspotScore).toBeGreaterThan(fileSummaries[1]?.hotspotScore ?? 0);
        expect(fileSummaries[1]?.hotspotScore).toBeGreaterThan(fileSummaries[2]?.hotspotScore ?? 0);
        expect(formatted).toContain('topFiles:');
        expect(formatted).toContain('ChatList.flashListV2.test.tsx');
        expect(formatted).toContain('SessionView.directSessions.test.tsx');
        expect(formatted).toContain('directory=apps/ui/sources/components/sessions/transcript');
        expect(formatted).toContain('directory=apps/ui/sources/components/sessions/shell');
        expect(formatted).toContain('family=ChatList.flashListV2');
        expect(formatted).toContain('family=SessionView.directSessions');
        expect(formatted).toContain('codemodEligible=false');
        expect(formatted).toContain('codemodBlockers=timerChoreography,selectorDrift');
        expect(formatted).toContain('microtaskFlush=1');
        expect(formatted).toContain('rootTreeWalk=1');
        expect(formatted).not.toContain('ChatList.jumpToBottom.test.tsx');
    });

    it('marks renderer and inline-mock files without timer or selector churn as codemod eligible', () => {
        const entries: ResidualInventoryEntry[] = [
            {
                path: 'apps/ui/sources/components/sessions/transcript/MessageView.copyButtonHitSlop.web.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    "vi.mock('react-native', () => ({}));",
                    "vi.mock('@/text', () => ({ t: (key: string) => key }));",
                    "renderer.create(<MessageView />);",
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/shell/SessionView.directSessions.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    "vi.mock('react-native', () => ({}));",
                    "vi.mock('@/text', () => ({ t: (key: string) => key }));",
                    'renderer.create(<SessionView />);',
                    'vi.useFakeTimers();',
                    'vi.advanceTimersByTime(250);',
                    "screen.root.findAll((node) => Boolean(node.props?.testID));",
                ].join('\n'),
            },
        ];

        const summaries = collectResidualFileCounts(entries);
        const eligible = summaries.find((summary) => summary.path.endsWith('MessageView.copyButtonHitSlop.web.test.tsx'));
        const blocked = summaries.find((summary) => summary.path.endsWith('SessionView.directSessions.test.tsx'));

        expect(eligible).toMatchObject({
            directory: 'apps/ui/sources/components/sessions/transcript',
            family: 'MessageView.copyButtonHitSlop.web',
            codemodEligible: true,
            codemodBlockers: [],
        });
        expect(blocked).toMatchObject({
            directory: 'apps/ui/sources/components/sessions/shell',
            family: 'SessionView.directSessions',
            codemodEligible: false,
            codemodBlockers: ['timerChoreography', 'selectorDrift'],
        });
    });
});
