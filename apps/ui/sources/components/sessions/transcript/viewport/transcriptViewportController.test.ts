import { describe, expect, it } from 'vitest';

type UnknownModule = Record<string, unknown>;

async function loadControllerModule(): Promise<UnknownModule> {
    try {
        return await import('./createTranscriptViewportController') as UnknownModule;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Cannot find module') || message.includes('Failed to resolve import')) {
            return {};
        }
        throw error;
    }
}

function requireFunction(
    module: UnknownModule,
    name: string,
): (...args: unknown[]) => unknown {
    const value = module[name];
    expect(typeof value).toBe('function');
    return value as (...args: unknown[]) => unknown;
}

async function createController() {
    const module = await loadControllerModule();
    const createTranscriptViewportController = requireFunction(module, 'createTranscriptViewportController');
    return createTranscriptViewportController() as {
        getMode: () => string;
        resolve: (input: Record<string, unknown>) => unknown;
        [key: string]: unknown;
    };
}

function requireControllerFunction<T extends (...args: unknown[]) => unknown>(
    controller: Record<string, unknown>,
    name: string,
): T {
    const value = controller[name];
    expect(typeof value).toBe('function');
    return value as T;
}

function streamAppendCommand(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'pin-bottom',
        sessionId: 'session-a',
        reason: 'stream-append',
        mode: 'follow-bottom',
        ...overrides,
    };
}

describe('transcript viewport controller', () => {
    it('resolves initial follow bottom to a pin command', async () => {
        const controller = await createController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'initial-open',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resolves a stream-append auto-follow with skipNativeJsPin into the MVCP-skip command (plan B3)', async () => {
        const controller = await createController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
            platform: 'android',
            listImplementation: 'flash_v2',
        });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 320,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'stream-append',
            targetOffsetY: 840,
            platform: 'android',
            listImplementation: 'flash_v2',
            skipNativeJsPin: true,
        });

        expect(command).toEqual({
            kind: 'skip-native-js-pin',
            sessionId: 'session-a',
            reason: 'stream-append',
            mode: 'follow-bottom',
            skipReason: 'mvcp-only',
            targetOffsetY: 840,
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resolves unpinned entry anchor to restore index', async () => {
        const controller = await createController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: 80,
                anchorIndex: 12,
                anchorViewOffset: 24,
            },
            jumpToSeq: null,
            platform: 'web',
            listImplementation: 'web-fallback',
        });

        expect(command).toEqual({
            kind: 'restore-index',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-anchor',
            index: 12,
            viewOffset: 24,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('resolves explicit anchor restores without first-paint semantics', async () => {
        const controller = await createController();

        const command = controller.resolve({
            type: 'restore-anchor',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            index: 7.8,
            viewOffset: -42.5,
            animated: false,
        });

        expect(command).toEqual({
            kind: 'restore-index',
            sessionId: 'session-a',
            reason: 'prepend-restore',
            mode: 'restore-anchor',
            index: 7,
            viewOffset: -42,
            animated: false,
        });
        expect(controller.getMode()).toBe('restore-anchor');
    });

    it('prefers jumpToSeq over first paint state', async () => {
        const controller = await createController();

        const command = controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: false,
            entrySnapshot: {
                shouldFollowBottom: false,
                offsetY: 420,
                anchorIndex: 12,
            },
            jumpToSeq: 34,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        expect(command).toEqual({
            kind: 'jump-to-seq',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            seq: 34,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('does not repin passive drift while user unpinned', async () => {
        const controller = await createController();
        controller.resolve({
            type: 'user-scroll',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
        });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 300,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: false,
            reason: 'stream-append',
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-a',
            reason: 'user-unpinned',
            mode: 'user-unpinned',
        });
        expect(controller.getMode()).toBe('user-unpinned');
    });

    it('resolves fallback bottom pins through the controller', async () => {
        const controller = await createController();

        const command = controller.resolve({
            type: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            animated: false,
        });

        expect(command).toEqual({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-seq',
            mode: 'jump-to-seq',
            animated: false,
        });
        expect(controller.getMode()).toBe('jump-to-seq');
    });

    it('resolves dynamic-height scroll-offset fallbacks through the controller', async () => {
        const controller = await createController();

        const command = controller.resolve({
            type: 'scroll-offset',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
            offsetY: 123.8,
            animated: true,
        });

        expect(command).toEqual({
            kind: 'scroll-offset',
            sessionId: 'session-a',
            reason: 'entry-restore',
            mode: 'restore-distance',
            offsetY: 123,
            animated: true,
        });
        expect(controller.getMode()).toBe('restore-distance');
    });

    it('settles jump to bottom back to follow bottom', async () => {
        const controller = await createController();
        controller.resolve({ type: 'jump-to-bottom', sessionId: 'session-a' });

        const command = controller.resolve({
            type: 'auto-follow',
            sessionId: 'session-a',
            distanceFromBottom: 0,
            pinThresholdPx: 80,
            recentUserIntent: false,
            wantsPinned: true,
            reason: 'stream-append',
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-a',
            reason: 'already-pinned',
            mode: 'follow-bottom',
        });
        expect(controller.getMode()).toBe('follow-bottom');
    });

    it('resets to hydrating on session identity change', async () => {
        const controller = await createController();
        controller.resolve({
            type: 'first-paint',
            sessionId: 'session-a',
            shouldFollowBottom: true,
            entrySnapshot: null,
            jumpToSeq: null,
            platform: 'ios',
            listImplementation: 'flash_v2',
        });

        const command = controller.resolve({
            type: 'user-scroll',
            sessionId: 'session-b',
            distanceFromBottom: 200,
            pinThresholdPx: 80,
        });

        expect(command).toEqual({
            kind: 'none',
            sessionId: 'session-b',
            reason: 'session-change',
            mode: 'hydrating',
        });
        expect(controller.getMode()).toBe('hydrating');
    });

    it('rejects follow writes while entry owns the viewport', async () => {
        const controller = await createController();
        const resetForSession = requireControllerFunction(controller, 'resetForSession');
        const resolveWriteAdmission = requireControllerFunction(controller, 'resolveWriteAdmission');

        resetForSession('session-a', { openEntryTransaction: true });

        expect(resolveWriteAdmission({
            command: streamAppendCommand(),
            platform: 'ios',
        })).toEqual({
            accepted: false,
            reason: 'ownership',
            rejectedOwner: 'follow',
            activeOwner: 'entry',
        });
    });

    it('drops inactive and stale commands before ownership writes', async () => {
        const controller = await createController();
        const activeOwner = requireControllerFunction(controller, 'activeOwner');
        const resetForSession = requireControllerFunction(controller, 'resetForSession');
        const setActive = requireControllerFunction(controller, 'setActive');
        const resolveWriteAdmission = requireControllerFunction(controller, 'resolveWriteAdmission');

        resetForSession('session-a', { openEntryTransaction: true });
        setActive(false);

        expect(resolveWriteAdmission({
            command: { ...streamAppendCommand(), reason: 'entry-restore', mode: 'restore-distance' },
            platform: 'ios',
        })).toEqual({ accepted: false, reason: 'inactive' });
        expect(activeOwner()).toBe('entry');

        setActive(true);
        resetForSession('session-b');

        expect(resolveWriteAdmission({
            command: streamAppendCommand(),
            platform: 'ios',
        })).toEqual({ accepted: false, reason: 'stale-session' });
        expect(activeOwner()).toBe('follow');
    });

    it('lets explicit jumps preempt an entry transaction and return ownership to follow', async () => {
        const controller = await createController();
        const activeOwner = requireControllerFunction(controller, 'activeOwner');
        const resetForSession = requireControllerFunction(controller, 'resetForSession');
        const resolveWriteAdmission = requireControllerFunction(controller, 'resolveWriteAdmission');

        resetForSession('session-a', { openEntryTransaction: true });

        expect(resolveWriteAdmission({
            command: {
                kind: 'pin-bottom',
                sessionId: 'session-a',
                reason: 'jump-to-bottom',
                mode: 'jump-to-bottom',
                force: true,
                animated: true,
            },
            platform: 'ios',
        })).toEqual({ accepted: true, owner: 'explicit' });
        expect(activeOwner()).toBe('follow');
    });

    it('owns the web prepend write window inside the controller', async () => {
        const controller = await createController();
        const activeOwner = requireControllerFunction(controller, 'activeOwner');
        const resetForSession = requireControllerFunction(controller, 'resetForSession');
        const resolveWriteAdmission = requireControllerFunction(controller, 'resolveWriteAdmission');

        resetForSession('session-a');

        expect(resolveWriteAdmission({
            command: {
                kind: 'scroll-offset',
                sessionId: 'session-a',
                reason: 'prepend-restore',
                mode: 'restore-anchor',
                offsetY: 480,
            },
            platform: 'web',
            hasWebPrependRestoreWindow: true,
        })).toEqual({ accepted: true, owner: 'prepend' });
        expect(activeOwner()).toBe('prepend');

        expect(resolveWriteAdmission({
            command: streamAppendCommand(),
            platform: 'web',
            hasWebPrependRestoreWindow: false,
        })).toEqual({ accepted: true, owner: 'follow' });
        expect(activeOwner()).toBe('follow');
    });
});
