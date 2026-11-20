import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderScreen as renderActualScreen, standardCleanup } from '@/dev/testkit';
import type { PathSelectionListProps } from '@/components/sessions/new/components/PathSelectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { CustomModalChromeConfig } from '@/modal';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RoundButtonProps = React.ComponentProps<typeof import('@/components/ui/buttons/RoundButton').RoundButton>;

function requireCardChrome(chrome: CustomModalChromeConfig | null | undefined) {
    if (chrome?.kind !== 'card') throw new Error('Expected card modal chrome');
    return chrome;
}

let machinesState: Machine[] = [];
let recentMachinePathsState: Array<{ machineId: string; path: string }> = [];

function createMachine(overrides: Partial<Machine> = {}): Machine {
    const { metadata: metadataOverride, ...machineOverrides } = overrides;
    const metadata: NonNullable<Machine['metadata']> = {
        host: 'machine',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        happyHomeDir: '/Users/test/.happier',
        homeDir: '/Users/test',
        ...(metadataOverride ?? {}),
    };
    return createMachineFixture({
        activeAt: Date.now(),
        ...machineOverrides,
        metadata,
    });
}

function findCreateButton(chrome: CustomModalChromeConfig | null | undefined): React.ReactElement<RoundButtonProps> | undefined {
    const footer = requireCardChrome(chrome).footer;
    if (!React.isValidElement<React.PropsWithChildren>(footer)) throw new Error('Expected modal footer element');
    return React.Children.toArray(footer.props.children)
        .find((child): child is React.ReactElement<RoundButtonProps> => {
            if (!React.isValidElement<RoundButtonProps>(child)) return false;
            return child.props.title === t('common.create');
        });
}

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@legendapp/list/react-native', async original => {
  const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({ original: await original(), renderItems: true }).module;
});

const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { t } = await import('@/text');
const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
const { PathSelectionList } = await import('@/components/sessions/new/components/PathSelectionList');
const initialStorage = storage.getState();
let settingsPostCount: number;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;

async function renderScreen(...args: Parameters<typeof renderActualScreen>) {
  await act(async () => {
    storage.getState().applyMachines(machinesState, true, { sourceServerId: connection.home.id });
    storage.getState().applyAuthoringMemory({ recentMachinePaths: recentMachinePathsState });
  });
  return renderActualScreen(...args);
}

function pathProps(screen: Awaited<ReturnType<typeof renderActualScreen>>): PathSelectionListProps {
  // React Test Renderer does not carry the rendered component's prop type.
  return screen.findByType(PathSelectionList).props as PathSelectionListProps;
}

describe('VoiceSessionSpawnPickerModal', () => {
  beforeEach(async () => {
    network.resetRequests();
    settingsPostCount = 0;
    const home = await network.addHome('https://voice-picker.example.test', 'picker-account');
    const settings = createAccountSettingsHttpBoundary({ serverUrl: home.serverUrl, initialAccounts: [{
      accountId: 'picker-account',
      snapshot: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
      } }, version: 1 },
    }] });
    const request = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v2/account/settings') {
        if (init?.method === 'POST') settingsPostCount++;
        return settings.handle(url, init) ?? null;
      }
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
      return null;
    };
    network.setHttpResponder(request);
    connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: 'picker-account', credentialScope: 'restored-home', request });
    storage.getState().applySettingsLocal({ useMachinePickerSearch: false, usePathPickerSearch: false, favoriteMachines: [], favoriteDirectories: [] });
    recentMachinePathsState = [];
    machinesState = [createMachine()];
  });
  afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    storage.setState(initialStorage, true);
  });
  afterAll(() => network.dispose());

    it('keeps both Machines starred when two open pickers press before either rerenders', async () => {
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');
        const firstMachine = createMachine({ id: 'first-machine' });
        const secondMachine = createMachine({ id: 'second-machine' });
        machinesState = [firstMachine, secondMachine];

        const screen = await renderScreen(<>
            <VoiceSessionSpawnPickerModal onClose={() => {}} onResolve={() => {}} />
            <VoiceSessionSpawnPickerModal onClose={() => {}} onResolve={() => {}} />
        </>);
        const [first, second] = screen.tree.findAllByType(MachineSelector);
        const starFirst = first.props.onToggleFavorite;
        const starSecond = second.props.onToggleFavorite;

        await act(async () => {
            starFirst(firstMachine);
            await vi.waitFor(() => expect(storage.getState().settings.favoriteMachines).toEqual([firstMachine.id]));
            starSecond(secondMachine);
            await vi.waitFor(() => expect(storage.getState().settings.favoriteMachines).toEqual([firstMachine.id, secondMachine.id]));
        });

        expect(settingsPostCount).toBe(2);

        await act(async () => {
            starFirst(firstMachine);
            starSecond(secondMachine);
            await vi.waitFor(() => expect(storage.getState().settings.favoriteMachines).toEqual([]));
        });
        expect(settingsPostCount).toBe(4);
    });

    it('passes machine browse config to PathSelectionList after choosing a machine', async () => {
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
            />,
        );

        const machineSelector = screen.findByType(MachineSelector);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

    expect(pathProps(screen)).toMatchObject({
      machineId: 'machine-1',
      serverId: null,
      machineHomeDir: '/Users/test',
    });
  });

    it('names the current step in the title band and goes back from its leading control', async () => {
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');
        const setChrome = vi.fn<(chrome: CustomModalChromeConfig | null) => void>();
        const screen = await renderScreen(<VoiceSessionSpawnPickerModal
            onClose={() => {}}
            onResolve={() => {}}
            setChrome={setChrome}
        />);

        expect(setChrome.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ subtitle: t('newSession.selectMachineTitle') }));
        expect(requireCardChrome(setChrome.mock.calls.at(-1)?.[0]).leading ?? null).toBeNull();
        await act(async () => { screen.findByType(MachineSelector).props.onSelect(machinesState[0]); });
        expect(setChrome.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ subtitle: t('newSession.selectWorkingDirectoryTitle') }));
        // The step is named once, by the title band, not again inside the body.
        expect(screen.getTextContent()).not.toContain(t('newSession.selectWorkingDirectoryTitle'));

        const leading = await renderScreen(<>{requireCardChrome(setChrome.mock.calls.at(-1)?.[0]).leading}</>);
        await act(async () => { await leading.pressByTestIdAsync('voice-session-spawn-back'); });
        expect(screen.findByType(MachineSelector)).toBeTruthy();
    });

    it('returns keyboard close requests from the directory picker to machine selection', async () => {
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');
        const screen = await renderScreen(<VoiceSessionSpawnPickerModal onClose={() => {}} onResolve={() => {}} />);

        await act(async () => { screen.findByType(MachineSelector).props.onSelect(machinesState[0]); });
        expect(screen.findByType(PathSelectionList)).toBeTruthy();
        await act(async () => { pathProps(screen).onRequestClose(); });
        expect(screen.findByType(MachineSelector)).toBeTruthy();
    });

    it('passes the selected machine platform to PathSelectionList after choosing a Windows machine', async () => {
        machinesState = [createMachine({
            id: 'machine-win',
            metadata: {
                host: 'win.local',
                platform: 'win32',
                happyCliVersion: '1.0.0',
                happyHomeDir: 'C:\\Users\\Ada\\.happier',
                homeDir: 'C:\\Users\\Ada',
            },
        })];
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
            />,
        );

        const machineSelector = screen.findByType(MachineSelector);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        expect(pathProps(screen)).toMatchObject({
            machineId: 'machine-win',
            machineHomeDir: 'C:\\Users\\Ada',
            machinePlatform: 'windows',
        });
    });

    it('resets the path draft to the selected machine recent path when changing machines', async () => {
        machinesState = [
            createMachine({
                id: 'machine-1',
            }),
            createMachine({
                id: 'machine-2',
                metadata: {
                    host: 'linux.local',
                    platform: 'linux',
                    happyCliVersion: '1.0.0',
                    happyHomeDir: '/srv/test/.happier',
                    homeDir: '/srv/test',
                },
            }),
        ];
        recentMachinePathsState = [
            { machineId: 'machine-1', path: '/Users/test/old-repo' },
            { machineId: 'machine-2', path: '/srv/test/new-repo' },
        ];
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');
        const setChrome = vi.fn<(chrome: CustomModalChromeConfig | null) => void>();

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType(MachineSelector);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });
        await act(async () => {
            pathProps(screen).onCommit('/Users/test/old-repo');
        });

        // Back to machines lives in the title band's leading slot.
        const leading = await renderScreen(<>{requireCardChrome(setChrome.mock.calls.at(-1)?.[0]).leading}</>);
        await act(async () => { await leading.pressByTestIdAsync('voice-session-spawn-back'); });
        const nextMachineSelector = screen.findByType(MachineSelector);
        await act(async () => {
            nextMachineSelector.props.onSelect(machinesState[1]);
        });

        expect(pathProps(screen)).toMatchObject({
            machineId: 'machine-2',
            machineHomeDir: '/srv/test',
            initialValue: '/srv/test/new-repo',
        });
    });

    it('uses live PathSelectionList draft edits when creating from the footer', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const setChrome = vi.fn<(chrome: CustomModalChromeConfig | null) => void>();
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={onClose}
                onResolve={onResolve}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType(MachineSelector);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const onChangeDraftPath = pathProps(screen).onChangeDraftPath;
        expect(typeof onChangeDraftPath).toBe('function');
        await act(async () => {
            onChangeDraftPath?.('/Users/test/typed-project');
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0];
        const createButton = findCreateButton(lastChrome);
        expect(createButton).toBeTruthy();

        await act(async () => {
            createButton?.props.onPress?.();
        });

        expect(onResolve).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test/typed-project',
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('uses the committed PathSelectionList value when creating the session', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const setChrome = vi.fn<(chrome: CustomModalChromeConfig | null) => void>();
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={onClose}
                onResolve={onResolve}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType(MachineSelector);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const onCommit = pathProps(screen).onCommit;
        expect(typeof onCommit).toBe('function');
        await act(async () => {
            onCommit?.('/Users/test/project');
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0];
        const createButton = findCreateButton(lastChrome);
        expect(createButton).toBeTruthy();

        await act(async () => {
            createButton?.props.onPress?.();
        });

        expect(onResolve).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test/project',
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('allows a structurally ready machine without synthetic spawn readiness to reach the spawn operation', async () => {
        machinesState = [createMachine()];
        const setChrome = vi.fn<(chrome: CustomModalChromeConfig | null) => void>();
        const onResolve = vi.fn();
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={onResolve}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType(MachineSelector);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0];
        const createButton = findCreateButton(lastChrome);

        expect(createButton?.props.disabled).toBe(false);
        await act(async () => {
            createButton?.props.onPress?.();
        });
        expect(onResolve).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test',
        });
    });
});
