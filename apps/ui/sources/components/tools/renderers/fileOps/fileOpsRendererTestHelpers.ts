import * as React from 'react';
import { vi } from 'vitest';

type FileOpsRendererModuleFactory = () => unknown | Promise<unknown>;
type FileOpsRendererImportOriginal = <T = unknown>() => Promise<T>;
type FileOpsRendererStorageModuleFactory = (
    importOriginal: FileOpsRendererImportOriginal,
) => unknown | Promise<unknown>;

type InstallFileOpsRendererCommonModuleMocksOptions = Readonly<{
    modal?: FileOpsRendererModuleFactory;
    reactNative?: FileOpsRendererModuleFactory;
    storage?: FileOpsRendererStorageModuleFactory;
    text?: FileOpsRendererModuleFactory;
    unistyles?: FileOpsRendererModuleFactory;
}>;

const fileOpsRendererModuleState = vi.hoisted(() => ({
    toolDiffSpy: vi.fn(),
    options: {
        modal: undefined as FileOpsRendererModuleFactory | undefined,
        reactNative: undefined as FileOpsRendererModuleFactory | undefined,
        storage: undefined as FileOpsRendererStorageModuleFactory | undefined,
        text: undefined as FileOpsRendererModuleFactory | undefined,
        unistyles: undefined as FileOpsRendererModuleFactory | undefined,
    },
}));

export function resetFileOpsRendererCommonModuleMockState() {
    fileOpsRendererModuleState.toolDiffSpy.mockReset();
    fileOpsRendererModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installFileOpsRendererCommonModuleMocks(
    options: InstallFileOpsRendererCommonModuleMocksOptions = {},
) {
    fileOpsRendererModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = fileOpsRendererModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', () => ({
        Octicons: 'Octicons',
    }));

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = fileOpsRendererModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = fileOpsRendererModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = fileOpsRendererModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = fileOpsRendererModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('../../shell/presentation/ToolSectionView', () => ({
        ToolSectionView: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
    }));

    vi.mock('@/components/tools/shell/presentation/ToolDiffView', () => ({
        ToolDiffView: (props: Record<string, unknown>) => {
            fileOpsRendererModuleState.toolDiffSpy(props);
            return React.createElement('ToolDiffView', props);
        },
    }));

    vi.mock('@/components/ui/text/Text', () => ({
        Text: 'Text',
        TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
    }));
}

export { fileOpsRendererModuleState };
