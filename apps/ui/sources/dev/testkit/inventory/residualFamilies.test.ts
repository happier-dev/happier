import { describe, expect, it } from 'vitest';

import {
    collectResidualFamilyCounts,
    collectResidualFileCounts,
    formatResidualFileHotspots,
    type ResidualInventoryEntry,
} from './residualFamilies';

function codeLine(...segments: string[]): string {
    return segments.join('');
}

function mockLine(moduleName: string, payload: string = '({})'): string {
    return codeLine("vi.mock('", moduleName, "', () => ", payload, ');');
}

function rendererCreateLine(componentName: string): string {
    return codeLine('renderer', '.create(<', componentName, ' />);');
}

function renderScreenLine(componentName: string): string {
    return codeLine('await render', 'Screen(<', componentName, ' />);');
}

function standardCleanupLine(): string {
    return codeLine('standard', 'Cleanup();');
}

function fakeTimersLine(): string {
    return codeLine('vi.useFake', 'Timers();');
}

function advanceTimersLine(milliseconds: number): string {
    return codeLine('vi.advanceTimersBy', 'Time(', String(milliseconds), ');');
}

function animationFrameLine(): string {
    return codeLine('requestAnimation', 'Frame(() => undefined);');
}

function microtaskFlushLine(): string {
    return codeLine('await Promise', '.resolve();');
}

function toJsonLine(): string {
    return codeLine('const tree = screen.tree', '.toJSON();');
}

function pressableTreeWalkLine(): string {
    return codeLine('tree', '.root', '.findAll', "ByType('Pressable');");
}

function testIdTreeWalkLine(): string {
    return codeLine('screen', '.root', '.findAll((node) => Boolean(node.props?.testID));');
}

function pressHandlerLine(): string {
    return codeLine('node', '.props', '.onPress();');
}

function testkitImportLine(...imports: string[]): string {
    return codeLine("import { ", imports.join(', '), " } from '@/dev", "/testkit';");
}

describe('collectResidualFamilyCounts', () => {
    it('counts residual families and canonical testkit adoption by area', () => {
        const entries: ResidualInventoryEntry[] = [
            {
                path: 'apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    mockLine('react-native'),
                    rendererCreateLine('ChatList'),
                    fakeTimersLine(),
                    advanceTimersLine(1000),
                    animationFrameLine(),
                    microtaskFlushLine(),
                    microtaskFlushLine(),
                    toJsonLine(),
                    pressableTreeWalkLine(),
                    pressHandlerLine(),
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/shell/SessionItem.activityTime.test.tsx',
                text: [
                    testkitImportLine('renderScreen', 'standardCleanup'),
                    mockLine('@/text', "({ t: (key: string) => key })"),
                    mockLine('@/modal', '({ Modal: {} })'),
                    mockLine('@/sync/domains/state/storage'),
                    renderScreenLine('SessionItem'),
                    standardCleanupLine(),
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/tools/shell/views/ToolView.test.tsx',
                text: [
                    testkitImportLine('renderScreen'),
                    mockLine('expo-router'),
                    renderScreenLine('ToolView'),
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

    it('reports top residual hotspot files with actionable ad hoc files ranked ahead of blocked hotspots', () => {
        const entries: ResidualInventoryEntry[] = [
            {
                path: 'apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    mockLine('react-native'),
                    mockLine('@/sync/domains/state/storage'),
                    rendererCreateLine('ChatList'),
                    fakeTimersLine(),
                    advanceTimersLine(1000),
                    animationFrameLine(),
                    microtaskFlushLine(),
                    pressableTreeWalkLine(),
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/shell/SessionView.directSessions.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    mockLine('react-native'),
                    mockLine('expo-router'),
                    mockLine('@/text', "({ t: (key: string) => key })"),
                    mockLine('@/modal', '({ Modal: {} })'),
                    rendererCreateLine('SessionView'),
                    fakeTimersLine(),
                    advanceTimersLine(250),
                    testIdTreeWalkLine(),
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/transcript/ChatList.jumpToBottom.test.tsx',
                text: [
                    testkitImportLine('renderScreen'),
                    renderScreenLine('ChatList'),
                ].join('\n'),
            },
        ];

        const fileSummaries = collectResidualFileCounts(entries);
        const formatted = formatResidualFileHotspots(fileSummaries, { limit: 2 });

        expect(fileSummaries.map((summary) => summary.path)).toEqual([
            'apps/ui/sources/components/sessions/shell/SessionView.directSessions.test.tsx',
            'apps/ui/sources/components/sessions/transcript/ChatList.flashListV2.test.tsx',
            'apps/ui/sources/components/sessions/transcript/ChatList.jumpToBottom.test.tsx',
        ]);
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
                    mockLine('react-native'),
                    mockLine('@/text', "({ t: (key: string) => key })"),
                    rendererCreateLine('MessageView'),
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/sessions/shell/SessionView.directSessions.test.tsx',
                text: [
                    "import renderer from 'react-test-renderer';",
                    "import { vi } from 'vitest';",
                    mockLine('react-native'),
                    mockLine('@/text', "({ t: (key: string) => key })"),
                    rendererCreateLine('SessionView'),
                    fakeTimersLine(),
                    advanceTimersLine(250),
                    testIdTreeWalkLine(),
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

    it('only marks files with ad hoc inline mock shapes as codemod eligible', () => {
        const entries: ResidualInventoryEntry[] = [
            {
                path: 'apps/ui/sources/components/settings/SettingsView.test.tsx',
                text: [
                    "import { vi } from 'vitest';",
                    codeLine("vi.mock('", '@/text', "', async () => {"),
                    codeLine("    const { createTextModuleMock } = await import('", '@/dev', "/testkit/mocks/text');"),
                    '    return createTextModuleMock().module;',
                    '});',
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/components/settings/SettingsViewLegacy.test.tsx',
                text: [
                    "import { vi } from 'vitest';",
                    mockLine('@/text', "({ t: (key: string) => key })"),
                ].join('\n'),
            },
        ];

        const summaries = collectResidualFileCounts(entries);
        const canonicalOnly = summaries.find((summary) => summary.path.endsWith('SettingsView.test.tsx'));
        const adHoc = summaries.find((summary) => summary.path.endsWith('SettingsViewLegacy.test.tsx'));

        expect(canonicalOnly).toMatchObject({
            codemodEligible: false,
        });
        expect(adHoc).toMatchObject({
            codemodEligible: true,
        });
    });

    it('prioritizes actionable ad hoc inline mock files ahead of canonical-only hotspots', () => {
        const entries: ResidualInventoryEntry[] = [
            {
                path: 'apps/ui/sources/components/settings/SettingsView.test.tsx',
                text: [
                    codeLine("vi.mock('", 'react-native', "', async () => {"),
                    codeLine("    const { createReactNativeWebMock } = await import('", '@/dev', "/testkit/mocks/reactNative');"),
                    '    return createReactNativeWebMock();',
                    '});',
                    codeLine("vi.mock('", 'react-native-unistyles', "', async () => {"),
                    codeLine("    const { createUnistylesMock } = await import('", '@/dev', "/testkit/mocks/unistyles');"),
                    '    return createUnistylesMock();',
                    '});',
                    codeLine("vi.mock('", '@/text', "', async () => {"),
                    codeLine("    const { createTextModuleMock } = await import('", '@/dev', "/testkit/mocks/text');"),
                    '    return createTextModuleMock().module;',
                    '});',
                    codeLine("vi.mock('", '@/modal', "', async () => {"),
                    codeLine("    const { createModalModuleMock } = await import('", '@/dev', "/testkit/mocks/modal');"),
                    '    return createModalModuleMock().module;',
                    '});',
                    codeLine("vi.mock('", 'expo-router', "', async () => {"),
                    codeLine("    const { createExpoRouterMock } = await import('", '@/dev', "/testkit/mocks/router');"),
                    '    return createExpoRouterMock().module;',
                    '});',
                    codeLine("vi.mock('", '@/sync/domains/state/storage', "', async (importOriginal) => {"),
                    codeLine("    const { createStorageModuleMock } = await import('", '@/dev', "/testkit/mocks/storage');"),
                    '    return createStorageModuleMock({ importOriginal, overrides: {} });',
                    '});',
                ].join('\n'),
            },
            {
                path: 'apps/ui/sources/__tests__/app/new/pick/profile.secretRequirementNavigation.test.ts',
                text: [
                    mockLine('react-native'),
                    codeLine("vi.mock('", '@/text', "', async () => {"),
                    codeLine("    const { createTextModuleMock } = await import('", '@/dev', "/testkit/mocks/text');"),
                    '    return createTextModuleMock().module;',
                    '});',
                    codeLine("vi.mock('", '@/modal', "', () => modalMock.module);"),
                    codeLine("vi.mock('", 'expo-router', "', async () => {"),
                    codeLine("    const { createExpoRouterMock } = await import('", '@/dev', "/testkit/mocks/router');"),
                    '    return createExpoRouterMock().module;',
                    '});',
                    codeLine("vi.mock('", '@/sync/domains/state/storage', "', async (importOriginal) => {"),
                    codeLine("    const { createStorageModuleMock } = await import('", '@/dev', "/testkit/mocks/storage');"),
                    '    return createStorageModuleMock({ importOriginal, overrides: {} });',
                    '});',
                ].join('\n'),
            },
        ];

        const summaries = collectResidualFileCounts(entries);

        expect(summaries[0]?.path).toBe('apps/ui/sources/__tests__/app/new/pick/profile.secretRequirementNavigation.test.ts');
        expect(summaries[0]?.inlineMockShapes).toMatchObject({
            adHoc: 2,
        });
        expect(summaries[1]?.inlineMockShapes).toMatchObject({
            canonical: 6,
            adHoc: 0,
        });
    });
});
