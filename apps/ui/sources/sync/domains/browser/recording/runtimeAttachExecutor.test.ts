import { describe, expect, it, vi } from 'vitest';

import { createBrowserRecordingAttachExecutor } from './runtimeAttachExecutor';
import type { BrowserRecordingAttachResult } from './types';

describe('createBrowserRecordingAttachExecutor', () => {
    it('dispatches a real attach when an adapter is registered and gates pass', async () => {
        const attach = vi.fn(async (): Promise<BrowserRecordingAttachResult> => ({
            status: 'attached',
            state: { sessionsById: {}, sessionOrder: [], activeRecordingIdByViewId: {}, attachmentsById: {}, attachmentOrder: [] },
            attachmentId: 'attachment_1',
        }));
        const executor = createBrowserRecordingAttachExecutor({ adapter: { attach } });

        const result = await executor({ recordingId: 'browser_recording_1', sessionId: 'session_1' });

        expect(result).toMatchObject({
            v: 1,
            actionId: 'browser.recording.attachToComposer',
            status: 'attached',
            attachmentId: 'attachment_1',
        });
        expect(attach).toHaveBeenCalledWith({ recordingId: 'browser_recording_1', sessionId: 'session_1' });
    });

    it('returns invalid_parameters when recordingId is missing', async () => {
        const executor = createBrowserRecordingAttachExecutor({ adapter: { attach: vi.fn() } });
        await expect(executor({})).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });

    it('fails closed when no attach adapter is registered', async () => {
        const executor = createBrowserRecordingAttachExecutor({ resolveAdapter: () => null });
        await expect(executor({ recordingId: 'browser_recording_1' })).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_recording_unavailable',
        });
    });

    it('surfaces the exact typed disabled reason from the gate check', async () => {
        const attach = vi.fn(async (): Promise<BrowserRecordingAttachResult> => ({
            status: 'unavailable',
            state: { sessionsById: {}, sessionOrder: [], activeRecordingIdByViewId: {}, attachmentsById: {}, attachmentOrder: [] },
            reason: {
                reasonCode: 'browser_recording_session_media_policy_denied',
                policyState: 'policyDenied',
                message: 'denied',
            },
        }));
        const executor = createBrowserRecordingAttachExecutor({ adapter: { attach } });

        await expect(executor({ recordingId: 'browser_recording_1' })).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_recording_session_media_policy_denied',
        });
    });
});
