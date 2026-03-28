import { vi } from 'vitest';

type TranscriptModuleFactory = () => unknown | Promise<unknown>;
type TranscriptImportOriginal = <T = unknown>() => Promise<T>;
type TranscriptStorageModuleFactory = (
    importOriginal: TranscriptImportOriginal,
) => unknown | Promise<unknown>;

type InstallTranscriptCommonModuleMocksOptions = Readonly<{
    modal?: TranscriptModuleFactory;
    reactNative?: TranscriptModuleFactory;
    storage?: TranscriptStorageModuleFactory;
    text?: TranscriptModuleFactory;
    unistyles?: TranscriptModuleFactory;
}>;

const transcriptModuleState = vi.hoisted(() => ({
    modalMockRef: { current: null as any },
    options: {
        modal: undefined as TranscriptModuleFactory | undefined,
        reactNative: undefined as TranscriptModuleFactory | undefined,
        storage: undefined as TranscriptStorageModuleFactory | undefined,
        text: undefined as TranscriptModuleFactory | undefined,
        unistyles: undefined as TranscriptModuleFactory | undefined,
    },
}));

export function getTranscriptModalMockRef() {
    return transcriptModuleState.modalMockRef as { current: any };
}

export function resetTranscriptCommonModuleMockState() {
    transcriptModuleState.modalMockRef.current = null;
}

export function installTranscriptCommonModuleMocks(
    options: InstallTranscriptCommonModuleMocksOptions = {},
) {
    transcriptModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = transcriptModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        transcriptModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});
}
