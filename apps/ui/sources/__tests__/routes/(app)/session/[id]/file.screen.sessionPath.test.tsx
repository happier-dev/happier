import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockFilePathParam = 'a.txt';
const routerReplaceSpy = vi.fn();
const openDetailsTabSpy = vi.fn();
let shouldRedirectToPanes = false;

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({
        id: 'session-1',
        path: mockFilePathParam,
    }),
    useRouter: () => ({
        back: vi.fn(),
        push: vi.fn(),
        replace: routerReplaceSpy,
    }),
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        View: (props: any) => React.createElement('View', props, props.children),
        useWindowDimensions: () => ({
            width: 1400,
            height: 900,
            scale: 1,
            fontScale: 1,
        }),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
            },
        },
    }),
    StyleSheet: {
        create: (styles: any) => styles,
    },
}));

vi.mock('@/components/sessions/files/file/FileActionToolbar', () => ({
    FileActionToolbar: () => React.createElement('FileActionToolbar'),
}));

vi.mock('@/components/sessions/files/file/FileContentPanel', () => ({
    FileContentPanel: () => React.createElement('FileContentPanel'),
}));

vi.mock('@/components/sessions/files/file/FileHeader', () => ({
    FileHeader: () => React.createElement('FileHeader'),
}));

vi.mock('@/components/sessions/files/file/FileScreenState', () => ({
    FileBinaryState: () => React.createElement('FileBinaryState'),
    FileErrorState: () => React.createElement('FileErrorState'),
    FileLoadingState: () => React.createElement('FileLoadingState'),
}));

vi.mock('@/components/sessions/files/file/editor/FileEditorPanel', () => ({
    FileEditorPanel: () => React.createElement('FileEditorPanel'),
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
    useFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(),
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => false,
}));

vi.mock('@/components/ui/panels/shouldRedirectDetailsRouteToPanes', () => ({
    shouldRedirectDetailsRouteToPanes: () => shouldRedirectToPanes,
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useDeviceType: () => 'tablet',
        getDeviceType: () => 'tablet',
    };
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab: openDetailsTabSpy,
    }),
}));

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fingerprint',
    canUseLineSelection: () => false,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/code/fileLanguage', () => ({
    getFileLanguageFromPath: () => 'plaintext',
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

vi.mock('@/scm/utils/filePathParam', () => ({
    decodeSessionFilePathParam: (value: string) => value,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/encryption/base64', () => ({
    decodeBase64: () => new Uint8Array(),
}));

describe('FileScreen session path hydration', () => {
    it('redirects away from unsafe file path params', async () => {
        vi.resetModules();
        const { default: FileScreen } = await import('@/app/(app)/session/[id]/file');
        shouldRedirectToPanes = false;
        mockFilePathParam = '../secrets.txt';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();

        await act(async () => {
            renderer.create(React.createElement(FileScreen));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(routerReplaceSpy).toHaveBeenCalledTimes(1);
        expect(openDetailsTabSpy).not.toHaveBeenCalled();
    });

    it('redirects to panes when details routes should be in the right panel', async () => {
        vi.resetModules();
        const { default: FileScreen } = await import('@/app/(app)/session/[id]/file');
        shouldRedirectToPanes = true;
        mockFilePathParam = 'a.txt';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();

        await act(async () => {
            renderer.create(React.createElement(FileScreen));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(openDetailsTabSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledTimes(1);
    });
});
