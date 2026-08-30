import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';
import type { SessionFileEditorState } from './useSessionFileEditorState';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installSessionFileDetailsCommonModuleMocks();

type SessionWriteFileFn = typeof import('@/sync/ops').sessionWriteFile;
const sessionWriteFileSpy = vi.hoisted(() => vi.fn<SessionWriteFileFn>(async () => ({ success: true, hash: 'saved-hash' })));

vi.mock('@/sync/ops', () => ({
    SESSION_WRITE_FILE_TOO_LARGE_ERROR: 'File exceeds the inline file write size limit',
    sessionWriteFile: (...args: Parameters<SessionWriteFileFn>) => sessionWriteFileSpy(...args),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: vi.fn(),
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

type HarnessProps = Readonly<{
    displayMode: 'file' | 'diff';
    fileText: string;
    fileHash?: string | null;
    persistedDraft?: Parameters<typeof import('./useSessionFileEditorState').useSessionFileEditorState>[0]['persistedDraft'];
}>;

describe('useSessionFileEditorState (start from diff)', () => {
    it('enters edit mode after switching to file display mode', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 'draft-restore',
                sessionPath: '/repo',
                filePath: 'src/draft-restore.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: props.persistedDraft,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Harness displayMode="diff" fileText={'console.log(1);'} />)).tree;

        expect(latest).not.toBeNull();

        await act(async () => {
            latest.startEditingFile();
        });

        expect(latest.isEditingFile).toBe(false);

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);'} />);
        });

        expect(latest.isEditingFile).toBe(true);
    });

    it('keeps a cached editing draft active while remount display mode catches up', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');
        const { sessionFileEditorDraftCache } = await import('./sessionFileEditorDraftCache');
        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };
        const sessionId = 'cached-remount';
        const filePath = 'src/cached-remount.ts';
        sessionFileEditorDraftCache.setDraft({
            sessionId,
            filePath,
            draft: {
                isEditingFile: true,
                editorOriginalText: 'base',
                editorOriginalHash: 'base-hash',
                editorText: 'unsaved draft',
            },
        });

        function Harness() {
            latest = useSessionFileEditorState({
                sessionId,
                sessionPath: '/repo',
                filePath,
                displayMode: 'diff',
                fileText: 'base',
                fileHash: 'base-hash',
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        try {
            await renderScreen(<Harness />);
            expect(getLatest().isEditingFile).toBe(true);
            expect(getLatest().getEditorText()).toBe('unsaved draft');
        } finally {
            sessionFileEditorDraftCache.setDraft({ sessionId, filePath, draft: null });
        }
    });

    it('does not clobber dirty edits when fileText refreshes', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 'draft-restore',
                sessionPath: '/repo',
                filePath: 'src/draft-restore.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: props.persistedDraft,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="hash-1" />)).tree;

        await act(async () => {
            latest.startEditingFile();
        });

        await act(async () => {
            latest.onEditorChange('console.log(2);');
        });

        expect(latest.editorDirty).toBe(true);

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);\\n// refreshed'} fileHash="hash-2" />);
        });

        expect(latest.getEditorText()).toBe('console.log(2);');
        expect(latest.fileChangedExternally).toBe(true);
    });

    it('does not reset the editor while editing when fileText refreshes before dirty state changes', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 'draft-restore',
                sessionPath: '/repo',
                filePath: 'src/draft-restore.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: props.persistedDraft,
            });
            return null;
        }

        const tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="hash-1" />)).tree;

        await act(async () => {
            getLatest().startEditingFile();
        });

        const resetKeyBeforeRefresh = getLatest().editorResetKey;
        const seedBeforeRefresh = getLatest().editorSeedText;

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);\n// refreshed'} fileHash="hash-2" />);
        });

        expect(getLatest().editorResetKey).toBe(resetKeyBeforeRefresh);
        expect(getLatest().editorSeedText).toBe(seedBeforeRefresh);
        expect(getLatest().getEditorText()).toBe(seedBeforeRefresh);
        expect(getLatest().fileChangedExternally).toBe(true);
    });

    it('restores an editing draft without letting the initial file refresh overwrite it', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');
        const { sessionFileEditorDraftCache } = await import('./sessionFileEditorDraftCache');

        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 'draft-restore',
                sessionPath: '/repo',
                filePath: 'src/draft-restore.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: props.persistedDraft,
            });
            return null;
        }

        sessionFileEditorDraftCache.setDraft({ sessionId: 'draft-restore', filePath: 'src/draft-restore.ts', draft: null });
        await renderScreen(
            <Harness
                displayMode="file"
                fileText={'console.log("disk");'}
                fileHash="disk-hash"
                persistedDraft={{
                    isEditingFile: true,
                    editorOriginalText: 'console.log("base");',
                    editorOriginalHash: 'base-hash',
                    editorText: 'console.log("draft");',
                }}
            />,
        );

        expect(getLatest().isEditingFile).toBe(true);
        expect(getLatest().getEditorText()).toBe('console.log("draft");');
        expect(getLatest().editorOriginalText).toBe('console.log("base");');
        expect(getLatest().fileChangedExternally).toBe(true);
    });

    it('treats legacy editing drafts without a stored hash as externally changed when the loaded file differs', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');
        const { sessionFileEditorDraftCache } = await import('./sessionFileEditorDraftCache');

        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 'legacy-draft',
                sessionPath: '/repo',
                filePath: 'src/legacy-draft.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: props.persistedDraft,
            });
            return null;
        }

        sessionFileEditorDraftCache.setDraft({ sessionId: 'legacy-draft', filePath: 'src/legacy-draft.ts', draft: null });
        await renderScreen(
            <Harness
                displayMode="file"
                fileText={'console.log("disk");'}
                fileHash="disk-hash"
                persistedDraft={{
                    isEditingFile: true,
                    editorOriginalText: 'console.log("base");',
                    editorText: 'console.log("draft");',
                }}
            />,
        );

        expect(getLatest().editorOriginalHash).toBeNull();
        expect(getLatest().fileChangedExternally).toBe(true);
    });

    it('does not save over an externally changed file when the original hash is unavailable', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');
        const { sessionFileEditorDraftCache } = await import('./sessionFileEditorDraftCache');

        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 'legacy-save',
                sessionPath: '/repo',
                filePath: 'src/legacy-save.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: props.persistedDraft,
            });
            return null;
        }

        sessionWriteFileSpy.mockClear();
        sessionFileEditorDraftCache.setDraft({ sessionId: 'legacy-save', filePath: 'src/legacy-save.ts', draft: null });
        await renderScreen(
            <Harness
                displayMode="file"
                fileText={'console.log("disk");'}
                fileHash="disk-hash"
                persistedDraft={{
                    isEditingFile: true,
                    editorOriginalText: 'console.log("base");',
                    editorText: 'console.log("draft");',
                }}
            />,
        );

        await act(async () => {
            getLatest().saveFileEdits();
        });

        expect(sessionWriteFileSpy).not.toHaveBeenCalled();
    });

    it('guards saves with the hash from the loaded file content', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        sessionWriteFileSpy.mockClear();
        await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="loaded-hash" />);

        await act(async () => {
            getLatest().startEditingFile();
        });

        await act(async () => {
            getLatest().onEditorChange('console.log(2);');
        });

        await act(async () => {
            getLatest().saveFileEdits();
        });

        expect(sessionWriteFileSpy).toHaveBeenCalledWith('s1', 'src/a.ts', 'console.log(2);', 'loaded-hash');
    });

    it('keeps save callback stable across equivalent input rerenders', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;
        const mountedRef = { current: true };
        const setFileWriteSupported = vi.fn();
        const refreshAll = vi.fn(async () => undefined);

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported,
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef,
                refreshAll,
            });
            return null;
        }

        const tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} />)).tree;
        await act(async () => {});

        const firstSaveFileEdits = latest.saveFileEdits;

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);'} />);
        });

        expect(latest.saveFileEdits).toBe(firstSaveFileEdits);
    });

    it('keeps cancel callback stable when loaded file text hydrates editor state', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} />);
        const firstCancelEditingFile = latest.cancelEditingFile;

        await act(async () => {});

        expect(latest.cancelEditingFile).toBe(firstCancelEditingFile);
    });

});
