import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let sessionPath: string | null = null;
let sessionsReady = false;

const sessionScmDiffFileMock = vi.fn(async () => ({ success: true, diff: 'diff --git a/a.txt b/a.txt' }));
const sessionReadFileMock = vi.fn(async () => ({ success: false, error: 'read unavailable' }));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({
        id: 'session-1',
        path: 'a.txt',
    }),
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        View: (props: any) => React.createElement('View', props, props.children),
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

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
    useFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(),
    }),
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: sessionScmDiffFileMock,
    sessionReadFile: sessionReadFileMock,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: sessionPath
                ? {
                    'session-1': {
                        metadata: {
                            path: sessionPath,
                        },
                    },
                }
                : {},
        }),
    },
    useSession: () =>
        sessionPath
            ? {
                metadata: {
                    path: sessionPath,
                },
            }
            : null,
    useSessions: () => (sessionsReady ? [] : null),
    useSessionProjectScmInFlightOperation: () => null,
    useSessionProjectScmSnapshot: () => ({
        entries: [],
        hasConflicts: false,
    }),
    useSessionProjectScmCommitSelectionPaths: () => [],
    useSetting: () => null,
}));

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fingerprint',
    canUseLineSelection: () => false,
}));

vi.mock('@/scm/operations/featureFlags', () => ({
    resolveScmWriteEnabled: () => true,
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    getFileLanguageFromPath: () => 'plaintext',
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
    it('retries file load when session path appears after first render', async () => {
        const { default: FileScreen } = await import('./file');
        sessionPath = null;
        sessionsReady = false;
        sessionScmDiffFileMock.mockClear();
        sessionReadFileMock.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(React.createElement(FileScreen));
        });

        expect(sessionScmDiffFileMock).not.toHaveBeenCalled();

        sessionPath = '/tmp/workspace';
        sessionsReady = true;
        await act(async () => {
            tree!.update(React.createElement(FileScreen));
        });

        expect(sessionScmDiffFileMock).toHaveBeenCalledTimes(1);
        expect(sessionReadFileMock).toHaveBeenCalledTimes(1);
    });
});
