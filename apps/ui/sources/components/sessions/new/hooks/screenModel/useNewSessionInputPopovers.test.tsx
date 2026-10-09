import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-reanimated/lib/module', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-reanimated/lib/module/index.js', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-reanimated/lib/module/index', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-reanimated/lib/module/publicGlobals', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('@/components/sessions/new/components/NewSessionPathSelectionContent', () => ({
    NewSessionPathSelectionContent: () => null,
}));
vi.mock('@/components/sessions/new/components/NewSessionMachineSelectionContent', () => ({
    NewSessionMachineSelectionContent: () => null,
}));
vi.mock('@/components/sessions/new/components/NewSessionResumeSelectionContent', () => ({
    NewSessionResumeSelectionContent: () => null,
}));
const resumeIdPickerModal = vi.hoisted(() => ({
    open: vi.fn<(args: unknown) => Promise<string | null>>(async () => null),
}));

vi.mock('@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal', () => ({
    openExternalSessionsResumeIdPickerModal: (args: unknown) => resumeIdPickerModal.open(args),
}));

/**
 * An ACP `session/list`-backed source: listing plus "resume in Happier" only.
 * It declares no link identity and no follow/takeover guarantee, so it is
 * offerable to the resume-id picker and to nothing else.
 */
function createResumeOnlyListingProjection() {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 9,
        installedPackagesById: {
            'happier.agent.codex': {
                id: 'happier.agent.codex',
                displayName: 'Codex',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.codex' },
            },
        },
        agentsById: {
            codex: {
                id: 'codex',
                title: 'Codex',
                externalSessions: {
                    agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    generation: 9,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: false,
                        pageTranscript: false,
                        readAfterTranscript: false,
                    },
                    sources: [{
                        sourceKind: 'codexAcpSessionList',
                        resumeOnly: true,
                        schema: {
                            fields: [{ name: 'kind', kind: 'literal', value: 'codexAcpSessionList' }],
                        },
                        key: { segments: [{ kind: 'literal', value: 'codexAcpSessionList' }] },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        },
    });
}

async function renderResumePopoverContent(overrides: Partial<HookParams>) {
    const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
    const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
        initialProps: createParams(overrides),
    });
    const renderContent = hook.getCurrent().resumePopover.renderContent;
    if (typeof renderContent !== 'function') throw new Error('Expected resume popover renderContent');
    const content = renderContent({ maxHeight: 460, requestClose: vi.fn() }) as {
        props?: Readonly<Record<string, unknown>>;
    };
    return { hook, resumeContentProps: content.props };
}

type UseNewSessionInputPopovers = typeof import('./useNewSessionInputPopovers').useNewSessionInputPopovers;
type HookParams = Parameters<UseNewSessionInputPopovers>[0];

function createParams(overrides: Partial<HookParams> = {}): HookParams {
    const selectedMachine = createMachineFixture({
        id: 'machine-1',
        metadata: {
            host: 'machine-1',
            displayName: 'Machine 1',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/test/.happy-dev',
            homeDir: '/Users/test',
            platform: 'darwin',
        },
    }) as Machine;

    return {
        selectedMachine,
        selectedMachineId: selectedMachine.id,
        selectedPath: '/Users/test/project',
        setSelectedPath: vi.fn(),
        setDraftSelectedPath: vi.fn(),
        recentPaths: [],
        usePathPickerSearch: false,
        pathPickerSearchQuery: '',
        setPathPickerSearchQuery: vi.fn(),
        favoriteDirectories: [],
        setFavoriteDirectories: vi.fn(),
        machineGroups: [{
            serverId: 'server-a',
            serverName: 'Server A',
            loading: false,
            signedOut: false,
            machines: [{ ...selectedMachine, serverId: 'server-a', serverName: 'Server A' }],
        }],
        selectedServerId: 'server-a',
        recentMachines: [],
        favoriteMachineItems: [],
        selectMachineTarget: vi.fn(),
        toggleFavoriteMachine: vi.fn(),
        useMachinePickerSearch: false,
        machinePoolGroups: [{
            serverId: 'server-a',
            accountId: 'account-a',
            serverName: 'Server A',
            pools: [{
                pool: {
                    id: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                    name: 'Development',
                    description: null,
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    members: [],
                },
                availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
            }],
        }],
        machinePoolRequestKey: 'draft-7',
        selectMachinePoolTarget: vi.fn(),
        executionTarget: null,
        temporaryComputerAvailability: {
            status: 'unavailable',
            reason: 'feature_disabled',
            retry: vi.fn(),
        },
        temporaryComputerLaunchBlock: null,
        selectTemporaryComputer: vi.fn(),
        onRefreshMachines: vi.fn(),
        onRefreshMachinePools: vi.fn(),
        onOpenMachinePoolSettings: vi.fn(),
        targetServerId: 'server-a',
        externalSessionsFeatureEnabled: false,
        resumeSessionId: '',
        setResumeSessionId: vi.fn(),
        agentType: 'codex',
        agentLabel: 'Codex',
        agentOptionState: null,
        settings: {},
        pluginProjectionV2: null,
        ...overrides,
    } as HookParams;
}

describe('useNewSessionInputPopovers', () => {
    beforeEach(() => {
        resumeIdPickerModal.open.mockReset();
        resumeIdPickerModal.open.mockResolvedValue(null);
    });

    it('opens the path popover in history-first suggestion mode', async () => {
        const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
        const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
            initialProps: createParams(),
        });

        const renderContent = hook.getCurrent().pathPopover.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') throw new Error('Expected path popover renderContent');
        const content = renderContent({
            maxHeight: 420,
            requestClose: vi.fn(),
        });
        const element = content as { props?: Readonly<Record<string, unknown>> };

        expect(element.props?.initialSuggestionMode).toBe('history');

        await hook.unmount();
    });

    it('keeps closed machine popover config stable when callback identities churn', async () => {
        const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
        const initialProps = createParams();
        const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
            initialProps,
        });
        const firstMachinePopover = hook.getCurrent().machinePopover;

        await hook.rerender({
            ...initialProps,
            selectMachineTarget: vi.fn(),
        });

        expect(hook.getCurrent().machinePopover).toBe(firstMachinePopover);

        await hook.unmount();
    });

    it('projects machine pools into the shared Simple/Wizard popover', async () => {
        const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
        const params = createParams();
        const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
            initialProps: params,
        });

        const renderContent = hook.getCurrent().machinePopover.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected machine popover renderContent');
        const content = renderContent({ maxHeight: 420, requestClose: vi.fn() });
        const element = content as { props?: Readonly<Record<string, unknown>> };

        expect(element.props?.poolGroups).toBe(params.machinePoolGroups);
        expect(element.props?.onSelectPool).toEqual(expect.any(Function));
        expect(hook.getCurrent().machinePopover.onRequestClose).toEqual(expect.any(Function));

        await hook.unmount();
    });

    it('commits the selected Temporary computer workspace before closing the mounted popover', async () => {
        const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
        const selectTemporaryComputer = vi.fn();
        const requestClose = vi.fn();
        const params = createParams({
            selectedMachine: null,
            selectedMachineId: null,
            executionTarget: {
                kind: 'temporary_computer',
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                workspace: { kind: 'endpoint_home' },
            },
            temporaryComputerAvailability: {
                status: 'available',
                artifacts: [{
                    identity: {
                        product: 'happier-runner',
                        version: '0.3.0',
                        target: 'linux-x64',
                        sha256: 'a'.repeat(64),
                    },
                    channel: 'stable',
                    url: 'https://example.test/runner.zip',
                    checksumsUrl: 'https://example.test/checksums.txt',
                    checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                    sizeBytes: 1,
                    entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 1, mode: 0o755 }],
                }],
                client: {} as HookParams['temporaryComputerAvailability'] extends { client: infer Client } ? Client : never,
                retry: vi.fn(),
            },
            selectTemporaryComputer,
        });
        const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
            initialProps: params,
        });

        const renderContent = hook.getCurrent().machinePopover.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected machine popover renderContent');
        const content = renderContent({ maxHeight: 420, requestClose });
        const element = content as { props?: Readonly<Record<string, unknown>> };
        const temporaryComputers = element.props?.temporaryComputers as ReadonlyArray<{
            workspace: { kind: string } | null;
            onSelect: (
                workspace: { kind: 'choose_on_endpoint' | 'endpoint_home' },
                packageExpiresAt: number | undefined,
            ) => void;
        }>;

        expect(temporaryComputers[0]?.workspace).toEqual({ kind: 'endpoint_home' });
        temporaryComputers[0]?.onSelect({ kind: 'choose_on_endpoint' }, undefined);
        expect(selectTemporaryComputer).toHaveBeenCalledWith('linux-x64', { kind: 'choose_on_endpoint' }, undefined);
        expect(requestClose).toHaveBeenCalledOnce();

        await hook.unmount();
    });

    it('threads the mounted Simple/Wizard popover into the existing Machine refresh owner', async () => {
        const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
        const onRefreshMachines = vi.fn();
        const params = createParams({ onRefreshMachines });
        const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
            initialProps: params,
        });

        const renderContent = hook.getCurrent().machinePopover.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected machine popover renderContent');
        const content = renderContent({ maxHeight: 420, requestClose: vi.fn() });
        const element = content as { props?: Readonly<Record<string, unknown>> };
        const onRefreshMachineRows = element.props?.onRefreshMachines;

        expect(onRefreshMachineRows).toEqual(expect.any(Function));
        if (typeof onRefreshMachineRows !== 'function') throw new Error('Expected Machine refresh callback');
        onRefreshMachineRows();
        expect(onRefreshMachines).toHaveBeenCalledOnce();

        await hook.unmount();
    });
    it('browses an ACP-list resume-only source and stores the picked id exactly as the Agent issued it', async () => {
        const setResumeSessionId = vi.fn();
        // An opaque provider session id. No surface between the list row and
        // the canonical authoring normalizer may rewrite these bytes.
        const opaqueRemoteSessionId = '  fx/AB+cd==/01JQ  ';
        resumeIdPickerModal.open.mockResolvedValue(opaqueRemoteSessionId);

        const { hook, resumeContentProps } = await renderResumePopoverContent({
            externalSessionsFeatureEnabled: true,
            pluginProjectionV2: createResumeOnlyListingProjection(),
            setResumeSessionId,
        });

        const resumeBrowse = resumeContentProps?.resumeBrowse as
            | Readonly<{ enabled: boolean; onBrowse: () => Promise<string | null> }>
            | null
            | undefined;
        expect(resumeBrowse?.enabled).toBe(true);

        await resumeBrowse?.onBrowse();

        expect(resumeIdPickerModal.open).toHaveBeenCalledWith(expect.objectContaining({
            lockScope: expect.objectContaining({
                machineId: 'machine-1',
                providerId: 'codex',
                source: expect.objectContaining({ kind: 'codexAcpSessionList' }),
            }),
        }));
        expect(setResumeSessionId).toHaveBeenCalledWith(opaqueRemoteSessionId);

        await hook.unmount();
    });

    it('leaves the resume id untouched when the picker is dismissed or returns only whitespace', async () => {
        const setResumeSessionId = vi.fn();
        resumeIdPickerModal.open.mockResolvedValue('   ');

        const { hook, resumeContentProps } = await renderResumePopoverContent({
            externalSessionsFeatureEnabled: true,
            pluginProjectionV2: createResumeOnlyListingProjection(),
            resumeSessionId: 'sess_existing',
            setResumeSessionId,
        });

        const resumeBrowse = resumeContentProps?.resumeBrowse as
            | Readonly<{ enabled: boolean; onBrowse: () => Promise<string | null> }>
            | null
            | undefined;
        await resumeBrowse?.onBrowse();
        expect(setResumeSessionId).not.toHaveBeenCalled();

        resumeIdPickerModal.open.mockResolvedValue(null);
        await resumeBrowse?.onBrowse();
        expect(setResumeSessionId).not.toHaveBeenCalled();

        await hook.unmount();
    });

});
