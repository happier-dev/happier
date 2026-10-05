import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

import type { AgentExecutionTargetV1 } from '@happier-dev/protocol';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { Settings } from '@/sync/domains/settings/settings';

/**
 * The shared authoring controls are controlled and inert: values in, one
 * `onChangeField` out. These cases pin the three things a second authoring
 * surface historically got wrong — silently dropping a field it cannot offer,
 * smuggling a submit action into an authoring row, and writing a remembered
 * preference as a side effect of choosing a value.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const keyboardHandlerRegistrations: Array<Record<string, unknown>> = [];
const applySettingsSpy = vi.hoisted(() => vi.fn());

// The Account's own settings are a storage boundary. Which settings this
// Account holds decides whether the Connected Services owner seeds its
// default-auth preview, so they are supplied here rather than mocked away
// below the owner.
const accountSettings = vi.hoisted(() => ({ current: null as Settings | null }));

installAgentInputCommonModuleMocks({
    storage: async () => {
        const [{ createStorageModuleStub, createUseSettingMock }, { settingsDefaults }] = await Promise.all([
            import('@/dev/testkit/mocks/storage'),
            import('@/sync/domains/settings/settings'),
        ]);
        const readSettings = (): Settings => accountSettings.current ?? settingsDefaults;
        return createStorageModuleStub({
            useSettings: () => readSettings(),
            useSetting: createUseSettingMock({ fallback: (key) => readSettings()[key] }),
        });
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            Platform: { OS: 'web', select: (value: any) => value.default ?? value.web },
            useWindowDimensions: () => ({ width: 900, height: 700 }),
            Dimensions: { get: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }) },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

// The MCP owner's boundaries: the server-owned feature decision, the daemon
// preview RPC, the overlay shell and the heavy selection panel. The chip, its
// controlled value adaptation and the reported selection stay real.
const mcpPreviewSpy = vi.hoisted(() => vi.fn());
const mcpContentProps = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));
vi.mock('@/sync/ops/machineMcpServers', () => ({
    machineMcpServersPreview: (...args: unknown[]) => {
        mcpPreviewSpy(...args);
        return Promise.resolve({ ok: true, detected: [], managed: [], happier: [] });
    },
}));
vi.mock('@/components/sessions/agentInput/components/AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: { open: boolean; content: unknown }) => (
        props.open
            ? React.createElement('AgentInputContentPopoverStub', null,
                typeof props.content === 'function'
                    ? (props.content as (args: unknown) => React.ReactNode)({ requestClose: () => {}, maxHeight: 400 })
                    : (props.content as React.ReactNode))
            : null
    ),
}));
vi.mock('@/components/sessions/new/components/NewSessionMcpSelectionContent', () => ({
    NewSessionMcpSelectionContent: (props: Record<string, unknown>) => {
        mcpContentProps.value = props;
        return React.createElement('NewSessionMcpSelectionContentStub', { testID: 'mcp-content-stub' });
    },
}));
// The Connected Services selection panel is the same kind of heavy boundary as
// the MCP one. Its props — the supported services, the current bindings, the
// Team resources it may offer and the setter it calls — are the behaviour under
// test, so they are captured rather than re-rendered.
const connectedServicesContentProps = vi.hoisted(() => ({ value: null as any }));
// The Home's Team credential catalog is a transport-backed snapshot boundary.
// Which resources reach the selection panel — and the currentness filter that
// decides it — stay real.
const teamCredentialCatalog = vi.hoisted(() => ({
    resources: [] as Array<Record<string, unknown>>,
    currentResourceKeys: new Set<string>(),
    teamNameById: {} as Record<string, string>,
}));
vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
    useHomeTeamCredentialModelCatalog: () => ({
        resources: teamCredentialCatalog.resources,
        currentResourceKeys: teamCredentialCatalog.currentResourceKeys,
        teamNameById: teamCredentialCatalog.teamNameById,
        homeNameByTeamId: {},
        current: true,
    }),
}));
vi.mock('@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent', () => ({
    NewSessionConnectedServicesSelectionContent: (props: Record<string, unknown>) => {
        connectedServicesContentProps.value = props;
        return React.createElement('NewSessionConnectedServicesSelectionContentStub', {
            testID: 'connected-services-content-stub',
        });
    },
}));
// The popover shell is a platform boundary (portal + window measurement). The
// option descriptors it is handed are the behaviour under test.
vi.mock('@/components/sessions/agentInput/components/AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: (props: Record<string, unknown>) =>
        React.createElement('AgentInputSelectionListPopoverStub', props, null),
}));

vi.mock('@/keyboard', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/keyboard')>();
    return {
        ...actual,
        useKeyboardShortcutHandlers: (handlers: Record<string, unknown>) => {
            keyboardHandlerRegistrations.push(handlers ?? {});
        },
    };
});

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/settings/settings')>();
    return {
        ...actual,
        applySettings: (...args: unknown[]) => {
            applySettingsSpy(...args);
            return (actual.applySettings as (...a: unknown[]) => unknown)(...args);
        },
    };
});

const CLAUDE_TARGET: AgentExecutionTargetV1 = {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function baseValues(): WorkflowSessionAuthoringSelection {
    return { agentTarget: CLAUDE_TARGET };
}

function directCapableClaude(supportsDirectTranscriptStorage = true) {
    return {
        id: 'agent:happier.agent.claude/claude',
        label: 'Claude Code',
        target: CLAUDE_TARGET,
        agentId: 'claude',
        supportsDirectTranscriptStorage,
    };
}

/** The Agent's own Connected Account declaration, as the catalog projects it. */
const GITHUB_DECLARATION = {
    service: { pluginId: 'happier.connect.github', localId: 'github' },
    purpose: 'auth',
} as never;

function claudeWithGithubDeclaration() {
    return { ...directCapableClaude(), connectedAccounts: [GITHUB_DECLARATION] };
}

/** A second declared service, so "untouched by this edit" is observable. */
const LINEAR_DECLARATION = {
    service: { pluginId: 'happier.connect.linear', localId: 'linear' },
    // Purpose ids are unique within one consumer contribution
    // (`ConnectedAccountPurposeDeclarationsV1Schema`).
    purpose: 'linear-auth',
} as never;

const GITHUB_SERVICE_KEY = 'happier.connect.github/github';
const LINEAR_SERVICE_KEY = 'happier.connect.linear/linear';

function claudeWithTwoDeclarations() {
    return { ...directCapableClaude(), connectedAccounts: [GITHUB_DECLARATION, LINEAR_DECLARATION] };
}

/** This Account's own per-Agent default Connected Service auth. */
const ACCOUNT_DEFAULT_AUTH_BINDINGS = {
    [GITHUB_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'gh-work' },
    [LINEAR_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'lin-work' },
} as const;

async function seedAccountDefaultConnectedServiceAuth(): Promise<void> {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    accountSettings.current = {
        ...settingsDefaults,
        connectedServicesDefaultAuthByAgentIdV1: {
            v: 1,
            bindingsByAgentId: {
                claude: { v: 1, bindingsByServiceId: { ...ACCOUNT_DEFAULT_AUTH_BINDINGS } },
            },
        },
    };
}

/** Opens the chip's panel and returns the bindings it was handed. */
async function readPanelBindings(
    screen: Awaited<ReturnType<typeof renderControls>>['screen'],
): Promise<Record<string, unknown>> {
    await act(async () => { screen.pressByTestId('new-session-connected-services-auth-chip'); });
    return connectedServicesContentProps.value?.bindingsByServiceId as Record<string, unknown>;
}

async function renderControls(overrides: Partial<React.ComponentProps<
    typeof import('./SessionAuthoringControls')['SessionAuthoringControls']
>> = {}) {
    const { SessionAuthoringControls } = await import('./SessionAuthoringControls');
    const onChangeField = vi.fn();
    const screen = await renderScreen(
        <SessionAuthoringControls
            fields={['permissionMode']}
            values={baseValues()}
            onChangeField={onChangeField}
            {...overrides}
        />,
    );
    return { screen, onChangeField };
}

/** Invokes the option a reader would tap inside the opened picker. */
function selectOption(screen: Awaited<ReturnType<typeof renderControls>>['screen'], optionId: string) {
    const popovers = screen.root.findAll(
        (node) => Boolean(node.props?.open) && node.props?.rootStep !== undefined,
        { deep: true },
    );
    const rootStep = popovers.at(-1)?.props?.rootStep as {
        sections: Array<{ options: Array<{ id: string; onSelect?: () => void }> }>;
    } | undefined;
    if (!rootStep) throw new Error('no open picker');
    const option = rootStep.sections.flatMap((section) => section.options).find((entry) => entry.id === optionId);
    if (!option?.onSelect) throw new Error(`option ${optionId} is not selectable`);
    option.onSelect();
}

// Module transform is paid once, outside any single case's time budget.
beforeAll(async () => {
    await import('./SessionAuthoringControls');
}, 300_000);

describe('SessionAuthoringControls', () => {
    beforeEach(() => {
        accountSettings.current = null;
        connectedServicesContentProps.value = null;
    });

    it('shows a field it cannot offer as explicitly unavailable', async () => {
        // MCP selection belongs to another owner. Without that owner's control
        // the field must still be visible as unavailable — a missing chip reads
        // as "this step has no MCP setting", which is a different claim.
        const { screen } = await renderControls({ fields: ['mcpSelection'] });

        expect(screen.findByTestId('session-authoring-control-mcpSelection-unavailable')).toBeTruthy();
        await screen.unmount();
    });

    it('exposes no submit affordance and registers no composer send command', async () => {
        keyboardHandlerRegistrations.length = 0;
        const { screen } = await renderControls({
            fields: ['permissionMode', 'transcriptStorage'],
            facts: { agentTargets: [directCapableClaude()] },
        });

        const submitLike = screen.root.findAll((node) => (
            typeof node.props?.testID === 'string' && /send|submit/i.test(node.props.testID)
        ), { deep: true });
        expect(submitLike).toHaveLength(0);

        const registeredCommandIds = keyboardHandlerRegistrations.flatMap((handlers) => Object.keys(handlers));
        expect(registeredCommandIds).not.toContain('composer.sendImmediate');

        await screen.unmount();
    });

    it('presents one field model as chips or as labelled field rows, and marks a changed field', async () => {
        const chips = await renderControls({
            fields: ['permissionMode', 'transcriptStorage'],
            facts: { agentTargets: [directCapableClaude()] },
            overriddenFields: new Set(['permissionMode']),
            overriddenAccessibilityHint: 'Changed for this step',
        });
        const permissionChip = chips.screen.root.find((node) => (
            node.props?.testID === 'session-authoring-control-permissionMode' && typeof node.props?.onPress === 'function'
        ));
        // Changed-here is a state of the chip trigger itself, not a second control.
        expect(permissionChip.props.accessibilityHint).toBe('Changed for this step');
        const storageChip = chips.screen.root.findAll((node) => (
            node.props?.testID === 'session-authoring-control-transcriptStorage' && typeof node.props?.onPress === 'function'
        ));
        for (const node of storageChip) expect(node.props.accessibilityHint).toBeUndefined();
        await chips.screen.unmount();

        const fields = await renderControls({ fields: ['permissionMode'], presentation: 'fields' });
        const row = fields.screen.findByTestId('session-authoring-control-permissionMode-row');
        expect(row).not.toBeNull();
        // The row names the field; its trigger opens the very same picker and reports the same value.
        expect(fields.screen.getTextContent()).toContain('settingsSession.permissions.title');
        await act(async () => { fields.screen.pressByTestId('session-authoring-control-permissionMode'); });
        await act(async () => { selectOption(fields.screen, 'yolo'); });
        expect(fields.onChangeField).toHaveBeenCalledWith('permissionMode', 'yolo');
        await fields.screen.unmount();
    });

    it('reports the chosen permission mode without writing any preference', async () => {
        applySettingsSpy.mockClear();
        const { screen, onChangeField } = await renderControls({ fields: ['permissionMode'] });

        await act(async () => { screen.pressByTestId('session-authoring-control-permissionMode'); });
        await act(async () => { selectOption(screen, 'yolo'); });

        expect(onChangeField).toHaveBeenCalledWith('permissionMode', 'yolo');
        // Choosing in an authoring surface is not a "remembered selection".
        expect(applySettingsSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('binds a chosen model exactly the way ordinary Session authoring binds it', async () => {
        const { updateSessionAuthoringDraftModelMode } = await import(
            '@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields'
        );
        const { screen, onChangeField } = await renderControls({
            fields: ['modelSelection'],
            values: baseValues(),
        });

        await act(async () => { screen.pressByTestId('session-authoring-control-modelSelection'); });
        const rootStep = screen.root.findAll(
            (node) => Boolean(node.props?.open) && node.props?.rootStep !== undefined,
            { deep: true },
        ).at(-1)?.props?.rootStep as { sections: Array<{ options: Array<{ id: string }> }> };
        const modelId = rootStep.sections
            .flatMap((section) => section.options)
            .map((option) => option.id)
            .find((id) => id !== 'default');
        expect(modelId).toBeTruthy();

        await act(async () => { selectOption(screen, modelId as string); });

        const newSessionSelection = updateSessionAuthoringDraftModelMode(
            { agentTarget: CLAUDE_TARGET } as never,
            modelId as never,
            1234,
        ).modelSelection;
        const [, authoredSelection] = onChangeField.mock.calls.at(-1) as [string, { ref: unknown }];
        // Same picker, same binding: the exact same target-bound reference.
        expect(authoredSelection.ref).toEqual(newSessionSelection?.ref);

        await screen.unmount();
    });

    /**
     * Direct transcripts are an Agent-on-this-Machine capability, answered by
     * the selected Agent's own option rather than a surface-wide flag: the same
     * surface offers the choice for one Agent and states it unavailable for
     * another, and choosing reports the canonical value.
     */
    it('offers transcript storage only for an Agent that supports direct transcripts on this Machine', async () => {
        const unsupported = await renderControls({
            fields: ['transcriptStorage'],
            facts: { agentTargets: [directCapableClaude(false)] },
        });
        expect(unsupported.screen.findByTestId('session-authoring-control-transcriptStorage-unavailable')).toBeTruthy();
        await unsupported.screen.unmount();

        const { screen, onChangeField } = await renderControls({
            fields: ['transcriptStorage'],
            facts: { agentTargets: [directCapableClaude(true)] },
        });
        expect(screen.findByTestId('session-authoring-control-transcriptStorage-unavailable')).toBeNull();
        await act(async () => { screen.pressByTestId('session-authoring-control-transcriptStorage'); });
        await act(async () => { selectOption(screen, 'direct'); });
        expect(onChangeField).toHaveBeenCalledWith('transcriptStorage', 'direct');
        await screen.unmount();
    });

    /**
     * The MCP selection is edited through the incumbent New Session MCP owner
     * — its chip, its preview against the exact Machine and folder for the
     * resolved Agent, and its selection panel — adapted to the controlled
     * value. The reported value is the canonical selection policy object.
     */
    it('edits the MCP selection through the incumbent New Session MCP owner for the resolved Agent', async () => {
        mcpPreviewSpy.mockClear();
        const { screen, onChangeField } = await renderControls({
            fields: ['mcpSelection'],
            values: { agentTarget: CLAUDE_TARGET, mcpSelection: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['review-tools'], forceExcludeServerIds: [] } },
            facts: {
                agentTargets: [directCapableClaude()],
                mcp: { machineId: 'machine-1', machineName: 'Mac Studio', directory: '/Users/me/project', serverId: 'server-a', enabled: true },
            },
        });
        await act(async () => {});
        expect(screen.findByTestId('session-authoring-control-mcpSelection-unavailable')).toBeNull();
        expect(screen.findByTestId('new-session-mcp-chip')).toBeTruthy();
        expect(mcpPreviewSpy).not.toHaveBeenCalled();
        // Native/web press intent precedes onPress; the render harness only
        // dispatches onPress automatically, so deliver its genuine event too.
        await act(async () => { screen.findByTestId('new-session-mcp-chip')?.props.onPressIn(); });
        await act(async () => { screen.pressByTestId('new-session-mcp-chip'); });
        // The preview is asked for this Agent on this exact Machine and folder,
        // with the controlled selection — the same request New Session makes.
        expect(mcpPreviewSpy).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                agentId: 'claude',
                directory: '/Users/me/project',
                selection: expect.objectContaining({ forceIncludeServerIds: ['review-tools'] }),
            }),
            expect.objectContaining({ serverId: 'server-a' }),
        );

        expect(screen.findByTestId('mcp-content-stub')).toBeTruthy();
        const onSelectionChange = mcpContentProps.value?.onSelectionChange as (selection: unknown) => void;
        await act(async () => {
            onSelectionChange({ v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['noisy'] });
        });
        expect(onChangeField).toHaveBeenCalledWith('mcpSelection', {
            v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['noisy'],
        });
        await screen.unmount();
    });

    /**
     * Connected Service bindings are authored through the incumbent New Session
     * owner — its chip, its per-service selection panel, its Team credential
     * resources — and what reaches the draft is the canonical `V2` payload, not
     * the owner's private option-state record.
     */
    it('edits Connected Service bindings through the incumbent New Session owner', async () => {
        connectedServicesContentProps.value = null;
        // A current public catalog entry, validated through its canonical schema:
        // the panel is handed the exact wire shape a Home projects, so the fixture
        // must satisfy the same contract the transport does.
        const teamResource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'res-1',
            teamId: 'team-1',
            displayName: 'Shared GitHub app',
            resourceRevision: 3,
            readiness: { kind: 'available' },
            recoveryAction: null,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered',
            sessionUsePolicy: 'personal_allowed',
            usageCapabilities: {
                inferenceRequests: 'available',
                totalTokens: 'unavailable',
                costUsd: 'unavailable',
                limitCoverage: 'unavailable',
            },
            providerModels: [],
            connectedServiceSelections: [
                { source: 'team_resource', resourceId: 'res-1', deliveryMode: 'brokered' },
            ],
            sourcePresentation: {
                kind: 'connected_service',
                service: { pluginId: 'happier.connect.github', localId: 'github' },
            },
        });
        // A second resource this Home no longer reports as current remains in
        // the picker so the shared selection owner can show its recovery path.
        const staleResource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            ...teamResource,
            id: 'res-stale',
            readiness: { kind: 'source_unavailable' },
            recoveryAction: 'source_owner_action',
            connectedServiceSelections: [],
        });
        teamCredentialCatalog.resources = [teamResource, staleResource];
        teamCredentialCatalog.currentResourceKeys = new Set(['team-1:res-1']);
        teamCredentialCatalog.teamNameById = { 'team-1': 'Platform' };

        const { screen, onChangeField } = await renderControls({
            fields: ['connectedServices'],
            values: { agentTarget: CLAUDE_TARGET },
            facts: {
                agentTargets: [claudeWithGithubDeclaration()],
                connectedServices: { serverId: 'server-a' },
            },
        });
        await act(async () => {});

        expect(screen.findByTestId('session-authoring-control-connectedServices-unavailable')).toBeNull();
        expect(screen.findByTestId('new-session-connected-services-auth-chip')).toBeTruthy();

        await act(async () => { screen.pressByTestId('new-session-connected-services-auth-chip'); });
        expect(screen.findByTestId('connected-services-content-stub')).toBeTruthy();
        // The owner is handed the exact Agent-declared service and the Team
        // resources this Home returns, with currentness kept separate from
        // retained choices that need recovery.
        expect(connectedServicesContentProps.value?.supportedServiceIds)
            .toEqual(['happier.connect.github/github']);
        expect(connectedServicesContentProps.value?.teamCredentialResources).toEqual([teamResource, staleResource]);
        expect(connectedServicesContentProps.value?.teamCredentialResourceCurrentKeys).toEqual(new Set(['team-1:res-1']));
        expect(connectedServicesContentProps.value?.teamNameById).toEqual({ 'team-1': 'Platform' });

        const setBindingForService = connectedServicesContentProps.value
            ?.setBindingForService as (serviceId: string, binding: unknown) => Promise<void>;
        await act(async () => {
            await setBindingForService('happier.connect.github/github', { source: 'native' });
        });

        const [field, value] = onChangeField.mock.calls.at(-1) as [string, { v: number } | null];
        expect(field).toBe('connectedServices');
        // The canonical binding payload, not the owner's option-state record.
        expect(value).toEqual({
            v: 2,
            bindingsByServiceId: { 'happier.connect.github/github': { source: 'native' } },
        });
        await screen.unmount();
    });

    /**
     * Omission and an authored `null` are different answers, and only one of
     * them may consult the Account's default Connected Service auth.
     *
     * Omission inherits, so the incumbent owner seeds its preview from the
     * Account defaults exactly as New Session does. An authored `null` is the
     * explicit "no connected account" the workflow contract stores, so the
     * defaults must not reappear — and editing one service from that state must
     * not sweep an untouched Account default into the saved definition, which
     * would bind a credential the author never chose.
     */
    it('keeps an authored empty Connected Services value distinct from omission', async () => {
        await seedAccountDefaultConnectedServiceAuth();
        const facts = {
            agentTargets: [claudeWithTwoDeclarations()],
            connectedServices: { serverId: 'server-a' },
        };

        const inherited = await renderControls({
            fields: ['connectedServices'],
            values: { agentTarget: CLAUDE_TARGET },
            facts,
        });
        await act(async () => {});
        // Omitted: this Account's defaults are the preview, as in New Session.
        expect(await readPanelBindings(inherited.screen)).toEqual(ACCOUNT_DEFAULT_AUTH_BINDINGS);
        expect(inherited.onChangeField).not.toHaveBeenCalled();
        await inherited.screen.unmount();

        connectedServicesContentProps.value = null;
        const { screen, onChangeField } = await renderControls({
            fields: ['connectedServices'],
            values: { agentTarget: CLAUDE_TARGET, connectedServices: null },
            facts,
        });
        await act(async () => {});
        // Authored "none": nothing is bound, and reopening reports nothing.
        expect(await readPanelBindings(screen)).toEqual({});
        expect(onChangeField).not.toHaveBeenCalled();

        const setBindingForService = connectedServicesContentProps.value
            ?.setBindingForService as (serviceId: string, binding: unknown) => Promise<void>;
        await act(async () => {
            await setBindingForService(GITHUB_SERVICE_KEY, { source: 'native' });
        });

        const [field, value] = onChangeField.mock.calls.at(-1) as [string, unknown];
        expect(field).toBe('connectedServices');
        // Editing one service cannot import the untouched service's Account
        // default; it stays native because nothing was authored for it.
        expect(value).toEqual({
            v: 2,
            bindingsByServiceId: {
                [GITHUB_SERVICE_KEY]: { source: 'native' },
                [LINEAR_SERVICE_KEY]: { source: 'native' },
            },
        });
        await screen.unmount();
    });

    it('does not report rehydrated Connected Services after the controlled value is reset', async () => {
        await seedAccountDefaultConnectedServiceAuth();
        const facts = {
            agentTargets: [claudeWithTwoDeclarations()],
            connectedServices: { serverId: 'server-a' },
        };
        const { SessionAuthoringControls } = await import('./SessionAuthoringControls');
        const onChangeField = vi.fn();
        const screen = await renderScreen(
            <SessionAuthoringControls
                fields={['connectedServices']}
                values={{ agentTarget: CLAUDE_TARGET, connectedServices: null }}
                facts={facts}
                onChangeField={onChangeField}
            />,
        );

        await readPanelBindings(screen);
        const setBindingForService = connectedServicesContentProps.value
            ?.setBindingForService as (serviceId: string, binding: unknown) => Promise<void>;
        await act(async () => {
            await setBindingForService(GITHUB_SERVICE_KEY, { source: 'native' });
        });
        expect(onChangeField).toHaveBeenCalledTimes(1);

        // The parent reset removes the authored override. Rehydrating the
        // incumbent owner's preview from Account defaults is not another edit.
        await screen.update(
            <SessionAuthoringControls
                fields={['connectedServices']}
                values={{ agentTarget: CLAUDE_TARGET }}
                facts={facts}
                onChangeField={onChangeField}
            />,
        );
        await act(async () => {});

        expect(await readPanelBindings(screen)).toEqual(ACCOUNT_DEFAULT_AUTH_BINDINGS);
        expect(onChangeField).toHaveBeenCalledTimes(1);

        const setBindingAfterReset = connectedServicesContentProps.value
            ?.setBindingForService as (serviceId: string, binding: unknown) => Promise<void>;
        await act(async () => {
            await setBindingAfterReset(GITHUB_SERVICE_KEY, { source: 'native' });
        });
        expect(onChangeField).toHaveBeenCalledTimes(2);
        await screen.unmount();
    });

    it('keeps an authored qualified binding when that service is no longer declared', async () => {
        const preservedLinearBinding = {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'lin-work',
        };
        const { screen, onChangeField } = await renderControls({
            fields: ['connectedServices'],
            values: {
                agentTarget: CLAUDE_TARGET,
                connectedServices: {
                    v: 2,
                    bindingsByServiceId: {
                        [GITHUB_SERVICE_KEY]: { source: 'native' },
                        [LINEAR_SERVICE_KEY]: preservedLinearBinding,
                    },
                },
            },
            facts: {
                // Linear was valid when authored but is no longer declared by
                // the current Agent projection, so the picker offers GitHub only.
                agentTargets: [claudeWithGithubDeclaration()],
                connectedServices: { serverId: 'server-a' },
            },
        });

        // The panel is handed the option-state parser's normalised shape: a
        // profile selection is carried by its account identity, since
        // `selection: 'profile'` is the canonical V2 default whenever a
        // `profileId` is present. The authored binding is preserved losslessly
        // where that contract actually lives — the emitted V2 payload below,
        // which re-emits the explicit `selection`.
        expect(await readPanelBindings(screen)).toEqual({
            [GITHUB_SERVICE_KEY]: { source: 'native' },
            [LINEAR_SERVICE_KEY]: { source: 'connected', profileId: preservedLinearBinding.profileId },
        });
        expect(connectedServicesContentProps.value?.supportedServiceIds).toEqual([GITHUB_SERVICE_KEY]);

        const setBindingForService = connectedServicesContentProps.value
            ?.setBindingForService as (serviceId: string, binding: unknown) => Promise<void>;
        await act(async () => {
            await setBindingForService(GITHUB_SERVICE_KEY, { source: 'native' });
        });

        expect(onChangeField).toHaveBeenCalledWith('connectedServices', {
            v: 2,
            bindingsByServiceId: {
                [GITHUB_SERVICE_KEY]: { source: 'native' },
                [LINEAR_SERVICE_KEY]: preservedLinearBinding,
            },
        });
        await screen.unmount();
    });

    it('states Connected Services unavailable when the Agent declares none or the Home is unknown', async () => {
        const noDeclarations = await renderControls({
            fields: ['connectedServices'],
            facts: {
                agentTargets: [directCapableClaude()],
                connectedServices: { serverId: 'server-a' },
            },
        });
        expect(noDeclarations.screen.findByTestId('session-authoring-control-connectedServices-unavailable')).toBeTruthy();
        await noDeclarations.screen.unmount();

        const noHome = await renderControls({
            fields: ['connectedServices'],
            facts: { agentTargets: [claudeWithGithubDeclaration()] },
        });
        expect(noHome.screen.findByTestId('session-authoring-control-connectedServices-unavailable')).toBeTruthy();
        await noHome.screen.unmount();
    });

    /**
     * The terminal field authors the one choice the incumbent New Session
     * terminal owner offers and the spawn resolver honours: whether a spawned
     * Session runs inside tmux. Omission is its own option — this machine's own
     * terminal settings still decide — and is not the same as choosing "off".
     */
    it('authors the incumbent tmux choice and keeps omission distinct from off', async () => {
        const { screen, onChangeField } = await renderControls({
            fields: ['terminal'],
            values: { agentTarget: CLAUDE_TARGET },
            facts: { agentTargets: [directCapableClaude()] },
        });
        expect(screen.findByTestId('session-authoring-control-terminal-unavailable')).toBeNull();

        await act(async () => { screen.pressByTestId('session-authoring-control-terminal'); });
        await act(async () => { selectOption(screen, 'tmux'); });
        expect(onChangeField).toHaveBeenLastCalledWith('terminal', { mode: 'tmux' });

        await act(async () => { selectOption(screen, 'plain'); });
        expect(onChangeField).toHaveBeenLastCalledWith('terminal', { mode: 'plain' });

        await act(async () => { selectOption(screen, '__none__'); });
        expect(onChangeField).toHaveBeenLastCalledWith('terminal', null);
        await screen.unmount();
    });

    it('preserves an authored tmux session name when the terminal mode is re-picked', async () => {
        const { screen, onChangeField } = await renderControls({
            fields: ['terminal'],
            values: {
                agentTarget: CLAUDE_TARGET,
                terminal: { mode: 'plain', tmux: { sessionName: 'review', isolated: true } },
            },
            facts: { agentTargets: [directCapableClaude()] },
        });
        await act(async () => { screen.pressByTestId('session-authoring-control-terminal'); });
        await act(async () => { selectOption(screen, 'tmux'); });
        expect(onChangeField).toHaveBeenLastCalledWith('terminal', {
            mode: 'tmux',
            tmux: { sessionName: 'review', isolated: true },
        });
        await screen.unmount();
    });

    it('states the terminal choice unsupported on a Windows target', async () => {
        const { screen } = await renderControls({
            fields: ['terminal'],
            facts: { agentTargets: [directCapableClaude()], targetIsWindows: true },
        });
        expect(screen.findByTestId('session-authoring-control-terminal-unavailable')).toBeTruthy();
        await screen.unmount();
    });

    it('authors Windows Terminal only when the selected Windows target reports it available', async () => {
        const unavailable = await renderControls({
            fields: ['windowsRemoteSessionLaunchMode'],
            facts: { targetIsWindows: true, windowsTerminalAvailable: false },
        });
        await act(async () => { unavailable.screen.pressByTestId('session-authoring-control-windowsRemoteSessionLaunchMode'); });
        const unavailableStep = unavailable.screen.root.findAll(
            (node) => Boolean(node.props?.open) && node.props?.rootStep !== undefined,
            { deep: true },
        ).at(-1)?.props?.rootStep as { sections: Array<{ options: Array<{ id: string; disabled?: boolean; subtitle?: string }> }> };
        expect(unavailableStep.sections.flatMap((section) => section.options).find((option) => option.id === 'windows_terminal'))
            .toMatchObject({ disabled: true, subtitle: expect.stringContaining('machine.windows.windowsTerminalUnavailableSuffix') });
        await unavailable.screen.unmount();

        const capable = await renderControls({
            fields: ['windowsRemoteSessionLaunchMode'],
            facts: { targetIsWindows: true, windowsTerminalAvailable: true },
        });
        await act(async () => { capable.screen.pressByTestId('session-authoring-control-windowsRemoteSessionLaunchMode'); });
        await act(async () => { selectOption(capable.screen, 'windows_terminal'); });
        expect(capable.onChangeField).toHaveBeenCalledWith('windowsRemoteSessionLaunchMode', 'windows_terminal');
        await capable.screen.unmount();
    });

    /** Every field a host can list has a canonical localized name. */
    it('names every field with its canonical control title', async () => {
        const { resolveSessionAuthoringFieldTitle } = await import('./sessionAuthoringFieldControls');
        const { WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS } = await import(
            '@happier-dev/protocol/workflows/workflowV1'
        );

        for (const field of WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS) {
            const title = resolveSessionAuthoringFieldTitle(field);
            expect(title, `no canonical title for ${field}`).toBeTruthy();
            // A title is a name, never the schema id a reader cannot act on.
            expect(title).not.toBe(field);
        }

        expect(resolveSessionAuthoringFieldTitle('runtimeDescriptorV1'))
            .toBe('workflows.editor.agentRuntime');

        // The Agent that declares a runtime choice names it.
        expect(resolveSessionAuthoringFieldTitle('runtimeDescriptorV1', {
            ...directCapableClaude(),
            runtimeBackendMode: { title: 'Backend mode', options: [] },
        })).toBe('Backend mode');
    });

    it('retires an Agent-bound runtime descriptor when the selected Agent no longer contributes it', async () => {
        const {
            resolveSessionAuthoringRuntimeDescriptorAvailability,
            retireUnavailableSessionAuthoringRuntimeDescriptor,
        } = await import('./sessionAuthoringFieldControls');
        const descriptor = { v: 1 as const, agentId: 'opencode', agent: { backendMode: 'acp' } };
        const opencode = {
            ...directCapableClaude(),
            agentId: 'opencode',
            target: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
        };
        const claude = directCapableClaude();
        const facts = { agentTargets: [opencode, claude] };

        expect(retireUnavailableSessionAuthoringRuntimeDescriptor({
            runtimeDescriptorV1: descriptor,
            agentTarget: opencode.target,
            facts,
        })).toBe(descriptor);
        expect(retireUnavailableSessionAuthoringRuntimeDescriptor({
            runtimeDescriptorV1: descriptor,
            agentTarget: claude.target,
            facts,
        })).toBeNull();
        expect(resolveSessionAuthoringRuntimeDescriptorAvailability({
            values: { agentTarget: opencode.target, runtimeDescriptorV1: descriptor },
            facts: {
                agentTargets: [{
                    ...opencode,
                    runtimeBackendMode: { title: 'Backend mode', options: [{ id: 'server', label: 'Server' }] },
                }, claude],
            },
        })).toBe('unavailable');
    });

    it('authors the selected Agent runtime mode as a strict portable descriptor', async () => {
        const opencodeTarget = {
            kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        };
        const { screen, onChangeField } = await renderControls({
            fields: ['runtimeDescriptorV1'],
            values: { agentTarget: opencodeTarget },
            facts: {
                agentTargets: [{
                    id: 'agent:happier.agent.opencode/opencode',
                    label: 'OpenCode',
                    target: opencodeTarget,
                    agentId: 'opencode',
                    runtimeBackendMode: {
                        title: 'Mode du moteur',
                        options: [
                            { id: 'server', label: 'Serveur' },
                            { id: 'acp', label: 'ACP historique' },
                        ],
                    },
                }],
            },
        });
        await act(async () => { screen.pressByTestId('session-authoring-control-runtimeDescriptorV1'); });
        await act(async () => { selectOption(screen, 'acp'); });
        expect(onChangeField).toHaveBeenLastCalledWith('runtimeDescriptorV1', {
            v: 1,
            agentId: 'opencode',
            agent: { backendMode: 'acp' },
        });
        await screen.unmount();
    });

    /**
     * These chips and the window-name input are the real press frames. On the
     * web bundle — which the desktop app is — `hitSlop` is never read, so a
     * frame smaller than the platform minimum is a target that does not exist.
     */
    it('gives every press frame the canonical minimum interactive target size', async () => {
        const { resolveMinimumInteractiveTargetSize } = await import('@/components/ui/interactiveTargetSize');
        const minimum = resolveMinimumInteractiveTargetSize('web');
        const { screen } = await renderControls({
            fields: ['permissionMode', 'windowsTerminalWindowName'],
            facts: { agentTargets: [directCapableClaude()], targetIsWindows: true },
        });

        const chip = screen.findByTestId('session-authoring-control-permissionMode');
        const chipStyle = (chip?.props.style as (state: { pressed: boolean }) => unknown[])({ pressed: false });
        expect(chipStyle.flat().some((entry) => (entry as { minHeight?: number } | null)?.minHeight === minimum))
            .toBe(true);

        const input = screen.findByTestId('session-authoring-control-windowsTerminalWindowName-input');
        expect([input?.props.style].flat().some((entry) => (entry as { minHeight?: number } | null)?.minHeight === minimum))
            .toBe(true);
        await screen.unmount();
    });

    it('states the MCP selection unavailable without a resolved Agent or an exact Machine and folder', async () => {
        const noAgent = await renderControls({
            fields: ['mcpSelection'],
            values: {},
            facts: { mcp: { machineId: 'machine-1', machineName: null, directory: '/p', serverId: null, enabled: true } },
        });
        expect(noAgent.screen.findByTestId('session-authoring-control-mcpSelection-unavailable')).toBeTruthy();
        await noAgent.screen.unmount();

        const noScope = await renderControls({ fields: ['mcpSelection'], facts: { agentTargets: [directCapableClaude()] } });
        expect(noScope.screen.findByTestId('session-authoring-control-mcpSelection-unavailable')).toBeTruthy();
        await noScope.screen.unmount();
    });
});
