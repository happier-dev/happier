import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServersSettingsV1, SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListAccessory,
    SelectionListSectionDescriptor,
    SelectionListStep,
} from '@/components/ui/selectionList';
import { createCapturingComponent, createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { installPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedSelectionListProps = SelectionListProps;
type StaticSelectionListSection = Extract<SelectionListSectionDescriptor, { kind: 'static' }>;

const capturedSelectionLists: CapturedSelectionListProps[] = [];

const mcpServersSettingsFixture: McpServersSettingsV1 = {
    v: 1,
    strictMode: false,
    servers: [
        {
            id: 'server-playwright',
            name: 'playwright',
            title: 'playwright',
            transport: 'stdio',
            stdio: { command: 'playwright', args: [] },
            env: {},
            createdAt: 1,
            updatedAt: 2,
        },
    ],
    bindings: [
        {
            id: 'binding-all',
            serverId: 'server-playwright',
            enabled: true,
            target: { t: 'allMachines' },
            createdAt: 1,
            updatedAt: 2,
        },
    ],
};
const emptyMcpServersSettingsFixture: McpServersSettingsV1 = {
    v: 1,
    strictMode: false,
    servers: [],
    bindings: [],
};

let currentMcpServersSettings: McpServersSettingsV1 = mcpServersSettingsFixture;

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    reactNative: () => createReactNativeWebMock({
        View: createPassThroughComponent('View'),
        Pressable: createPassThroughComponent('Pressable'),
        ActivityIndicator: createPassThroughComponent('ActivityIndicator'),
    }),
    text: () => createTextModuleMock({
        translate: (key) => key,
    }),
    unistyles: () => createUnistylesMock({
        theme: {
            colors: {
                background: { canvas: '#f5f5f5' },
                border: { default: '#ddd' },
                surface: { base: '#fff', pressed: '#eee' },
                text: { primary: '#111', secondary: '#666', tertiary: '#999' },
                switch: {
                    track: { active: '#0a7', inactive: '#ddd' },
                    thumb: { active: '#fff' },
                },
            },
        },
    }),
    storage: installPartialStorageModuleMock({
        useSetting: ((key: string) => {
            if (key === 'mcpServersSettingsV1') return currentMcpServersSettings;
            return undefined;
        }) as never,
    }),
});

vi.mock('@/components/ui/selectionList', () => ({
    SelectionList: createCapturingComponent('SelectionList', (props) => {
        capturedSelectionLists.push(props as CapturedSelectionListProps);
    }),
    resolvePopoverSelectionListHeightBehavior: () => 'measuredToMaxHeight',
    StatusPill: createPassThroughComponent('StatusPill'),
}));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemListStatic']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));
vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getAgentCore: () => ({
            tools: {
                delivery: 'full',
            },
            displayNameKey: 'agents.mock.displayName',
        }),
    };
});

vi.mock('@/components/settings/mcpServers/mcpServerUi', () => ({
    resolveAgentToolsDeliveryDescription: () => 'Tool delivery description',
    resolveAgentToolsDeliveryLabel: () => 'Tool delivery label',
    resolveAuthBadgeLabel: () => 'Auth',
    resolveManagedServerAuthMode: () => 'Auth',
    resolveDetectedAvailabilityLabel: () => 'Detected',
    resolvePreviewScopeLabel: () => 'Scope',
}));

vi.mock('@/components/sessions/new/modules/sessionMcpSelectionState', () => ({
    setManagedSessionMcpServersEnabled: vi.fn((selection: SessionMcpSelectionV1, enabled: boolean) => ({
        ...selection,
        managedServersEnabled: enabled,
    })),
    toggleManagedSessionMcpSelection: vi.fn((selection: SessionMcpSelectionV1, entry: { serverId: string; selected?: boolean }) => ({
        ...selection,
        forceIncludeServerIds: entry.selected ? [] : [entry.serverId],
        forceExcludeServerIds: entry.selected ? [entry.serverId] : [],
    })),
}));

function selection(): SessionMcpSelectionV1 {
    return {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: [],
        forceExcludeServerIds: [],
    };
}

function requireSelectionList(): CapturedSelectionListProps {
    expect(capturedSelectionLists).toHaveLength(1);
    return capturedSelectionLists[0]!;
}

function staticSections(step: SelectionListStep): StaticSelectionListSection[] {
    return step.sections.filter((section): section is StaticSelectionListSection => section.kind === 'static');
}

function requireSection(step: SelectionListStep, sectionId: string): StaticSelectionListSection {
    const section = staticSections(step).find((candidate) => candidate.id === sectionId);
    expect(section).toBeTruthy();
    return section!;
}

function requireOption(section: StaticSelectionListSection, optionId: string): SelectionListOption {
    const option = section.options.find((candidate) => candidate.id === optionId);
    expect(option).toBeTruthy();
    return option!;
}

function expectDisplayOnlyOption(
    step: SelectionListStep,
    sectionId: string,
    optionId: string,
): void {
    const option = requireOption(requireSection(step, sectionId), optionId);
    expect(option.disabled).toBe(true);
    expect(option.onSelect).toBeUndefined();
}

function optionIds(section: StaticSelectionListSection): string[] {
    return section.options.map((option) => option.id);
}

function renderAccessory(accessory: SelectionListAccessory | undefined): React.ReactNode {
    return typeof accessory === 'function' ? accessory() : accessory;
}

function collectTestIds(accessory: SelectionListAccessory | undefined): string[] {
    const out: string[] = [];
    const walk = (value: React.ReactNode): void => {
        if (value == null || typeof value === 'boolean') return;
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (React.isValidElement(value)) {
            const props = value.props as { testID?: unknown; children?: React.ReactNode };
            if (typeof props.testID === 'string') out.push(props.testID);
            walk(props.children);
        }
    };
    walk(renderAccessory(accessory));
    return out;
}

function findElementByTestId(accessory: SelectionListAccessory | undefined, testID: string): React.ReactElement | null {
    let found: React.ReactElement | null = null;
    const walk = (value: React.ReactNode): void => {
        if (found !== null || value == null || typeof value === 'boolean') return;
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (React.isValidElement(value)) {
            const props = value.props as { testID?: unknown; children?: React.ReactNode };
            if (props.testID === testID) {
                found = value;
                return;
            }
            walk(props.children);
        }
    };
    walk(renderAccessory(accessory));
    return found;
}

async function renderMcpContent(overrides: Partial<React.ComponentProps<typeof import('./NewSessionMcpSelectionContent')['NewSessionMcpSelectionContent']>> = {}) {
    const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');

    return renderScreen(<NewSessionMcpSelectionContent
        machineId="machine-1"
        machineName="Builder"
        directory="/repo"
        agentType="claude"
        hasContext={true}
        preview={{
            ok: true,
            builtIn: [],
            managed: [],
            detected: [],
        }}
        selection={selection()}
        loading={false}
        error={null}
        onSelectionChange={() => {}}
        onRefresh={() => {}}
        onOpenSettings={() => {}}
        maxHeight={520}
        {...overrides}
    />);
}

describe('NewSessionMcpSelectionContent', () => {
    beforeEach(() => {
        capturedSelectionLists.length = 0;
        currentMcpServersSettings = mcpServersSettingsFixture;
    });

    it('renders the MCP rows through SelectionList with a measured native popover height cap', async () => {
        const screen = await renderMcpContent();

        const list = requireSelectionList();
        expect(list.testID).toBe('new-session.mcp.selection-list');
        expect(list.maxHeight).toBe(520);
        expect(list.heightBehavior).toBe('measuredToMaxHeight');
        expect(list.keyboardHintsEnabled).toBe(false);

        const container = screen.findAllByType('View' as never)[0];
        expect(container?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ maxHeight: 520 }),
        ]));
    });

    it('passes refresh and settings actions through section header accessories', async () => {
        await renderMcpContent({
            loading: true,
            preview: {
                ok: true,
                builtIn: [],
                managed: [],
                detected: [{
                    key: 'detected:claude:sequential-thinking',
                    name: 'sequential-thinking',
                    transport: 'stdio',
                    authMode: 'unknown',
                    selected: true,
                    selectable: false,
                    availability: 'readOnly',
                    sourceKind: 'detected',
                    scopeKind: 'providerUser',
                    provider: 'claude',
                    enabled: true,
                    envKeyCount: 0,
                    headerKeyCount: 0,
                    sourcePath: '/Users/test/.claude/config.json',
                }],
            },
        });

        const step = requireSelectionList().rootStep;
        const happierSection = requireSection(step, 'happier');
        const detectedSection = requireSection(step, 'detected');

        expect(collectTestIds(happierSection.headerRightAccessory)).toEqual(expect.arrayContaining([
            'new-session.mcp.happier.refresh',
            'new-session.mcp.happier.open-settings',
        ]));
        expect(collectTestIds(detectedSection.headerRightAccessory)).toEqual([
            'new-session.mcp.detected.refresh',
        ]);
        expect(findElementByTestId(
            detectedSection.headerRightAccessory,
            'new-session.mcp.detected.refresh',
        )?.props).toEqual(expect.objectContaining({
            loading: true,
        }));
    });

    it('does not expose detected preview rows when session context is unavailable', async () => {
        await renderMcpContent({
            machineId: null,
            machineName: null,
            directory: '',
            hasContext: false,
            preview: {
                ok: true,
                builtIn: [],
                managed: [],
                detected: [{
                    key: 'detected:claude:sequential-thinking',
                    name: 'sequential-thinking',
                    transport: 'stdio',
                    authMode: 'unknown',
                    selected: true,
                    selectable: false,
                    availability: 'readOnly',
                    sourceKind: 'detected',
                    scopeKind: 'providerUser',
                    provider: 'claude',
                    enabled: true,
                    envKeyCount: 0,
                    headerKeyCount: 0,
                    sourcePath: '/Users/test/.claude/config.json',
                }],
            },
        });

        const sections = staticSections(requireSelectionList().rootStep);
        expect(sections.flatMap((section) => optionIds(section))).toContain('new-session.mcp.empty');
        expect(sections.flatMap((section) => optionIds(section))).not.toContain('new-session.mcp.detected.sequential-thinking');
        expectDisplayOnlyOption(requireSelectionList().rootStep, 'no-context', 'new-session.mcp.empty');
    });

    it('omits built-in delivery while keeping managed and detected rows', async () => {
        await renderMcpContent({
            preview: {
                ok: true,
                builtIn: [{
                    key: 'built-in:happier',
                    name: 'happier',
                    title: 'Happier',
                    transport: 'stdio',
                    authMode: 'none',
                    selected: true,
                    selectable: false,
                    availability: 'active',
                    sourceKind: 'builtIn',
                    scopeKind: 'builtIn',
                }],
                managed: [{
                    key: 'managed:playwright',
                    serverId: 'server-playwright',
                    name: 'playwright',
                    title: 'Playwright',
                    transport: 'stdio',
                    authMode: 'none',
                    selected: true,
                    selectable: true,
                    availability: 'active',
                    sourceKind: 'managed',
                    scopeKind: 'allMachines',
                    reasonCode: 'active_by_default',
                    portability: 'portable',
                    defaultSelected: true,
                }],
                detected: [{
                    key: 'detected:claude:sequential-thinking',
                    name: 'sequential-thinking',
                    transport: 'stdio',
                    authMode: 'unknown',
                    selected: true,
                    selectable: false,
                    availability: 'readOnly',
                    sourceKind: 'detected',
                    scopeKind: 'providerUser',
                    provider: 'claude',
                    enabled: true,
                    envKeyCount: 0,
                    headerKeyCount: 0,
                    sourcePath: '/Users/test/.claude/config.json',
                }],
            },
        });

        const sections = staticSections(requireSelectionList().rootStep);
        const ids = sections.flatMap((section) => optionIds(section));
        expect(ids).not.toContain('new-session.mcp.built-in.happier');
        expect(ids).toEqual(expect.arrayContaining([
            'new-session.mcp.managed-enabled',
            'new-session.mcp.row.server-playwright',
            'new-session.mcp.detected.sequential-thinking',
        ]));

        const detected = requireOption(requireSection(requireSelectionList().rootStep, 'detected'), 'new-session.mcp.detected.sequential-thinking');
        expect(detected.subtitle).toBe('Scope · Auth');
        expect(React.isValidElement(detected.rightAccessory)).toBe(true);
        expect(detected.rightAccessory).toEqual(expect.objectContaining({
            props: expect.objectContaining({
                testID: 'new-session.mcp.detected.sequential-thinking.status',
            }),
        }));
        expectDisplayOnlyOption(requireSelectionList().rootStep, 'detected', 'new-session.mcp.detected.sequential-thinking');
    });

    it('keeps the managed enabled toggle and server toggle as selectable options', async () => {
        const onSelectionChange = vi.fn();
        await renderMcpContent({ onSelectionChange });

        const happierSection = requireSection(requireSelectionList().rootStep, 'happier');
        const managedToggle = requireOption(happierSection, 'new-session.mcp.managed-enabled');
        const serverToggle = requireOption(happierSection, 'new-session.mcp.row.server-playwright');

        expect(managedToggle.disabled).toBeFalsy();
        expect(managedToggle.testID).toBe('new-session.mcp.managed-enabled');
        managedToggle.onSelect?.();
        expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({
            managedServersEnabled: false,
        }));

        serverToggle.onSelect?.();
        expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({
            forceExcludeServerIds: ['server-playwright'],
        }));
    });

    it('keeps the provider empty row when Happier servers exist but preview resolves empty', async () => {
        await renderMcpContent();

        const ids = staticSections(requireSelectionList().rootStep).flatMap((section) => optionIds(section));
        expect(ids).not.toContain('new-session.mcp.empty');
        expect(ids).toContain('new-session.mcp.detected-empty');
        expect(ids).toContain('new-session.mcp.row.server-playwright');
        expectDisplayOnlyOption(requireSelectionList().rootStep, 'detected', 'new-session.mcp.detected-empty');
    });

    it('collapses provider and Happier empty states into a single actionable row when no MCP servers exist anywhere', async () => {
        currentMcpServersSettings = emptyMcpServersSettingsFixture;

        await renderMcpContent();

        const sections = staticSections(requireSelectionList().rootStep);
        const ids = sections.flatMap((section) => optionIds(section));
        expect(ids).toContain('new-session.mcp.happier-empty');
        expect(ids).not.toContain('new-session.mcp.empty');
        expect(ids).not.toContain('new-session.mcp.detected-empty');
        expectDisplayOnlyOption(requireSelectionList().rootStep, 'happier', 'new-session.mcp.happier-empty');
    });

    it('preserves detected unsupported and error state rows', async () => {
        await renderMcpContent({
            previewUnsupported: true,
        });
        expect(optionIds(requireSection(requireSelectionList().rootStep, 'detected'))).toContain('new-session.mcp.detected-unsupported');
        expectDisplayOnlyOption(requireSelectionList().rootStep, 'detected', 'new-session.mcp.detected-unsupported');

        capturedSelectionLists.length = 0;
        await renderMcpContent({
            error: 'preview failed',
        });
        const detectedError = requireOption(requireSection(requireSelectionList().rootStep, 'detected'), 'new-session.mcp.detected-error');
        expect(detectedError.subtitle).toBe('preview failed');
        expectDisplayOnlyOption(requireSelectionList().rootStep, 'detected', 'new-session.mcp.detected-error');
    });
});

/**
 * The MCP chip hosts this content through `renderContent({ maxHeight })`, and
 * `useNewSessionMcpSelection` rebuilds the props object it spreads in whenever
 * its own `params` object literal changes — which is every render of the new
 * session screen. So `onSelectionChange` / `onRefresh` / `onOpenSettings`
 * arrive with fresh identities constantly, while the DATA behind the list is
 * unchanged.
 */
const STABLE_PREVIEW: PreviewSuccessFixture = {
    ok: true,
    builtIn: [],
    managed: [],
    detected: [],
};
const STABLE_SELECTION: SessionMcpSelectionV1 = {
    v: 1,
    managedServersEnabled: true,
    forceIncludeServerIds: [],
    forceExcludeServerIds: [],
};

type PreviewSuccessFixture = React.ComponentProps<
    typeof import('./NewSessionMcpSelectionContent')['NewSessionMcpSelectionContent']
>['preview'];

type McpChurningHandlers = Readonly<{
    selectionSpy: ReturnType<typeof vi.fn>;
    refreshSpy: ReturnType<typeof vi.fn>;
    settingsSpy: ReturnType<typeof vi.fn>;
    onSelectionChange: (next: SessionMcpSelectionV1) => void;
    onRefresh: () => void;
    onOpenSettings: () => void;
}>;

/**
 * `React.ReactElement['props']` is `unknown`, so narrow it to the one prop this
 * assertion drives rather than reaching through it untyped.
 */
function pressAccessoryButton(accessory: SelectionListAccessory | undefined, testID: string): void {
    const button = findElementByTestId(accessory, testID);
    expect(button).not.toBeNull();
    const buttonProps = button?.props as { onPress?: () => void } | undefined;
    expect(typeof buttonProps?.onPress).toBe('function');
    buttonProps?.onPress?.();
}

function makeMcpChurningHandlers(): McpChurningHandlers {
    const selectionSpy = vi.fn();
    const refreshSpy = vi.fn();
    const settingsSpy = vi.fn();
    return {
        selectionSpy,
        refreshSpy,
        settingsSpy,
        onSelectionChange: (next) => selectionSpy(next),
        onRefresh: () => refreshSpy(),
        onOpenSettings: () => settingsSpy(),
    };
}

describe('NewSessionMcpSelectionContent model stability', () => {
    beforeEach(() => {
        capturedSelectionLists.length = 0;
        currentMcpServersSettings = mcpServersSettingsFixture;
    });

    async function element(handlers: McpChurningHandlers, selectionValue = STABLE_SELECTION) {
        const { NewSessionMcpSelectionContent } = await import('./NewSessionMcpSelectionContent');
        return (
            <NewSessionMcpSelectionContent
                machineId="machine-1"
                machineName="Builder"
                directory="/repo"
                agentType="claude"
                hasContext={true}
                preview={STABLE_PREVIEW}
                selection={selectionValue}
                loading={false}
                error={null}
                onSelectionChange={handlers.onSelectionChange}
                onRefresh={handlers.onRefresh}
                onOpenSettings={handlers.onOpenSettings}
                maxHeight={520}
            />
        );
    }

    it('reuses the built step tree and header accessories when only handler identities change', async () => {
        const rendered = await renderScreen(await element(makeMcpChurningHandlers()));
        await rendered.update(await element(makeMcpChurningHandlers()));

        expect(capturedSelectionLists.length).toBeGreaterThanOrEqual(2);
        const first = capturedSelectionLists[0]!;
        const last = capturedSelectionLists[capturedSelectionLists.length - 1]!;

        // Handlers are behaviour, not data. Rebuilding the step tree for them
        // throws away every option object plus the memoised header accessory
        // elements, so React can no longer skip those subtrees on re-render.
        expect(last.rootStep).toBe(first.rootStep);
        expect(last.rootStep.sections).toBe(first.rootStep.sections);
        expect(requireSection(last.rootStep, 'happier').headerRightAccessory)
            .toBe(requireSection(first.rootStep, 'happier').headerRightAccessory);

        await rendered.unmount();
    });

    it('routes activations to the LATEST handlers after the host replaced them', async () => {
        const initial = makeMcpChurningHandlers();
        const rendered = await renderScreen(await element(initial));
        const next = makeMcpChurningHandlers();
        await rendered.update(await element(next));

        const step = capturedSelectionLists[capturedSelectionLists.length - 1]!.rootStep;
        const happierSection = requireSection(step, 'happier');
        requireOption(happierSection, 'new-session.mcp.managed-enabled').onSelect?.();
        pressAccessoryButton(happierSection.headerRightAccessory, 'new-session.mcp.happier.refresh');
        pressAccessoryButton(happierSection.headerRightAccessory, 'new-session.mcp.happier.open-settings');

        expect(next.selectionSpy).toHaveBeenCalledTimes(1);
        expect(next.refreshSpy).toHaveBeenCalledTimes(1);
        expect(next.settingsSpy).toHaveBeenCalledTimes(1);
        expect(initial.selectionSpy).not.toHaveBeenCalled();
        expect(initial.refreshSpy).not.toHaveBeenCalled();
        expect(initial.settingsSpy).not.toHaveBeenCalled();

        await rendered.unmount();
    });

    it('still rebuilds the step tree when the selection data actually changes', async () => {
        const handlers = makeMcpChurningHandlers();
        const rendered = await renderScreen(await element(handlers));
        const before = capturedSelectionLists[capturedSelectionLists.length - 1]!.rootStep;

        await rendered.update(await element(handlers, {
            ...STABLE_SELECTION,
            managedServersEnabled: false,
        }));
        const after = capturedSelectionLists[capturedSelectionLists.length - 1]!.rootStep;

        expect(after).not.toBe(before);

        await rendered.unmount();
    });
});
