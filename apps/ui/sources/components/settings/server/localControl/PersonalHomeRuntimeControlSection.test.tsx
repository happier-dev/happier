import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real owner graph behind boundary installation. The testkit barrel
// also exports provider harnesses which can load Modal/text before configuration.
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { PreparedPersonalHomeRelocationTask } from './PersonalHomeRuntimeControlSection';
import type { SystemTaskSpec } from '@happier-dev/protocol';
import type { RelayRuntimeStatusData } from './relayRuntimeStatus';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createPreparedRelocationTask(input: Readonly<{ spec: SystemTaskSpec;
    respondToPrompt: PreparedPersonalHomeRelocationTask['respondToPrompt'] }>): PreparedPersonalHomeRelocationTask {
    return { respondToPrompt: input.respondToPrompt, withTaskSpec: async run => run(input.spec) };
}

const modalMockRef = vi.hoisted(() => ({
    current: null as ReturnType<
        typeof import('@/dev/testkit/mocks/modal')['createModalModuleMock']
    > | null,
}));

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const { personalHomeSettingsTranslations } = await import('@/text/translations/personalHomeSettingsTranslations');
        return createTextModuleMock({
            translate: (key, params) => {
                const prefix = 'personalHome.settings.';
                if (!key.startsWith(prefix)) return key;
                const setting = key.slice(prefix.length) as keyof typeof personalHomeSettingsTranslations.en;
                const value: unknown = personalHomeSettingsTranslations.en[setting];
                if (typeof value === 'function') return (value as (params: unknown) => string)(params);
                return value ?? key;
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        modalMockRef.current = modalMock;
        return modalMock.module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({ theme: { colors: { accent: { blue: 'blue', orange: 'orange', indigo: 'indigo' } } } });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, footer }: { children?: React.ReactNode; title?: React.ReactNode; footer?: React.ReactNode }) =>
        React.createElement(
            'Group',
            { title, footer },
            typeof title === 'string' || typeof title === 'number'
                ? React.createElement('Text', null, String(title))
                : title ?? null,
            children,
        ),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => {
        const title = (props as { title?: unknown }).title;
        const subtitle = (props as { subtitle?: unknown }).subtitle;
        const subtitleTestID = (props as { subtitleTestID?: string }).subtitleTestID;
        const subtitleNode: React.ReactNode = typeof subtitle === 'string' || typeof subtitle === 'number'
            ? React.createElement('Text', { testID: subtitleTestID }, String(subtitle))
            : React.isValidElement(subtitle) ? subtitle : null;
        return React.createElement(
            'Item',
            props,
            title != null ? React.createElement('Text', null, String(title)) : null,
            subtitleNode,
        );
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

// Import the section once at module scope: collection carries no test or hook
// timeout, so a cold module graph under host load cannot time out a test body.
const { useLocalRelayRuntimeControl } = await import('./useLocalRelayRuntimeControl');
const { PersonalHomeRuntimeControlSection } = await import('./PersonalHomeRuntimeControlSection');

describe('Personal Home SSH task material custody', () => {
    it('hands relocation material to the runner without retaining it in the UI operation projection', async () => {
        const harness = createScriptedRunnerHarness();
        const hook = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const spec: SystemTaskSpec = { protocolVersion: 1, kind: 'remote.ssh.manageHost.v1', params: { action: 'personalHome.relocate',
            ssh: { target: 'user@remote.test', auth: 'password', password: 'private-password', identityPrivateKey: 'private-key' },
            personalHome: { operationId: 'move-1', destinationMachineId: 'host-1', sourceDescriptorRevision: 1 } } };
        await renderer.act(async () => { await hook.getCurrent().startExternalOperation(spec); });
        expect(harness.specByKind('remote.ssh.manageHost.v1')?.params.ssh).toMatchObject({ password: 'private-password', identityPrivateKey: 'private-key' });
        expect(JSON.stringify(hook.getCurrent().activeOperationSpec)).not.toContain('private-password');
        expect(JSON.stringify(hook.getCurrent().activeOperationSpec)).not.toContain('private-key');
        expect(hook.getCurrent().activeOperationSpec?.params).toMatchObject({ action: 'personalHome.relocate',
            personalHome: { operationId: 'move-1', destinationMachineId: 'host-1' } });
    });
});

type ScriptedSpec = { kind: string; params: Record<string, unknown> };

function createScriptedRunnerHarness() {
    const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
    const startedSpecs: ScriptedSpec[] = [];
    const startedTaskIds: string[] = [];
    let statusResultData: RelayRuntimeStatusData = {
        channel: 'stable',
        mode: 'user',
        installed: true,
        dataPresent: true,
        version: '1',
        relayUrl: 'http://127.0.0.1:43123',
        healthy: true,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        anonymousSignupEnabled: false,
        service: { active: true, enabled: true },
    };
    let nextTaskNumber = 1;
    const startMock = vi.fn(async (spec: unknown) => {
        const parsed = spec as ScriptedSpec;
        startedSpecs.push(parsed);
        const taskId = `task_${nextTaskNumber++}:${parsed.kind}`;
        startedTaskIds.push(taskId);
        return taskId;
    });
    const respondMock = vi.fn(async (_taskId: string, _answer: unknown) => {});
    const cancelMock = vi.fn(async (_taskId: string) => {});
    const runner: SystemTaskRunner = createSystemTaskRunner({
        bridge: {
            start: startMock,
            async subscribe(taskId, listenerSet) {
                listeners.set(taskId, listenerSet);
                if (taskId.endsWith('relay.runtime.status.v1')) {
                    queueMicrotask(() => {
                        listenerSet.onResult({ protocolVersion: 1, taskId, ok: true, data: statusResultData });
                    });
                }
                return () => {
                    listeners.delete(taskId);
                };
            },
            cancel: cancelMock,
            respond: respondMock,
        },
    });
    function resolveResult(taskId: string, ok: boolean, data?: unknown, message?: string): void {
        listeners.get(taskId)?.onResult(ok
            ? { protocolVersion: 1, taskId, ok: true, ...(data !== undefined ? { data } : {}) }
            : { protocolVersion: 1, taskId, ok: false, error: { code: 'operation_failed', ...(message ? { message } : {}) } });
    }
    function emitProgress(taskId: string, stepId: string, message?: string): void {
        listeners.get(taskId)?.onEvent({
            protocolVersion: 1,
            taskId,
            tsMs: startedTaskIds.length * 10,
            type: 'progress',
            stepId,
            ...(message ? { message } : {}),
        });
    }
    function emitErasePrompt(
        taskId: string,
        paths: readonly string[],
        estimatedBytes: number | null,
        homeServerIdentityId: string | null = 'home-identity-1',
    ): void {
        listeners.get(taskId)?.onEvent({
            protocolVersion: 1,
            taskId,
            tsMs: startedTaskIds.length * 10,
            type: 'prompt',
            stepId: 'personal_home.confirm_erase',
            message: 'Confirm permanent deletion of these Personal Home paths.',
            data: {
                kind: 'personal_home.confirm_erase.v1',
                canonicalServerUrl: 'http://127.0.0.1:43123',
                homeServerIdentityId,
                paths,
                estimatedBytes,
                previewComplete: true,
                previewReason: null,
            },
        });
    }
    function emitRelocationPrompt(taskId: string, kind: string, data: Record<string, unknown>): void {
        listeners.get(taskId)?.onEvent({
            protocolVersion: 1,
            taskId,
            tsMs: startedTaskIds.length * 10,
            type: 'prompt',
            stepId: 'personal_home.relocation',
            message: 'Publish relocation destination.',
            data: { kind, ...data },
        });
    }
    function specByKind(kind: string): ScriptedSpec | undefined {
        return startedSpecs.find((spec) => spec.kind === kind);
    }
    function taskIdByKind(kind: string): string | undefined {
        return startedTaskIds.find((taskId) => taskId.endsWith(kind));
    }
    return {
        runner,
        startedSpecs,
        startedTaskIds,
        startMock,
        respondMock,
        cancelMock,
        resolveResult,
        emitProgress,
        emitErasePrompt,
        emitRelocationPrompt,
        specByKind,
        taskIdByKind,
        setStatusResultData: (value: typeof statusResultData) => {
            statusResultData = value;
        },
        hasListener: (taskId: string) => listeners.has(taskId),
    };
}

const INSPECT_RESULT_DATA = {
    purpose: 'personal-home',
    running: true,
    identity: { homeServerIdentityId: 'home-identity-1', schemaVersion: '7' },
    masterSecret: { present: true, fingerprint: 'fp' },
    layout: {
        dataDir: '/home/.happier/self-host/data',
        configDir: '/home/.happier/self-host/config',
        logsDir: '/home/.happier/self-host/logs',
        backupsDir: '/home/.happier/self-host/data/backups',
    },
    storage: {
        databasePresent: true,
        databaseBytes: 5033164,
        publicFilesPresent: true,
        privateFilesPresent: true,
        backupsCount: 2,
        ownedErasePaths: ['/data/home.sqlite', '/data/files'],
        estimatedOwnedBytes: 5033164,
        destinationEmpty: false,
        latestBackup: {
            path: '/home/.happier/self-host/data/backups/personal-home-2026-02-02T03-04-05-006Z.tar',
            createdAt: '2026-02-02T03:04:05.006Z',
            archiveBytes: 4096,
        },
    },
    restoreRecovery: { status: 'none', affectedTargets: [] },
};

const BACKUP_RESULT_DATA = {
    path: '/tmp/home-backup.tar',
    sha256: 'abc123',
    archiveBytes: 8192,
    manifest: {
        format: 'happier-personal-home-backup',
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        homeServerIdentityId: 'home-identity-1',
        entries: [{ path: 'database/home.sqlite', size: 15, sha256: 'h1' }],
    },
};

async function resolveInitialInspectionWith(
    harness: ReturnType<typeof createScriptedRunnerHarness>,
    inspection: typeof INSPECT_RESULT_DATA & Record<string, unknown>,
): Promise<void> {
    const taskId = harness.taskIdByKind('relay.runtime.personal_home.inspect.v1');
    if (!taskId) throw new Error('inspect task was not started');
    await renderer.act(async () => {
        harness.resolveResult(taskId, true, inspection);
    });
}

const VERIFY_RESULT_DATA = {
    manifest: {
        format: 'happier-personal-home-backup',
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        homeServerIdentityId: 'home-identity-1',
        entries: [],
    },
    identityMatchesCurrentHome: 'match',
};

function confirmRef() {
    const confirm = modalMockRef.current?.spies.confirm;
    if (!confirm) throw new Error('modal mock was not installed');
    return confirm;
}

function promptRef() {
    const prompt = modalMockRef.current?.spies.prompt;
    if (!prompt) throw new Error('modal mock was not installed');
    return prompt;
}

function alertRef() {
    const alert = modalMockRef.current?.spies.alert;
    if (!alert) throw new Error('modal mock was not installed');
    return alert;
}

function alertAsyncRef() {
    const alertAsync = modalMockRef.current?.spies.alertAsync;
    if (!alertAsync) throw new Error('modal mock was not installed');
    return alertAsync;
}

function showRef() {
    const show = modalMockRef.current?.spies.show;
    if (!show) throw new Error('modal mock was not installed');
    return show;
}

async function resolveInitialInspection(harness: ReturnType<typeof createScriptedRunnerHarness>): Promise<void> {
    const taskId = harness.taskIdByKind('relay.runtime.personal_home.inspect.v1');
    if (!taskId) throw new Error('inspect task was not started');
    await renderer.act(async () => {
        harness.resolveResult(taskId, true, INSPECT_RESULT_DATA);
    });
}

async function waitForStartedKindCount(
    harness: ReturnType<typeof createScriptedRunnerHarness>,
    kind: string,
    expectedCount: number,
): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.startedSpecs.filter((spec) => spec.kind === kind).length >= expectedCount) return;
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
    }
    throw new Error(`Expected ${expectedCount} started ${kind} tasks`);
}

async function waitForTaskSubscription(
    harness: ReturnType<typeof createScriptedRunnerHarness>,
    taskId: string,
): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.hasListener(taskId)) return;
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
    }
    throw new Error(`Expected subscription for ${taskId}`);
}

type RuntimeControl = ReturnType<typeof useLocalRelayRuntimeControl>;

function createSettledController(overrides: Partial<Record<keyof RuntimeControl, unknown>> = {}): RuntimeControl {
    return {
        status: {
            channel: 'stable',
            mode: 'user',
            installed: true,
            dataPresent: false,
            version: '1',
            relayUrl: 'http://127.0.0.1:43123',
            healthy: true,
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
            anonymousSignupEnabled: false,
            service: { active: false, enabled: false },
        },
        inspection: null,
        isBusy: false,
        isUnavailable: false,
        lastOperation: null,
        lastVerification: null,
        activeOperationSpec: null,
        operationSnapshot: null,
        readStatus: vi.fn(),
        refreshInspection: vi.fn(async () => ({ status: 'succeeded', inspection: null })),
        startRelay: vi.fn(),
        stopRelay: vi.fn(),
        restartRelay: vi.fn(),
        installOrUpdate: vi.fn(),
        backupPersonalHome: vi.fn(),
        verifyPersonalHomeBackup: vi.fn(),
        restorePersonalHomeBackup: vi.fn(),
        recoverPersonalHomeRestore: vi.fn(),
        erasePersonalHomeData: vi.fn(),
        startExternalOperation: vi.fn(),
        cancelTask: vi.fn(),
        dismissOperationResult: vi.fn(),
        ...overrides,
    } as unknown as RuntimeControl;
}

function eraseOperation(erase: Partial<{
    outcome: 'completed' | 'completed_with_cleanup_attention' | 'partial';
    removedPaths: string[];
    remainingOwnedPaths: string[];
    remainingUnknownPaths: string[];
    stoppedRunningHome: boolean;
    error: string | null;
    inspectionError: string | null;
}>) {
    return {
        operation: 'erase',
        erase: {
            outcome: 'completed',
            removedPaths: [],
            remainingOwnedPaths: [],
            remainingUnknownPaths: [],
            stoppedRunningHome: false,
            inspectionComplete: true,
            error: null,
            inspectionError: null,
            ...erase,
        },
    };
}

function operationAnnouncement(screen: Awaited<ReturnType<typeof renderScreen>>): string {
    const status = screen.findByTestId('settings.personalHomeRuntime.eraseAccessibilityStatus');
    if (!status) throw new Error('operation status region was not rendered');
    return String(status.props.children?.props.children ?? '');
}

describe('PersonalHomeRuntimeControlSection operation outcome accessibility', () => {
    it('announces a new erase outcome as one plural-aware sentence without paths or daemon errors', async () => {
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            controller: createSettledController(),
        }));
        expect(operationAnnouncement(screen)).toBe('');

        await screen.update(React.createElement(PersonalHomeRuntimeControlSection, {
            controller: createSettledController({
                lastOperation: eraseOperation({ removedPaths: ['/data/home.sqlite'] }),
            }),
        }));

        expect(operationAnnouncement(screen)).toContain('Removed 1 item');
        expect(operationAnnouncement(screen)).not.toContain('1 items');
        expect(operationAnnouncement(screen)).not.toContain('/data/home.sqlite');
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseResult')?.props.accessibilityLiveRegion)
            .toBeUndefined();
    });

    it('keeps partial-erase paths and raw errors behind Details while the summary counts both sides', async () => {
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            controller: createSettledController(),
        }));
        await screen.update(React.createElement(PersonalHomeRuntimeControlSection, {
            controller: createSettledController({
                lastOperation: eraseOperation({
                    outcome: 'partial',
                    removedPaths: ['/data/home.sqlite', '/data/cache'],
                    remainingOwnedPaths: ['/data/files'],
                    stoppedRunningHome: true,
                    error: 'EACCES: permission denied, rmdir /data/files',
                }),
            }),
        }));

        const announcement = operationAnnouncement(screen);
        expect(announcement).toContain('Removed 2 items; 1 could not be removed');
        expect(announcement).not.toContain('/data/files');
        expect(announcement).not.toContain('EACCES');

        const visible = screen.findByTestId('settings.personalHomeRuntime.eraseResult');
        const visibleText = `${String(visible?.props.title)}\n${String(visible?.props.subtitle)}`;
        expect(visibleText).toContain('Removed 2 items; 1 could not be removed');
        expect(visibleText).not.toContain('/data/files');
        expect(visibleText).not.toContain('EACCES');

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseResultDetails');
        expect(screen.getTextContent()).toContain('/data/files');
        expect(screen.getTextContent()).toContain('EACCES: permission denied, rmdir /data/files');
    });

    it('announces a restore outcome without its daemon error prose', async () => {
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            controller: createSettledController(),
        }));
        await screen.update(React.createElement(PersonalHomeRuntimeControlSection, {
            controller: createSettledController({
                lastOperation: {
                    operation: 'restore',
                    restore: { outcome: 'rolled_back', recoveryArchive: null, error: 'health check failed after swap' },
                },
            }),
        }));

        expect(operationAnnouncement(screen)).toContain('Restore rolled back');
        expect(operationAnnouncement(screen)).not.toContain('health check failed');

        // The visible card carries the same mapped outcome; daemon prose sits behind Details.
        const visible = screen.findByTestId('settings.personalHomeRuntime.restoreResult');
        expect(String(visible?.props.subtitle)).toContain('Restore rolled back');
        expect(String(visible?.props.subtitle)).not.toContain('health check failed');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restoreResultDetails');
        expect(screen.getTextContent()).toContain('health check failed after swap');
    });
});

describe('PersonalHomeRuntimeControlSection Personal Home operations', () => {
    beforeEach(() => {
        standardCleanup();
        confirmRef().mockReset();
        confirmRef().mockResolvedValue(false);
        promptRef().mockReset();
        promptRef().mockResolvedValue(null);
        alertRef().mockReset();
        alertAsyncRef().mockReset();
        alertAsyncRef().mockImplementation(async (_title, _message, buttons) => {
            buttons?.find((button) => button.style !== 'cancel' && button.text !== 'Back Up Now')?.onPress?.();
        });
        showRef().mockReset();
        showRef().mockImplementation((config) => {
            queueMicrotask(() => (config.props as { onCancel?: () => void } | undefined)?.onCancel?.());
            return 'personal-home-modal';
        });
    });

    it.each([true, false])('offers Home search repair under Advanced and announces completion only for a committed result (%s)', async (committed) => {
        const harness = createScriptedRunnerHarness();
        const repairSearch = vi.fn(async () => committed);
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { repairSearch },
        }));

        expect(screen.findByTestId('settings.personalHomeRuntime.repairSearch')?.props.title)
            .toBe('Rebuild Home search');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.repairSearch');
        expect(repairSearch).toHaveBeenCalledTimes(1);
        expect(alertRef()).toHaveBeenCalledTimes(committed ? 1 : 0);
    });

    it('composes the canonical runtime owner once and presents inspect facts from the inspect task', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            homeLabel: 'My Personal Home',
        }));

        // Exactly one status task for the composed runtime owner (not one per section).
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.status.v1')).toHaveLength(1);
        expect(screen.findByTestId('settings.localRelayRuntime.status')).toBeTruthy();

        // The section refreshes Home facts through the inspect task.
        const inspectTaskId = harness.taskIdByKind('relay.runtime.personal_home.inspect.v1');
        expect(inspectTaskId).toBeTruthy();
        await renderer.act(async () => {
            harness.resolveResult(inspectTaskId!, true, INSPECT_RESULT_DATA);
        });

        expect(screen.findByTestId('settings.personalHomeRuntime.home')?.props.subtitle).toBe('My Personal Home');
        expect(screen.findByTestId('settings.personalHomeRuntime.home')?.props.subtitle).not.toContain('home-identity-1');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.homeDetails');
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.homeDetailsPanel')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.homeIdentity')?.props.subtitle).toBe('home-identity-1');
        expect(screen.findByTestId('settings.personalHomeRuntime.storage')?.props.subtitle).toBe('4.8 MB');
        expect(screen.findByTestId('settings.personalHomeRuntime.backupsCount')?.props.title).toBe('Backup archives');
        expect(screen.findByTestId('settings.personalHomeRuntime.backupsCount')?.props.subtitle).toBe('2');
        expect(screen.findByTestId('settings.personalHomeRuntime.masterSecret')?.props.subtitle).toBe('Present');
    });

    it('labels a bounded backup inventory as incomplete without claiming an exact latest backup', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
        const inspectTaskId = harness.taskIdByKind('relay.runtime.personal_home.inspect.v1');
        expect(inspectTaskId).toBeTruthy();
        await renderer.act(async () => {
            harness.resolveResult(inspectTaskId!, true, {
                ...INSPECT_RESULT_DATA,
                storage: { ...INSPECT_RESULT_DATA.storage, backupsCount: 32, backupsCountComplete: false },
            });
        });

        expect(screen.findByTestId('settings.personalHomeRuntime.backupsCount')?.props.subtitle).toBe('32+');
        expect(screen.findByTestId('settings.personalHomeRuntime.lastBackup')?.props.subtitle).toBe('Last backup unknown');
    });

    it('orders the surface: summary, primary actions with results, live operation, Protection facts, Advanced, Delete Home Data', async () => {
        const harness = createScriptedRunnerHarness();
        // This ordering case intentionally starts a real backup operation so the
        // shared progress row is present. Accept the canonical plaintext backup
        // disclosure instead of relying on the old pre-disclosure behavior.
        confirmRef().mockResolvedValueOnce(true);
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: {
                selectBackupArchive: async () => null,
                relocation: {
                    destinations: [{ id: 'managed-host-1', title: 'Home server' }],
                    prepare: async () => { throw new Error('not used'); },
                },
            },
        }));
        await resolveInitialInspection(harness);

        const groups = screen.findAllByType('Group' as any);
        expect(groups.map((group) => group.props.title)).toEqual([
            'Personal Home',
            'Backup & Restore',
            'Protection',
            'Advanced',
            'Delete Home Data',
        ]);

        const rendersInGroup = (group: (typeof groups)[number], testID: string): boolean =>
            group.findAll((node) => node.props?.testID === testID).length > 0;
        const actionGroup = groups[1];
        const protectionGroup = groups[2];
        expect(rendersInGroup(actionGroup, 'settings.personalHomeRuntime.backup')).toBe(true);
        expect(rendersInGroup(actionGroup, 'settings.personalHomeRuntime.restore')).toBe(true);
        expect(rendersInGroup(actionGroup, 'settings.personalHomeRuntime.relocate')).toBe(true);
        expect(rendersInGroup(protectionGroup, 'settings.personalHomeRuntime.backup')).toBe(false);
        expect(rendersInGroup(protectionGroup, 'settings.personalHomeRuntime.lastBackup')).toBe(true);

        // One live operation keeps the shared progress block mounted for the ordering proof.
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backup');
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const order = screen.findAll(() => true);
        const positionOf = (testID: string): number => {
            const index = order.findIndex((node) => node.props?.testID === testID);
            if (index < 0) throw new Error(`expected ${testID} to be rendered`);
            return index;
        };
        expect(positionOf('settings.personalHomeRuntime.backup'))
            .toBeLessThan(positionOf('settings.personalHomeRuntime.restore'));
        expect(positionOf('settings.personalHomeRuntime.restore'))
            .toBeLessThan(positionOf('settings.personalHomeRuntime.operationSummary'));
        expect(positionOf('settings.personalHomeRuntime.operationSummary'))
            .toBeLessThan(positionOf('settings.personalHomeRuntime.lastBackup'));
        expect(positionOf('settings.personalHomeRuntime.lastBackup'))
            .toBeLessThan(positionOf('settings.localRelayRuntime.installOrUpdate'));
        expect(positionOf('settings.localRelayRuntime.installOrUpdate'))
            .toBeLessThan(positionOf('settings.personalHomeRuntime.eraseData'));
        expect(screen.findByTestId('settings.localRelayRuntime.installOrUpdate')?.props.title).toBe('Install or update Personal Home');
        expect(screen.findByTestId('settings.localRelayRuntime.start')?.props.title).toBe('Start Personal Home');
        expect(screen.findByTestId('settings.localRelayRuntime.stop')?.props.title).toBe('Stop Personal Home');
    });

    it('does not start Back Up Now when the plaintext clone-authority disclosure is declined', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backup');

        expect(confirmRef()).toHaveBeenCalledTimes(1);
        expect(confirmRef().mock.calls[0]?.[1]).toContain('operate a clone');
        expect(promptRef()).not.toHaveBeenCalled();
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.backup.v1')).toHaveLength(0);
    });

    it('starts the canonical backup task after the plaintext clone-authority disclosure is accepted', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backup');

        const backupSpec = harness.specByKind('relay.runtime.personal_home.backup.v1');
        expect(backupSpec?.params).toEqual({
            target: { kind: 'local' },
            channel: 'stable',
            mode: 'user',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        });

        await renderer.act(async () => {
            harness.resolveResult(harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!, true, BACKUP_RESULT_DATA);
        });

        const backupResult = screen.findByTestId('settings.personalHomeRuntime.backupResult');
        if (!backupResult) throw new Error('backup result was not rendered');
        expect(String(backupResult.props.subtitle)).not.toContain('/tmp/home-backup.tar');
        expect(String(backupResult.props.subtitle)).not.toContain('home-identity-1');
        expect(String(backupResult.props.subtitle)).toContain('8.0 KB');
        expect(String(backupResult.props.subtitle)).not.toContain('T00:00:00.000Z');

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backupResultDetails');
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.backupResultDetailsPanel')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.backupResultPath')?.props.subtitle).toBe('/tmp/home-backup.tar');
        expect(screen.findByTestId('settings.personalHomeRuntime.backupResultIdentity')?.props.subtitle).toBe('home-identity-1');
    });

    it('keeps Export Backup separate and passes only the native picker destination to the same owner', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => ' /tmp/chosen.tar ');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.exportBackup');

        expect(selectBackupExportDestination).toHaveBeenCalledTimes(1);
        expect(confirmRef()).toHaveBeenCalledTimes(1);
        expect(promptRef()).not.toHaveBeenCalled();
        const backupSpec = harness.specByKind('relay.runtime.personal_home.backup.v1');
        expect(backupSpec?.params.purpose).toEqual({ kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' });
        expect(backupSpec?.params.outputPath).toBe('/tmp/chosen.tar');
        // No transfer/publication callbacks, purpose, or env ride along with the operation spec.
        expect(Object.keys(backupSpec?.params ?? {}).sort()).toEqual([
            'channel',
            'mode',
            'outputPath',
            'purpose',
            'target',
        ]);
    });

    it('does not select an export destination or start a backup when disclosure is declined', async () => {
        const harness = createScriptedRunnerHarness();
        const selectBackupExportDestination = vi.fn(async () => '/tmp/chosen.tar');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.exportBackup');

        expect(confirmRef()).toHaveBeenCalledTimes(1);
        expect(selectBackupExportDestination).not.toHaveBeenCalled();
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.backup.v1')).toHaveLength(0);
    });

    it('surfaces native backup picker failures without starting an operation', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => {
            throw new Error('The backup destination picker is unavailable.');
        });
        const selectBackupArchive = vi.fn(async () => {
            throw new Error('The backup archive picker is unavailable.');
        });
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination, selectBackupArchive },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.exportBackup');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.verifyBackup');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restore');

        expect(alertRef()).toHaveBeenNthCalledWith(1, 'common.error', 'The backup destination picker is unavailable.');
        expect(alertRef()).toHaveBeenNthCalledWith(2, 'common.error', 'The backup archive picker is unavailable.');
        expect(alertRef()).toHaveBeenNthCalledWith(3, 'common.error', 'The backup archive picker is unavailable.');
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.backup.v1')).toHaveLength(0);
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.verify_backup.v1')).toHaveLength(0);
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.restore.v1')).toHaveLength(0);
    });

    it('freshly inspects a non-empty destination and starts restore after exactly one confirmation', async () => {
        const harness = createScriptedRunnerHarness();
        const selectBackupArchive = vi.fn(async () => '/a.tar');
        const revealBackupOutput = vi.fn(async () => {});
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupArchive, revealBackupOutput },
        }));
        confirmRef().mockResolvedValue(true);

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restore');

        const verificationTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.verify_backup.v1')).at(-1);
        expect(verificationTaskId).toBeTruthy();
        await waitForTaskSubscription(harness, verificationTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(verificationTaskId!, true, VERIFY_RESULT_DATA);
        });

        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const restoreInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1);
        expect(restoreInspectionTaskId).toBeTruthy();
        await waitForTaskSubscription(harness, restoreInspectionTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(restoreInspectionTaskId!, true, INSPECT_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.restore.v1', 1);

        const verificationRow = screen.findByTestId('settings.personalHomeRuntime.verifyResult');
        expect(String(verificationRow?.props.subtitle)).not.toContain('/a.tar');
        expect(String(verificationRow?.props.subtitle)).not.toContain('home-identity-1');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.verifyResultDetails');
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.verifyResultDetailsPanel')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.verifyResultPath')?.props.subtitle).toBe('/a.tar');
        expect(screen.findByTestId('settings.personalHomeRuntime.verifyResultIdentity')?.props.subtitle).toBe('home-identity-1');
        // The producer's machine value (match | mismatch | unknown) is mapped to a human label.
        expect(screen.findByTestId('settings.personalHomeRuntime.verifyResultIdentityComparison')?.props.subtitle).toBe('Matches');

        const verifySpec = harness.specByKind('relay.runtime.personal_home.verify_backup.v1');
        expect(selectBackupArchive).toHaveBeenCalledTimes(1);
        expect(promptRef()).not.toHaveBeenCalled();
        expect(verifySpec?.params).toEqual({
            target: { kind: 'local' },
            channel: 'stable',
            mode: 'user',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
            archivePath: '/a.tar',
        });

        const restoreSpec = harness.specByKind('relay.runtime.personal_home.restore.v1');
        expect(confirmRef()).toHaveBeenCalledTimes(1);
        expect(restoreSpec?.params).toEqual({
            target: { kind: 'local' },
            channel: 'stable',
            mode: 'user',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
            archivePath: '/a.tar',
            confirmOverwrite: true,
            expectedHomeServerIdentityId: 'home-identity-1',
        });
        const kinds = harness.startedSpecs.map((spec) => spec.kind);
        expect(kinds.indexOf('relay.runtime.personal_home.verify_backup.v1')).toBeLessThan(kinds.indexOf('relay.runtime.personal_home.restore.v1'));

        await renderer.act(async () => {
            harness.resolveResult(harness.taskIdByKind('relay.runtime.personal_home.restore.v1')!, true, {
                outcome: 'restored',
                rollbackPaths: ['/private/restore/rollback-home'],
                recoveryArchive: {
                    path: '/backups/personal-home-pre-restore.tar',
                    sha256: 'recovery-sha256',
                    archiveBytes: 16384,
                    manifest: {
                        format: 'happier-personal-home-backup',
                        version: 1,
                        createdAt: '2026-01-02T00:00:00.000Z',
                        homeServerIdentityId: 'home-identity-1',
                        entries: [],
                    },
                },
            });
        });
        expect(screen.findByTestId('settings.personalHomeRuntime.restoreResult')?.props.subtitle).toBe('Home restored');
        const recoveryBackup = screen.findByTestId('settings.personalHomeRuntime.restoreRecoveryBackup');
        // A successful restore kept a safety copy of the replaced data: it is
        // named as what it is, never as a repair warning or a repeated label.
        expect(recoveryBackup?.props.title).toBe('Previous data saved');
        expect(recoveryBackup?.props.subtitle).not.toContain('Backup verified');
        expect(screen.findByTestId('settings.personalHomeRuntime.restoreRecoveryBackupDetails')?.props.title).toMatch(/^Previous data saved · /);
        expect(recoveryBackup?.props.subtitle).toContain('16.0 KB');
        expect(recoveryBackup?.props.subtitle).not.toContain('home-identity-1');
        expect(recoveryBackup?.props.subtitle).not.toContain('/backups/personal-home-pre-restore.tar');
        expect(recoveryBackup?.props.subtitle).not.toContain('recovery-sha256');
        expect(screen.findByTestId('settings.personalHomeRuntime.restoreResult')?.props.subtitle).not.toContain('/private/restore/rollback-home');

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restoreRecoveryBackupDetails');
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.restoreRecoveryBackupDetailsPanel')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.restoreRecoveryBackupPath')?.props.subtitle).toBe('/backups/personal-home-pre-restore.tar');
        expect(screen.findByTestId('settings.personalHomeRuntime.restoreRecoveryBackupHash')?.props.subtitle).toBe('recovery-sha256');

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restoreRecoveryBackupReveal');
        expect(revealBackupOutput).toHaveBeenCalledWith('/backups/personal-home-pre-restore.tar');
    });

    it('restores into a freshly inspected empty destination without a confirmation', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupArchive: vi.fn(async () => '/empty-home.tar') },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restore');
        const verificationTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.verify_backup.v1')).at(-1);
        expect(verificationTaskId).toBeTruthy();
        await waitForTaskSubscription(harness, verificationTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(verificationTaskId!, true, VERIFY_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const restoreInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1);
        expect(restoreInspectionTaskId).toBeTruthy();
        await waitForTaskSubscription(harness, restoreInspectionTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(restoreInspectionTaskId!, true, {
                ...INSPECT_RESULT_DATA,
                storage: { ...INSPECT_RESULT_DATA.storage, destinationEmpty: true },
            });
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.restore.v1', 1);

        expect(confirmRef()).not.toHaveBeenCalled();
        expect(harness.specByKind('relay.runtime.personal_home.restore.v1')?.params).toEqual({
            target: { kind: 'local' },
            channel: 'stable',
            mode: 'user',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
            archivePath: '/empty-home.tar',
            expectedHomeServerIdentityId: 'home-identity-1',
        });
    });

    it('does not guess or prompt when destination inspection is unavailable', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupArchive: vi.fn(async () => '/unknown-home.tar') },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restore');
        const verificationTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.verify_backup.v1')).at(-1);
        expect(verificationTaskId).toBeTruthy();
        await waitForTaskSubscription(harness, verificationTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(verificationTaskId!, true, VERIFY_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const restoreInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1);
        expect(restoreInspectionTaskId).toBeTruthy();
        await waitForTaskSubscription(harness, restoreInspectionTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(restoreInspectionTaskId!, true, {
                ...INSPECT_RESULT_DATA,
                storage: { ...INSPECT_RESULT_DATA.storage, destinationEmpty: undefined },
            });
        });
        await renderer.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(confirmRef()).not.toHaveBeenCalled();
        expect(harness.specByKind('relay.runtime.personal_home.restore.v1')).toBeUndefined();
        expect(alertRef()).toHaveBeenCalledTimes(1);
    });

    it('surfaces the actionable inspection error and never restores or prompts after inspection fails', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupArchive: vi.fn(async () => '/inspection-failure.tar') },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restore');
        const verificationTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.verify_backup.v1')).at(-1);
        await waitForTaskSubscription(harness, verificationTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(verificationTaskId!, true, VERIFY_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const restoreInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1);
        await waitForTaskSubscription(harness, restoreInspectionTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(restoreInspectionTaskId!, false, undefined, 'Home inspection could not read the database.');
        });
        await renderer.act(async () => {});

        expect(confirmRef()).not.toHaveBeenCalled();
        expect(harness.specByKind('relay.runtime.personal_home.restore.v1')).toBeUndefined();
        expect(alertRef()).toHaveBeenCalledWith('common.error', 'Home inspection could not read the database.');
        expect(alertRef().mock.calls.flat().join('\n')).not.toContain('Recovery state is ambiguous');
    });

    it('does not offer rollback or finalization choices for a completed restore', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
        await resolveInitialInspectionWith(harness, {
            ...INSPECT_RESULT_DATA,
            restoreRecovery: { status: 'finalization_available', affectedTargets: ['/data/home', '/data/home.rollback'] },
        } as typeof INSPECT_RESULT_DATA);

        expect(screen.findByTestId('settings.personalHomeRuntime.recoverRestore')).toBeNull();
        expect(screen.findByTestId('settings.personalHomeRuntime.finalizeRestore')).toBeNull();
        const cleanupWarning = screen.findByTestId('settings.personalHomeRuntime.restoreRecoveryWarning');
        expect(cleanupWarning?.props.title).toBe('Restore cleanup needs attention');
        expect(cleanupWarning?.props.subtitle).toContain('cleanup');
        expect(cleanupWarning?.props.subtitle).not.toContain('ambiguous');
    });

    it('keeps ambiguous restore recovery distinct from completed-restore cleanup', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
        await resolveInitialInspectionWith(harness, {
            ...INSPECT_RESULT_DATA,
            restoreRecovery: { status: 'ambiguous', affectedTargets: ['/data/home', '/data/home.rollback'] },
        } as typeof INSPECT_RESULT_DATA);

        expect(screen.findByTestId('settings.personalHomeRuntime.recoverRestore')).toBeNull();
        expect(screen.findByTestId('settings.personalHomeRuntime.finalizeRestore')).toBeNull();
        const repairWarning = screen.findByTestId('settings.personalHomeRuntime.restoreRecoveryWarning');
        expect(repairWarning?.props.title).toBe('Restore needs repair');
        expect(repairWarning?.props.subtitle).toContain('ambiguous');
        expect(repairWarning?.props.subtitle).not.toContain('cleanup');
    });

    it('keeps one explicit rollback action for an interrupted restore', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
        await resolveInitialInspectionWith(harness, {
            ...INSPECT_RESULT_DATA,
            restoreRecovery: { status: 'rollback_available', affectedTargets: ['/data/home', '/data/home.rollback'] },
        } as typeof INSPECT_RESULT_DATA);

        expect(screen.findByTestId('settings.personalHomeRuntime.recoverRestore')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.finalizeRestore')).toBeNull();

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.recoverRestore');
        expect(confirmRef()).toHaveBeenCalledTimes(1);
        expect(confirmRef().mock.calls.at(-1)?.[1]).not.toContain('/data/home');
        expect(confirmRef().mock.calls.at(-1)?.[1]).not.toContain('/data/home.rollback');
    });

    it('can back up and verify first, refreshes facts, then starts erase with one destructive confirmation', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const selectBackupExportDestination = vi.fn(async () => ' /tmp/home-backup.tar ');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        expect(selectBackupExportDestination).toHaveBeenCalledTimes(1);
        expect(harness.specByKind('relay.runtime.personal_home.backup.v1')?.params.outputPath)
            .toBe('/tmp/home-backup.tar');
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => {
            harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA);
        });

        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        expect(harness.specByKind('relay.runtime.personal_home.verify_backup.v1')?.params.archivePath).toBe(BACKUP_RESULT_DATA.path);
        await waitForTaskSubscription(harness, verifyTaskId);
        harness.setStatusResultData({
            installed: true,
            dataPresent: true,
            version: '1',
            relayUrl: 'http://127.0.0.1:43123',
            healthy: true,
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
            anonymousSignupEnabled: false,
            service: { active: true, enabled: true },
            channel: 'preview',
            mode: 'system',
        });
        await renderer.act(async () => {
            harness.resolveResult(verifyTaskId, true, VERIFY_RESULT_DATA);
        });

        await waitForStartedKindCount(harness, 'relay.runtime.status.v1', 2);
        const kindsBeforeErase = harness.startedSpecs.map((spec) => spec.kind);
        expect(kindsBeforeErase.indexOf('relay.runtime.personal_home.verify_backup.v1'))
            .toBeLessThan(kindsBeforeErase.lastIndexOf('relay.runtime.status.v1'));

        // The composed safety branch suppresses backup's passive refresh so it cannot
        // contend with verification for the fail-fast Home operation lease. It then
        // refreshes and rebinds the runtime target before its one fresh inspection.
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.inspect.v1')).toHaveLength(2);
        const refreshedInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, refreshedInspectionTaskId);
        await renderer.act(async () => {
            harness.resolveResult(refreshedInspectionTaskId, true, INSPECT_RESULT_DATA);
        });

        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.erase.v1', 1);
        const confirmedTaskId = harness.taskIdByKind('relay.runtime.personal_home.erase.v1')!;
        await renderer.act(async () => {
            harness.emitErasePrompt(confirmedTaskId, ['/locked/new.sqlite', '/locked/files'], 4096);
        });
        await renderer.act(async () => {});
        expect(confirmRef().mock.calls.filter((call) => call[2]?.destructive === true)).toHaveLength(0);
        expect(showRef()).toHaveBeenCalledTimes(1);
        const erasePreviewConfig = showRef().mock.calls[0]?.[0];
        if (!erasePreviewConfig) throw new Error('erase preview modal was not shown');
        const erasePreview = await renderScreen(React.createElement(
            erasePreviewConfig.component,
            { ...(erasePreviewConfig.props as object), onClose: () => {} },
        ));
        expect(erasePreview.findByTestId('settings.personalHomeRuntime.erasePreviewHome')?.props.subtitle).toBe('http://127.0.0.1:43123');
        expect(erasePreview.findByTestId('settings.personalHomeRuntime.erasePreviewIdentity')?.props.subtitle).toBe('home-identity-1');
        expect(erasePreview.findByTestId('settings.personalHomeRuntime.erasePreviewSize')?.props.subtitle).toBe('4.0 KB');
        expect(erasePreview.findByTestId('settings.personalHomeRuntime.erasePreviewPath.0')?.props.subtitle).toBe('/locked/new.sqlite');
        expect(harness.respondMock).toHaveBeenCalledWith(confirmedTaskId, { confirmed: false });
        const eraseSpec = harness.specByKind('relay.runtime.personal_home.erase.v1');
        expect(eraseSpec?.params).toEqual({
            target: { kind: 'local' },
            channel: 'preview',
            mode: 'system',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        });
    });

    it('offers backup without presenting a destructive confirmation before the task preview', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
        await resolveInitialInspection(harness);
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            expect(buttons?.some((button) => button.style === 'destructive')).toBe(false);
            buttons?.find((button) => button.style !== 'cancel' && button.text !== 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);

        expect(confirmRef()).not.toHaveBeenCalled();
        expect(showRef()).not.toHaveBeenCalled();
    });

    it('does not select a destination, start backup, or erase when the backup offer is canceled', async () => {
        const harness = createScriptedRunnerHarness();
        const selectBackupExportDestination = vi.fn(async () => '/tmp/home-backup.tar');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.style === 'cancel')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await renderer.act(async () => {});

        expect(confirmRef()).not.toHaveBeenCalled();
        expect(selectBackupExportDestination).not.toHaveBeenCalled();
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.backup.v1')).toBe(false);
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
    });

    it('rejects a final erase prompt whose Home identity drifted after the verified backup and refreshed inspection', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => '/tmp/home-backup.tar');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        await waitForTaskSubscription(harness, verifyTaskId);
        await renderer.act(async () => harness.resolveResult(verifyTaskId, true, VERIFY_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const inspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, inspectionTaskId);
        await renderer.act(async () => harness.resolveResult(inspectionTaskId, true, INSPECT_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.erase.v1', 1);
        const eraseTaskId = harness.taskIdByKind('relay.runtime.personal_home.erase.v1')!;

        await renderer.act(async () => {
            harness.emitErasePrompt(eraseTaskId, ['/locked/new.sqlite'], 4096, 'different-home');
        });
        await renderer.act(async () => {});

        expect(confirmRef().mock.calls.filter((call) => call[2]?.destructive === true)).toHaveLength(0);
        expect(harness.respondMock).toHaveBeenCalledWith(eraseTaskId, { confirmed: false });
    });

    it('rejects a final erase prompt whose actual erase paths newly contain the verified backup', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => '/tmp/home-backup.tar');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        await waitForTaskSubscription(harness, verifyTaskId);
        await renderer.act(async () => harness.resolveResult(verifyTaskId, true, VERIFY_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const inspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, inspectionTaskId);
        await renderer.act(async () => harness.resolveResult(inspectionTaskId, true, INSPECT_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.erase.v1', 1);
        const eraseTaskId = harness.taskIdByKind('relay.runtime.personal_home.erase.v1')!;

        await renderer.act(async () => {
            harness.emitErasePrompt(eraseTaskId, ['/tmp'], 4096);
        });
        await renderer.act(async () => {});

        expect(confirmRef().mock.calls.filter((call) => call[2]?.destructive === true)).toHaveLength(0);
        expect(harness.respondMock).toHaveBeenCalledWith(eraseTaskId, { confirmed: false });
    });

    it('cancels backup-first erase when no external backup destination is selected', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => null);
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await renderer.act(async () => {});

        expect(selectBackupExportDestination).toHaveBeenCalledTimes(1);
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.backup.v1')).toBe(false);
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
    });

    it('does not erase when backup-first returns a different archive than the selected destination', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => '/exports/requested-home.tar');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => {
            harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA);
        });
        await renderer.act(async () => {});

        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.verify_backup.v1')).toBe(false);
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
        expect(alertRef()).toHaveBeenCalled();
    });

    it('keeps the verified backup visible and actionable when its Home identity cannot be matched', async () => {
        const harness = createScriptedRunnerHarness();
        const revealBackupOutput = vi.fn(async (_path: string) => {});
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: {
                selectBackupExportDestination: async () => '/tmp/home-backup.tar',
                selectBackupArchive: async () => '/tmp/restore.tar',
                revealBackupOutput,
            },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        await waitForTaskSubscription(harness, verifyTaskId);
        await renderer.act(async () => harness.resolveResult(verifyTaskId, true, {
            ...VERIFY_RESULT_DATA,
            identityMatchesCurrentHome: 'mismatch',
        }));
        await renderer.act(async () => {});

        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecovery')?.props.title)
            .toBe('Nothing was deleted');
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecovery')?.props.subtitle)
            .toBe('This backup is from a different Home.');
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecoveryPath')?.props.subtitle)
            .toBe('/tmp/home-backup.tar');
        expect(operationAnnouncement(screen)).toContain('Nothing was deleted');
        expect(operationAnnouncement(screen)).toContain('This backup is from a different Home.');
        expect(operationAnnouncement(screen)).not.toContain('/tmp/home-backup.tar');
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecoveryRefresh')).toBeTruthy();
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseBackupRecoveryReveal');
        expect(revealBackupOutput).toHaveBeenCalledWith('/tmp/home-backup.tar');

        // A later restore supersedes the blocked-erase notice without deleting
        // the preserved backup artifact from the user's recovery path.
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restore');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 2);
        const restoreVerifyId = harness.startedTaskIds.filter((id) => id.endsWith('relay.runtime.personal_home.verify_backup.v1')).at(-1)!;
        await waitForTaskSubscription(harness, restoreVerifyId);
        await renderer.act(async () => harness.resolveResult(restoreVerifyId, true, VERIFY_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const restoreInspectId = harness.startedTaskIds.filter((id) => id.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, restoreInspectId);
        await renderer.act(async () => harness.resolveResult(restoreInspectId, true, {
            ...INSPECT_RESULT_DATA,
            storage: { ...INSPECT_RESULT_DATA.storage, destinationEmpty: true },
        }));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.restore.v1', 1);
        const restoreId = harness.taskIdByKind('relay.runtime.personal_home.restore.v1')!;
        await waitForTaskSubscription(harness, restoreId);
        await renderer.act(async () => harness.resolveResult(restoreId, true, {
            outcome: 'restored', rollbackPaths: [], recoveryArchive: null,
        }));
        expect(operationAnnouncement(screen)).toContain('Home restored');
        expect(operationAnnouncement(screen)).not.toContain('Nothing was deleted');
    });

    it('announces a later erase instead of a stale nothing-deleted notice', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination: async () => '/tmp/home-backup.tar' },
        }));
        await resolveInitialInspection(harness);
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        await waitForTaskSubscription(harness, verifyTaskId);
        await renderer.act(async () => harness.resolveResult(verifyTaskId, true, {
            ...VERIFY_RESULT_DATA,
            identityMatchesCurrentHome: 'unknown',
        }));
        await renderer.act(async () => {});
        expect(operationAnnouncement(screen)).toContain('Nothing was deleted');

        // The user now deletes without a backup (the default offer choice here).
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const refreshedInspectionTaskId = harness.startedTaskIds
            .filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, refreshedInspectionTaskId);
        await renderer.act(async () => harness.resolveResult(refreshedInspectionTaskId, true, INSPECT_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.erase.v1', 1);
        const eraseTaskId = harness.taskIdByKind('relay.runtime.personal_home.erase.v1')!;
        await waitForTaskSubscription(harness, eraseTaskId);
        await renderer.act(async () => harness.resolveResult(eraseTaskId, true, {
            outcome: 'completed',
            removedPaths: ['/data/home.sqlite', '/data/files'],
            remainingOwnedPaths: [],
            remainingUnknownPaths: [],
            stoppedRunningHome: true,
        }));
        await renderer.act(async () => {});

        expect(operationAnnouncement(screen)).toContain('Removed 2 items');
        expect(operationAnnouncement(screen)).not.toContain('Nothing was deleted');
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecovery')).toBeNull();
    });

    it('keeps the verified backup visible when the runtime target changes before erase', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination: async () => '/tmp/home-backup.tar' },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA));
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        await waitForTaskSubscription(harness, verifyTaskId);
        harness.setStatusResultData({
            channel: 'stable',
            mode: 'user',
            installed: true,
            dataPresent: true,
            version: '1',
            relayUrl: 'http://127.0.0.1:43123',
            healthy: true,
            purpose: { kind: 'generic' },
            anonymousSignupEnabled: null,
            service: { active: true, enabled: true },
        });
        await renderer.act(async () => harness.resolveResult(verifyTaskId, true, VERIFY_RESULT_DATA));
        await renderer.act(async () => {});

        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecoveryPath')?.props.subtitle)
            .toBe('/tmp/home-backup.tar');
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecoveryRefresh')).toBeTruthy();
    });

    it('does not erase when the verified external archive is inside a freshly inspected erase root', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => '/tmp/home-backup.tar');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => {
            harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        await waitForTaskSubscription(harness, verifyTaskId);
        await renderer.act(async () => {
            harness.resolveResult(verifyTaskId, true, VERIFY_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const refreshedInspectionTaskId = harness.startedTaskIds
            .filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, refreshedInspectionTaskId);
        await renderer.act(async () => {
            harness.resolveResult(refreshedInspectionTaskId, true, {
                ...INSPECT_RESULT_DATA,
                storage: { ...INSPECT_RESULT_DATA.storage, ownedErasePaths: ['/tmp'] },
            });
        });
        await renderer.act(async () => {});

        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
        expect(alertRef()).toHaveBeenCalled();
    });

    it('does not erase a different Home discovered by the post-backup refresh', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const selectBackupExportDestination = vi.fn(async () => '/tmp/home-backup.tar');
        const revealBackupOutput = vi.fn(async (_path: string) => {});
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupExportDestination, revealBackupOutput },
        }));
        alertAsyncRef().mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.text === 'Back Up Now')?.onPress?.();
        });

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.backup.v1', 1);
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;
        await waitForTaskSubscription(harness, backupTaskId);
        await renderer.act(async () => {
            harness.resolveResult(backupTaskId, true, BACKUP_RESULT_DATA);
        });

        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.verify_backup.v1', 1);
        const verifyTaskId = harness.taskIdByKind('relay.runtime.personal_home.verify_backup.v1')!;
        await waitForTaskSubscription(harness, verifyTaskId);
        await renderer.act(async () => {
            harness.resolveResult(verifyTaskId, true, VERIFY_RESULT_DATA);
        });

        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const refreshedInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, refreshedInspectionTaskId);
        await renderer.act(async () => {
            harness.resolveResult(refreshedInspectionTaskId, true, {
                ...INSPECT_RESULT_DATA,
                identity: { ...INSPECT_RESULT_DATA.identity, homeServerIdentityId: 'different-home-identity' },
            });
        });

        await renderer.act(async () => {});
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(false);
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecoveryPath')?.props.subtitle)
            .toBe('/tmp/home-backup.tar');
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseBackupRecoveryRefresh')).toBeTruthy();
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseBackupRecoveryReveal');
        expect(revealBackupOutput).toHaveBeenCalledWith('/tmp/home-backup.tar');
    });

    it('explains why Personal Home controls are disabled for a generic runtime target', async () => {
        const harness = createScriptedRunnerHarness();
        harness.setStatusResultData({
            channel: 'stable',
            mode: 'user',
            installed: true,
            dataPresent: true,
            version: '1',
            relayUrl: 'http://127.0.0.1:43123',
            healthy: true,
            purpose: { kind: 'generic' },
            anonymousSignupEnabled: null,
            service: { active: true, enabled: true },
        });
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
        await renderer.act(async () => {});

        expect(screen.findByTestId('settings.personalHomeRuntime.backup')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.personalHomeRuntime.operationsUnavailable')?.props.subtitle)
            .toBe('settings.localRelayRuntime.statusChecking');
    });

    it('keeps erase, runtime uninstall, and profile removal as distinct controls that cannot call one another', async () => {
        const harness = createScriptedRunnerHarness();
        const removeProfile = vi.fn(async () => {});
        const uninstallRuntime = vi.fn(async () => {});
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { removeProfile, uninstallRuntime },
        }));
        await resolveInitialInspection(harness);

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const refreshedInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
        await waitForTaskSubscription(harness, refreshedInspectionTaskId);
        await renderer.act(async () => {
            harness.resolveResult(refreshedInspectionTaskId, true, INSPECT_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.erase.v1', 1);
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(true);
        expect(removeProfile).not.toHaveBeenCalled();
        expect(uninstallRuntime).not.toHaveBeenCalled();

        confirmRef().mockResolvedValue(true);
        const confirmationsBeforeProfileRemoval = confirmRef().mock.calls.length;
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.removeProfile');
        expect(removeProfile).toHaveBeenCalledTimes(1);
        expect(confirmRef()).toHaveBeenCalledTimes(confirmationsBeforeProfileRemoval);
        expect(uninstallRuntime).not.toHaveBeenCalled();
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toHaveLength(1);

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.uninstallRuntime');
        expect(uninstallRuntime).toHaveBeenCalledTimes(1);
        expect(removeProfile).toHaveBeenCalledTimes(1);
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1')).toHaveLength(1);
    });

    it('hides Move Home until a real resolver-backed action exists', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));

        expect(screen.findByTestId('settings.personalHomeRuntime.relocate')).toBeNull();
        expect(harness.startedSpecs.every((spec) => spec.kind !== 'relay.runtime.personal_home.relocate.v1')).toBe(true);
    });

    it('starts the resolver-backed SSH relocation task after one source-deactivation confirmation and answers only its bound publication prompt', async () => {
        const harness = createScriptedRunnerHarness();
        const respondToPrompt = vi.fn(async () => ({ descriptor: {
            v: 1,
            homeServerIdentityId: 'home-identity-1',
            canonicalServerUrl: 'https://destination.example.test',
            revision: 2,
            endpoints: [{ kind: 'https', url: 'https://destination.example.test' }],
        } }));
        const prepare = vi.fn(async (): Promise<PreparedPersonalHomeRelocationTask> => createPreparedRelocationTask({
            spec: {
                protocolVersion: 1,
                kind: 'remote.ssh.manageHost.v1',
                params: {
                    action: 'personalHome.relocate',
                    personalHomeRelocation: {
                        operationId: 'relocation-1',
                        destinationMachineId: 'managed-host-1',
                        sourceDescriptorRevision: 1,
                    },
                },
            },
            respondToPrompt,
        }));
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: {
                relocation: {
                    destinations: [{ id: 'managed-host-1', title: 'Home server', subtitle: 'ops@destination.example.test' }],
                    prepare,
                },
            },
        }));
        await resolveInitialInspection(harness);
        await renderer.act(async () => {});

        confirmRef().mockResolvedValueOnce(true);
        const relocationMenu = screen.findByType('DropdownMenu');
        await renderer.act(async () => {
            relocationMenu.props.onSelect('managed-host-1');
        });
        await renderer.act(async () => {});

        expect(prepare).toHaveBeenCalledWith('managed-host-1');
        expect(confirmRef()).toHaveBeenCalledTimes(1);
        expect(harness.specByKind('remote.ssh.manageHost.v1')?.params).toMatchObject({
            action: 'personalHome.relocate',
            personalHomeRelocation: { operationId: 'relocation-1', destinationMachineId: 'managed-host-1' },
        });
        expect(harness.startedSpecs.some((spec) => spec.kind === 'relay.runtime.personal_home.relocate.v1')).toBe(false);

        const taskId = harness.taskIdByKind('remote.ssh.manageHost.v1')!;
        await renderer.act(async () => {
            harness.emitRelocationPrompt(taskId, 'personal_home.publish_relocation_descriptor.v1', {
                operationId: 'relocation-1',
                homeServerIdentityId: 'home-identity-1',
            });
        });
        await renderer.act(async () => {});
        expect(respondToPrompt).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'personal_home.publish_relocation_descriptor.v1',
        }));
        expect(harness.respondMock).toHaveBeenCalledWith(taskId, expect.objectContaining({ descriptor: expect.any(Object) }));
    });

    it('offers Cancel only during the relocation coordinator reversible window', async () => {
        const harness = createScriptedRunnerHarness();
        const prepare = vi.fn(async (): Promise<PreparedPersonalHomeRelocationTask> => createPreparedRelocationTask({
            spec: {
                protocolVersion: 1,
                kind: 'remote.ssh.manageHost.v1',
                params: {
                    action: 'personalHome.relocate',
                    personalHomeRelocation: { operationId: 'relocation-cancel', destinationMachineId: 'managed-host-1', sourceDescriptorRevision: 1 },
                },
            },
            respondToPrompt: async () => ({ descriptor: null }),
        }));
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { relocation: { destinations: [{ id: 'managed-host-1', title: 'Home server' }], prepare } },
        }));
        await resolveInitialInspection(harness);
        confirmRef().mockResolvedValueOnce(true);
        await renderer.act(async () => {
            screen.findByType('DropdownMenu').props.onSelect('managed-host-1');
        });
        await renderer.act(async () => {});
        const taskId = harness.taskIdByKind('remote.ssh.manageHost.v1')!;

        await renderer.act(async () => {
            harness.emitProgress(taskId, 'personal_home.staging_destination', 'Moving the verified Home');
        });
        const cancel = screen.findByTestId('system-task-progress-cancel');
        expect(cancel).toBeTruthy();
        await renderer.act(async () => cancel!.props.onPress());
        expect(harness.cancelMock).toHaveBeenCalledWith(taskId);

        await renderer.act(async () => {
            harness.emitProgress(taskId, 'personal_home.publishing_destination', 'Publishing the new Home location');
        });
        expect(screen.findByTestId('system-task-progress-cancel')).toBeNull();
    });

    it('continues and rediscovers a bound relocation publication exactly once across settings unmount/remount', async () => {
        const harness = createScriptedRunnerHarness();
        const respondToPrompt = vi.fn(async () => ({ descriptor: {
            v: 1,
            homeServerIdentityId: 'home-identity-1',
            canonicalServerUrl: 'https://destination.example.test',
            revision: 2,
            endpoints: [{ kind: 'https', url: 'https://destination.example.test' }],
        } }));
        const prepare = vi.fn(async (): Promise<PreparedPersonalHomeRelocationTask> => createPreparedRelocationTask({
            spec: {
                protocolVersion: 1,
                kind: 'remote.ssh.manageHost.v1',
                params: {
                    action: 'personalHome.relocate',
                    personalHomeRelocation: { operationId: 'relocation-unmount', destinationMachineId: 'managed-host-1', sourceDescriptorRevision: 1 },
                },
            },
            respondToPrompt,
        }));
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { relocation: { destinations: [{ id: 'managed-host-1', title: 'Home server' }], prepare } },
        }));
        await resolveInitialInspection(harness);
        confirmRef().mockResolvedValueOnce(true);
        await renderer.act(async () => {
            screen.findByType('DropdownMenu').props.onSelect('managed-host-1');
        });
        await renderer.act(async () => {});
        const taskId = harness.taskIdByKind('remote.ssh.manageHost.v1')!;

        await screen.unmount();
        await renderer.act(async () => {
            harness.emitRelocationPrompt(taskId, 'personal_home.publish_relocation_descriptor.v1', {
                operationId: 'relocation-unmount',
                homeServerIdentityId: 'home-identity-1',
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const remounted = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { relocation: { destinations: [{ id: 'managed-host-1', title: 'Home server' }], prepare } },
        }));
        await renderer.act(async () => {});
        expect(remounted.findByTestId('settings.personalHomeRuntime.operationSummary')).toBeTruthy();

        await renderer.act(async () => {
            harness.emitRelocationPrompt(taskId, 'personal_home.publish_relocation_descriptor.v1', {
                operationId: 'relocation-unmount',
                homeServerIdentityId: 'home-identity-1',
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(respondToPrompt).toHaveBeenCalledTimes(1);
        expect(harness.respondMock).toHaveBeenCalledTimes(1);
        expect(harness.respondMock).toHaveBeenCalledWith(taskId, expect.objectContaining({ descriptor: expect.any(Object) }));
    });

    it('surfaces only the coordinator-selected relocation recovery and resumes it through the same remote task owner', async () => {
        const harness = createScriptedRunnerHarness();
        const respondToPrompt = vi.fn(async () => ({ descriptor: null }));
        const prepare = vi.fn(async (): Promise<PreparedPersonalHomeRelocationTask> => createPreparedRelocationTask({
            spec: {
                protocolVersion: 1,
                kind: 'remote.ssh.manageHost.v1',
                params: { action: 'personalHome.relocate' },
            },
            respondToPrompt,
        }));
        const prepareRecovery = vi.fn(async (recovery: Readonly<{
            operationId: string;
            destinationMachineId: string;
            sourceDescriptorRevision: number;
            recoveryAction: 'finish_move' | 'return_to_source';
        }>): Promise<PreparedPersonalHomeRelocationTask> => createPreparedRelocationTask({
            spec: {
                protocolVersion: 1,
                kind: 'remote.ssh.manageHost.v1',
                params: {
                    action: 'personalHome.relocate',
                    personalHomeRelocation: recovery,
                },
            },
            respondToPrompt,
        }));
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: {
                relocation: {
                    destinations: [{ id: 'managed-host-1', title: 'Home server' }],
                    prepare,
                    prepareRecovery,
                },
            },
        }));
        await resolveInitialInspection(harness);
        confirmRef().mockResolvedValueOnce(true);
        await renderer.act(async () => {
            screen.findByType('DropdownMenu').props.onSelect('managed-host-1');
        });
        await renderer.act(async () => {});
        const taskId = harness.taskIdByKind('remote.ssh.manageHost.v1')!;
        await renderer.act(async () => {
            harness.resolveResult(taskId, true, {
                action: 'personalHome.relocate',
                personalHome: {
                    operationId: 'relocation-1',
                    destinationMachineId: 'managed-host-1',
                    sourceDescriptorRevision: 1,
                    status: 'pending',
                    recoveryAction: 'finish_move',
                },
            });
        });

        const recovery = screen.findByTestId('settings.personalHomeRuntime.recoverRelocation');
        expect(recovery).toBeTruthy();
        expect(recovery?.props.title).toBe('Finish Moving');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.recoverRelocation');
        expect(prepareRecovery).toHaveBeenCalledWith({
            operationId: 'relocation-1',
            destinationMachineId: 'managed-host-1',
            sourceDescriptorRevision: 1,
            recoveryAction: 'finish_move',
        });
        expect(harness.startedSpecs.filter((spec) => spec.kind === 'remote.ssh.manageHost.v1')).toHaveLength(2);
        expect(harness.startedSpecs.at(-1)?.params).toMatchObject({
            action: 'personalHome.relocate',
            personalHomeRelocation: {
                operationId: 'relocation-1',
                recoveryAction: 'finish_move',
            },
        });
        expect(confirmRef()).toHaveBeenCalledTimes(1);
    });

    it('derives the two authority-safe recovery actions from durable inspection facts after reopening settings', async () => {
        const harness = createScriptedRunnerHarness();
        const prepareRecovery = vi.fn(async (recovery: Readonly<{
            operationId: string;
            destinationMachineId: string;
            sourceDescriptorRevision: number;
            recoveryAction: 'finish_move' | 'return_to_source';
        }>): Promise<PreparedPersonalHomeRelocationTask> => createPreparedRelocationTask({
            spec: {
                protocolVersion: 1,
                kind: 'remote.ssh.manageHost.v1',
                params: { action: 'personalHome.relocate', personalHomeRelocation: recovery },
            },
            respondToPrompt: async () => ({ descriptor: null }),
        }));
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: {
                relocation: {
                    destinations: [{ id: 'managed-host-1', title: 'Home server' }],
                    prepare: async () => { throw new Error('not used'); },
                    prepareRecovery,
                },
            },
        }));
        await resolveInitialInspectionWith(harness, {
            ...INSPECT_RESULT_DATA,
            relocationRecovery: {
                status: 'recovery_available',
                operationId: 'relocation-1',
                destinationMachineId: 'managed-host-1',
                sourceDescriptorRevision: 1,
                primaryAction: 'finish_move',
                secondaryAction: 'return_to_source',
            },
        });

        expect(screen.findByTestId('settings.personalHomeRuntime.recoverRelocation')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.recoverRelocationReturn')).toBeTruthy();
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.recoverRelocationReturn');
        expect(prepareRecovery).toHaveBeenCalledWith({
            operationId: 'relocation-1',
            destinationMachineId: 'managed-host-1',
            sourceDescriptorRevision: 1,
            recoveryAction: 'return_to_source',
        });
        expect(confirmRef()).not.toHaveBeenCalled();
    });

    it('offers only Finish Moving once the durable facts no longer carry a safe return action', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: {
                relocation: {
                    destinations: [{ id: 'managed-host-1', title: 'Home server' }],
                    prepare: async () => { throw new Error('not used'); },
                    prepareRecovery: async () => { throw new Error('not used'); },
                },
            },
        }));
        await resolveInitialInspectionWith(harness, {
            ...INSPECT_RESULT_DATA,
            relocationRecovery: {
                status: 'recovery_available',
                operationId: 'relocation-1',
                destinationMachineId: 'managed-host-1',
                sourceDescriptorRevision: 1,
                primaryAction: 'finish_move',
            },
        });

        expect(screen.findByTestId('settings.personalHomeRuntime.recoverRelocation')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.recoverRelocationReturn')).toBeNull();
    });

    it('keeps the terminal failed snapshot rendered with truthful stages and announces the failure assertively', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backup');
        const backupTaskId = harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!;

        await renderer.act(async () => {
            harness.emitProgress(backupTaskId, 'personal_home.backup', 'Creating backup archive');
        });

        // Polite live progress while running.
        const progressAnnouncer = screen.findByTestId('system-task-a11y-progress');
        if (!progressAnnouncer) throw new Error('progress announcer was not rendered');
        expect(progressAnnouncer.props.accessibilityLiveRegion).toBe('polite');

        await renderer.act(async () => {
            harness.resolveResult(backupTaskId, false, undefined, 'sqlite_snapshot_unstable');
        });

        // The terminal snapshot remains visible as one calm phase; the technical checklist is disclosed on demand.
        expect(screen.findByTestId('settings.personalHomeRuntime.operationSummary')).toBeTruthy();
        expect(screen.findByTestId('system-task-progress-card')).toBeNull();
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.operationDetails');
        expect(screen.findByTestId('system-task-progress-card')).toBeTruthy();
        expect(screen.findByTestId('system-task-progress-status-failed')).toBeTruthy();
        expect(screen.findByTestId('system-task-progress-checklist-step-failed-personal-home-backup')).toBeTruthy();

        // The failure is announced assertively; the polite progress announcer is gone.
        const failureAnnouncer = screen.findByTestId('system-task-a11y-failure');
        if (!failureAnnouncer) throw new Error('failure announcer was not rendered');
        expect(failureAnnouncer.props.accessibilityLiveRegion).toBe('assertive');
        // It speaks a mapped summary; the raw daemon message stays in Details.
        expect(String(failureAnnouncer.props.children)).not.toContain('sqlite_snapshot_unstable');
        expect(String(failureAnnouncer.props.children)).toContain('didn’t finish');
        expect(screen.findByTestId('system-task-a11y-progress')).toBeNull();

        // Dismissal clears the retained result.
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.dismissResult');
        expect(screen.findByTestId('system-task-progress-card')).toBeNull();
        expect(screen.findByTestId('system-task-a11y-failure')).toBeNull();
    });

    it('restarts through the real lifecycle task of the composed runtime owner', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restart');

        expect(harness.specByKind('relay.runtime.restart.v1')).toBeTruthy();
        expect(harness.startedSpecs.every((spec) => !spec.kind.startsWith('relay.runtime.personal_home.erase'))).toBe(true);
    });

    it('disables the Personal Home operations when the system task bridge is unavailable', async () => {
        const harness = createScriptedRunnerHarness();
        const unavailableRunner = createSystemTaskRunner({
            mode: 'unavailable',
            bridge: {
                start: harness.startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: unavailableRunner }));

        expect(harness.startMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.backup')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.personalHomeRuntime.restore')).toBeNull();
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseData')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.personalHomeRuntime.inspect')?.props.disabled).toBe(true);
    });

    it('shows the canonical Last backup fact from the inspect result and never a second persisted UI cache', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));

        // Before inspection resolves, the row states the honest unknown instead of guessing.
        expect(screen.findByTestId('settings.personalHomeRuntime.lastBackup')?.props.subtitle).toContain('unknown');

        await resolveInitialInspectionWith(harness, INSPECT_RESULT_DATA);
        const row = screen.findByTestId('settings.personalHomeRuntime.lastBackup');
        expect(String(row?.props.subtitle)).toContain('2026');
    });

    it('keeps verified backup facts calm in the primary row and exposes technical facts through Details', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValueOnce(true);
        const revealBackupOutput = vi.fn(async (_path: string) => {});
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { revealBackupOutput },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backup');
        await renderer.act(async () => {
            harness.resolveResult(harness.taskIdByKind('relay.runtime.personal_home.backup.v1')!, true, BACKUP_RESULT_DATA);
        });

        const resultRow = screen.findByTestId('settings.personalHomeRuntime.backupResult');
        expect(String(resultRow?.props.subtitle)).not.toContain('/tmp/home-backup.tar');
        expect(String(resultRow?.props.subtitle)).toContain('8.0 KB');
        expect(String(resultRow?.props.subtitle)).not.toContain('home-identity-1');
        expect(String(resultRow?.props.subtitle)).toContain('2026');
        expect(String(resultRow?.props.subtitle)).not.toContain('T00:00:00.000Z');

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backupResultDetails');
        expect(alertRef()).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.personalHomeRuntime.backupResultDetailsPanel')).toBeTruthy();
        expect(screen.findByTestId('settings.personalHomeRuntime.backupResultPath')?.props.subtitle).toBe('/tmp/home-backup.tar');
        expect(screen.findByTestId('settings.personalHomeRuntime.backupResultIdentity')?.props.subtitle).toBe('home-identity-1');

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.backupReveal');
        expect(revealBackupOutput).toHaveBeenCalledWith('/tmp/home-backup.tar');
    });

    it('exposes the typed restore recovery outcome without leaking internal rollback paths into primary UI', async () => {
        const harness = createScriptedRunnerHarness();
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { selectBackupArchive: async () => '/a.tar' },
        }));
        await resolveInitialInspectionWith(harness, INSPECT_RESULT_DATA);

        confirmRef().mockResolvedValue(true);
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restore');
        const verificationTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.verify_backup.v1')).at(-1);
        expect(verificationTaskId).toBeTruthy();
        await waitForTaskSubscription(harness, verificationTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(verificationTaskId!, true, VERIFY_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', 2);
        const restoreInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1);
        await waitForTaskSubscription(harness, restoreInspectionTaskId!);
        await renderer.act(async () => {
            harness.resolveResult(restoreInspectionTaskId!, true, INSPECT_RESULT_DATA);
        });
        await waitForStartedKindCount(harness, 'relay.runtime.personal_home.restore.v1', 1);
        await renderer.act(async () => {
            harness.resolveResult(harness.taskIdByKind('relay.runtime.personal_home.restore.v1')!, true, {
                outcome: 'recovery_required',
                rollbackPaths: ['/home/.happier/self-host/data/.operations/rollback-previous'],
                error: 'health check failed after swap',
            });
        });

        const row = screen.findByTestId('settings.personalHomeRuntime.restoreResult');
        const subtitle = String(row?.props.subtitle ?? '');
        expect(subtitle).toContain('Recovery needed');
        expect(subtitle).not.toContain('health check failed after swap');
        expect(subtitle).not.toContain('/home/.happier/self-host/data/.operations/rollback-previous');
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restoreResultDetails');
        expect(screen.getTextContent()).toContain('health check failed after swap');
        expect(screen.getTextContent()).not.toContain('/home/.happier/self-host/data/.operations/rollback-previous');
        expect(operationAnnouncement(screen)).toContain('Recovery needed');
        expect(operationAnnouncement(screen)).not.toContain('health check failed after swap');
    });

    it('opens the canonical Home data and log locations through the injected production path opener', async () => {
        const harness = createScriptedRunnerHarness();
        const openDataLocation = vi.fn(async (_path: string) => {});
        const openLogs = vi.fn(async (_path: string) => {});
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            runner: harness.runner,
            operations: { openDataLocation, openLogs },
        }));

        await resolveInitialInspectionWith(harness, INSPECT_RESULT_DATA);

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.openDataLocation');
        expect(openDataLocation).toHaveBeenCalledWith('/home/.happier/self-host/data');

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.openLogs');
        expect(openLogs).toHaveBeenCalledWith('/home/.happier/self-host/logs');
    });

    it('hides Cancel once the running operation passed its irreversible boundary and keeps it before that', async () => {
        const harness = createScriptedRunnerHarness();
        confirmRef().mockResolvedValue(true);

        const cases: ReadonlyArray<Readonly<{ stepId: string; cancelVisible: boolean }>> = [
            { stepId: 'personal_home.inspecting', cancelVisible: true },
            { stepId: 'personal_home.stopping_home', cancelVisible: false },
            { stepId: 'personal_home.checkpointing', cancelVisible: false },
        ];

        for (const testCase of cases) {
            const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
            await screen.pressByTestIdAsync('settings.personalHomeRuntime.backup');
            const backupTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.backup.v1')).at(-1);
            if (!backupTaskId) throw new Error('backup operation task was not started');
            await renderer.act(async () => {
                harness.emitProgress(backupTaskId, testCase.stepId);
            });
            const cancelButton = screen.findByTestId('system-task-progress-cancel');
            expect(Boolean(cancelButton)).toBe(testCase.cancelVisible);
        }

        // Erase stays cancellable through explicit confirmation and loses Cancel at the erasing boundary.
        const eraseCases: ReadonlyArray<Readonly<{ stepId: string; cancelVisible: boolean }>> = [
            { stepId: 'personal_home.awaiting_confirmation', cancelVisible: true },
            { stepId: 'personal_home.erasing', cancelVisible: false },
        ];
        for (const testCase of eraseCases) {
            const inspectionsBeforeRender = harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.inspect.v1').length;
            const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { runner: harness.runner }));
            await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', inspectionsBeforeRender + 1);
            const initialInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
            await waitForTaskSubscription(harness, initialInspectionTaskId);
            await renderer.act(async () => {
                harness.resolveResult(initialInspectionTaskId, true, INSPECT_RESULT_DATA);
            });
            confirmRef().mockResolvedValue(false);
            const inspectionsBeforeErase = harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.inspect.v1').length;
            const erasesBeforeErase = harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1').length;
            await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
            await waitForStartedKindCount(harness, 'relay.runtime.personal_home.inspect.v1', inspectionsBeforeErase + 1);
            const refreshedInspectionTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.inspect.v1')).at(-1)!;
            await waitForTaskSubscription(harness, refreshedInspectionTaskId);
            await renderer.act(async () => {
                harness.resolveResult(refreshedInspectionTaskId, true, INSPECT_RESULT_DATA);
            });
            await waitForStartedKindCount(
                harness,
                'relay.runtime.personal_home.erase.v1',
                erasesBeforeErase + 1,
            );
            const eraseTaskId = harness.startedTaskIds.filter((taskId) => taskId.endsWith('relay.runtime.personal_home.erase.v1')).at(-1);
            if (!eraseTaskId) throw new Error('erase operation task was not started');
            await renderer.act(async () => {
                harness.emitProgress(eraseTaskId, testCase.stepId);
            });
            const cancelButton = screen.findByTestId('system-task-progress-cancel');
            expect(Boolean(cancelButton)).toBe(testCase.cancelVisible);
        }
    });
});
