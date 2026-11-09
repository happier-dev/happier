import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installBugReportHooksCommonModuleMocks } from './bugReportHooksTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installBugReportHooksCommonModuleMocks();
const copiedDetails = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock('expo-clipboard', () => ({ setStringAsync: copiedDetails }));
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    const boundary = createExpoFileSystemFileMock().module;
    return { ...boundary, Paths: { ...boundary.Paths, document: 'file:///documents' } };
});

const snapshotKey = 'happier_pre_restart_bug_report_snapshot_v1';
installDisconnectedServerSocketBoundary();
const { useBugReportComposerDraftState } = await import('./useBugReportComposerDraftState');
beforeEach(() => vi.stubGlobal('navigator', { clipboard: { writeText: copiedDetails } }));
afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); });

describe('useBugReportComposerDraftState', () => {
    it('marks a long stack as shortened without losing its saved original or overwriting early edits', async () => {
        const snapshot = JSON.stringify({
            v: 1, createdAtMs: Date.now(), reason: 'crash', platform: 'web', origin: null,
            isSecureContext: true, errorDetails: 'Long crash\n' + ' at RecognisableFrame\n'.repeat(500) + 'FINAL_FRAME',
            appLogs: '', userActions: [], runtime: { appVersion: 'before-crash', frontendAssets: Array.from({ length: 120 }, (_, n) => 'https://build.example/assets/long-production-frontend-identity-' + n + '.js').join('\n') + '\nFINAL_ASSET.js' },
        });
        const items = new Map([[snapshotKey, snapshot]]);
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => items.get(key) ?? null,
            removeItem: (key: string) => items.delete(key),
        });
        const hook = await renderHook(() => {
            const draft = useBugReportComposerDraftState({ profile: null, serverUrlDefault: '' });
            React.useLayoutEffect(() => { draft.setTitle('My title'); draft.setAppVersion('Reviewed frontend'); }, []);
            return draft;
        });
        expect(hook.getCurrent().title).toBe('My title');
        expect(hook.getCurrent().appVersion).toBe('Reviewed frontend');
        expect(hook.getCurrent().currentBehavior).toContain('RecognisableFrame');
        expect(hook.getCurrent().currentBehavior.length).toBeLessThanOrEqual(5000);
        expect(hook.getCurrent().currentBehavior).toContain('appCrash.stackTruncated');
        expect(items.get(snapshotKey)).toBe(snapshot);
        copiedDetails.mockClear();
        await act(async () => hook.getCurrent().copySavedCrash?.());
        expect(copiedDetails).toHaveBeenCalledWith(expect.stringContaining('FINAL_FRAME'));
        expect(copiedDetails).toHaveBeenCalledWith(expect.stringContaining('FINAL_ASSET.js'));
        await act(async () => hook.getCurrent().discardSavedCrash());
        expect(items.has(snapshotKey)).toBe(false);
        expect(hook.getCurrent().crashReportStatus).toBe('discarded');
    });
    it('prefills an editable crash report without consuming the saved stack, including on reopening', async () => {
        const snapshot = JSON.stringify({
            v: 1, createdAtMs: Date.now(), reason: 'crash', platform: 'web', origin: null,
            isSecureContext: true, errorDetails: 'Synthetic crash\n at RecognisableFrame\n token=private-secret',
            appLogs: '', userActions: [],
            runtime: { appVersion: '0.3.before-restart', osVersion: 'Windows NT 10.0', desktopWrapperVersion: '0.3.wrapper-748' },
        });
        const items = new Map([[snapshotKey, snapshot]]);
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => items.get(key) ?? null,
            setItem: (key: string, value: string) => items.set(key, value),
            removeItem: (key: string) => items.delete(key),
        });
        const hook = await renderHook(() => useBugReportComposerDraftState({ profile: null, serverUrlDefault: '' }));
        await flushHookEffects();
        expect(hook.getCurrent().appVersion).toBe('0.3.before-restart');
        expect(hook.getCurrent().osVersion).toBe('Windows NT 10.0');
        expect(hook.getCurrent().currentBehavior).toContain('0.3.wrapper-748');
        expect(hook.getCurrent().title.length).toBeGreaterThan(0);
        expect(hook.getCurrent().summary).toContain('Synthetic crash');
        expect(hook.getCurrent().currentBehavior).toContain('RecognisableFrame');
        expect(hook.getCurrent().currentBehavior).not.toContain('private-secret');
        await act(async () => hook.getCurrent().setCurrentBehavior('User-redacted stack'));
        expect(hook.getCurrent().buildDraftInput({ includeDiagnostics: false, diagnosticsKinds: [] }).currentBehavior)
            .toBe('User-redacted stack');
        expect(items.get(snapshotKey)).toBe(snapshot);
        await hook.unmount();
        const reopened = await renderHook(() => useBugReportComposerDraftState({ profile: null, serverUrlDefault: '' }));
        await flushHookEffects();
        expect(reopened.getCurrent().currentBehavior).toContain('RecognisableFrame');
        expect(items.get(snapshotKey)).toBe(snapshot);
    });
    it('keeps a saved crash available and explains a failed dismissal', async () => {
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const snapshot = JSON.stringify({ v: 1, createdAtMs: Date.now(), reason: 'crash', platform: 'web',
            origin: null, isSecureContext: true, errorDetails: 'Saved original', appLogs: '', userActions: [] });
        vi.stubGlobal('localStorage', {
            getItem: () => snapshot,
            removeItem: () => { throw new Error('storage denied'); },
        });
        try {
            const hook = await renderHook(() => useBugReportComposerDraftState({ profile: null, serverUrlDefault: '' }));
            await flushHookEffects();
            await act(async () => hook.getCurrent().discardSavedCrash());
            expect(hook.getCurrent().crashReportStatus).toBe('saved');
            expect(hook.getCurrent().currentBehavior).toBe('Saved original');
            expect(alert).toHaveBeenCalledWith('common.error', 'appCrash.discardFailed');
            expect(warning).toHaveBeenCalled();
        } finally { alert.mockRestore(); warning.mockRestore(); }
    });
    it('updates untouched server environment defaults when the active server changes', async () => {

        const hook = await renderHook(
            ({ serverUrlDefault }: { serverUrlDefault: string }) => useBugReportComposerDraftState({
                profile: null,
                serverUrlDefault,
            }),
            {
                initialProps: { serverUrlDefault: 'http://self-hosted.example.test' },
            },
        );

        expect(hook.getCurrent().serverUrl).toBe('http://self-hosted.example.test');
        expect(hook.getCurrent().deploymentType).toBe('self-hosted');

        await hook.rerender({ serverUrlDefault: 'https://app.happier.dev' });

        expect(hook.getCurrent().serverUrl).toBe('https://app.happier.dev');
        expect(hook.getCurrent().deploymentType).toBe('cloud');
    });

    it('does not overwrite manually edited server environment fields when the active server changes', async () => {

        const hook = await renderHook(
            ({ serverUrlDefault }: { serverUrlDefault: string }) => useBugReportComposerDraftState({
                profile: null,
                serverUrlDefault,
            }),
            {
                initialProps: { serverUrlDefault: 'http://self-hosted.example.test' },
            },
        );

        await act(async () => {
            hook.getCurrent().setServerUrl('https://corp.internal');
            hook.getCurrent().setDeploymentType('enterprise');
        });
        await flushHookEffects();

        await hook.rerender({ serverUrlDefault: 'https://app.happier.dev' });

        expect(hook.getCurrent().serverUrl).toBe('https://corp.internal');
        expect(hook.getCurrent().deploymentType).toBe('enterprise');
    });
});
