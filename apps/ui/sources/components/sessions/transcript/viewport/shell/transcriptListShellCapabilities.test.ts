import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    resolveMainTranscriptListShellFrame,
    resolveReadOnlyTranscriptListShellFrame,
    resolveSidechainTranscriptListShellFrame,
} from './transcriptListShellCapabilities';

const CHAT_LIST = [
    readFileSync(new URL('../../ChatList.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../../ChatListInternal.tsx', import.meta.url), 'utf8'),
].join('\n');
const TRANSCRIPT_LIST = readFileSync(new URL('../../TranscriptList.tsx', import.meta.url), 'utf8');
const VIEWPORT_TELEMETRY = readFileSync(new URL('../../scroll/transcriptViewportTelemetry.ts', import.meta.url), 'utf8');
const JUMP_HOST = readFileSync(new URL('../jump/host/useTranscriptJumpHost.ts', import.meta.url), 'utf8');
const NATIVE_VIEWPORT_LIFECYCLE_HOST = readFileSync(new URL('../lifecycle/host/useTranscriptNativeViewportLifecycle.ts', import.meta.url), 'utf8');
const SESSION_ENTRY_LIFECYCLE_HOST = readFileSync(new URL('../entryRestore/host/useTranscriptSessionEntryLifecycle.ts', import.meta.url), 'utf8');
const BOTTOM_FOLLOW_HOST = readFileSync(new URL('../bottomFollow/host/useTranscriptBottomFollowHost.ts', import.meta.url), 'utf8');
const LIFECYCLE_HOST = readFileSync(new URL('../lifecycle/lifecycleHost.ts', import.meta.url), 'utf8');
const RETIRED_TELEMETRY_LIST_IMPLEMENTATION_RESOLVER = [
    'resolveTranscriptViewportTelemetry',
    'ListImplementation',
].join('');

describe('transcriptListShellCapabilities', () => {
    it('resolves main web renderer identity and interaction props from the shell frame', () => {
        const frame = resolveMainTranscriptListShellFrame({
            nativeID: 'ChatList.session.r1',
            platformOS: 'web',
        });

        expect(frame).toMatchObject({
            dataOrder: 'oldest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    drawDistance: undefined,
                    inverted: false,
                    keyboardDismissMode: 'none',
                    keyboardShouldPersistTaps: 'handled',
                    nativeID: 'ChatList.session.r1',
                    scrollEventThrottle: 32,
                    testID: 'transcript-chat-list',
                },
            },
            capability: {
                kind: 'main',
                streamingFollow: { kind: 'main' },
            },
        });
        expect(Object.keys(frame.capability)).toEqual([
            'catchUpIndicator',
            'entryRestore',
            'kind',
            'jumpToSeq',
            'olderPagination',
            'selection',
            'streamingFollow',
        ]);
    });

    it('resolves main native drawDistance policy from explicit tuning or clamped viewport height', () => {
        expect(resolveMainTranscriptListShellFrame({
            listLayoutHeight: 0,
            platformOS: 'ios',
        }).rendererOptions.flashList.drawDistance).toBe(600);
        expect(resolveMainTranscriptListShellFrame({
            listLayoutHeight: 800,
            platformOS: 'ios',
        }).rendererOptions.flashList.drawDistance).toBe(800);
        expect(resolveMainTranscriptListShellFrame({
            listLayoutHeight: 2000,
            platformOS: 'ios',
        }).rendererOptions.flashList.drawDistance).toBe(1200);
        expect(resolveMainTranscriptListShellFrame({
            configuredDrawDistance: 1600,
            listLayoutHeight: 800,
            platformOS: 'ios',
        }).rendererOptions.flashList.drawDistance).toBe(1600);
        expect(resolveMainTranscriptListShellFrame({
            configuredDrawDistance: 1600,
            listLayoutHeight: 800,
            platformOS: 'web',
        }).rendererOptions.flashList.drawDistance).toBeUndefined();
    });

    it('resolves main native as the inverted streaming shell frame', () => {
        const maintainVisibleContentPosition = { startRenderingFromBottom: true } as const;

        const frame = resolveMainTranscriptListShellFrame({
            listLayoutHeight: 700,
            maintainVisibleContentPosition,
            nativeID: 'ChatList.session.native',
            platformOS: 'ios',
        });

        expect(frame).toMatchObject({
            dataOrder: 'newest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    drawDistance: 700,
                    inverted: true,
                    keyboardDismissMode: 'none',
                    keyboardShouldPersistTaps: 'handled',
                    nativeID: 'ChatList.session.native',
                    scrollEventThrottle: 16,
                    testID: 'transcript-chat-list',
                },
            },
            capability: {
                kind: 'main',
                streamingFollow: { kind: 'main' },
            },
        });
        expect(frame.rendererOptions.flashList.maintainVisibleContentPosition).toBe(maintainVisibleContentPosition);
        expect(Object.keys(frame.capability)).toEqual([
            'catchUpIndicator',
            'entryRestore',
            'kind',
            'jumpToSeq',
            'olderPagination',
            'selection',
            'streamingFollow',
        ]);
    });

    it('resolves read-only static keyboard props through the shell frame', () => {
        const frame = resolveReadOnlyTranscriptListShellFrame({
            accessKind: 'public',
            bottomNoticeVisible: true,
            platformOS: 'web',
        });

        expect(frame).toMatchObject({
            dataOrder: 'oldest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    inverted: false,
                    keyboardDismissMode: 'none',
                    keyboardShouldPersistTaps: 'handled',
                    maintainVisibleContentPosition: { startRenderingFromBottom: true },
                    scrollEventThrottle: 32,
                },
            },
            capability: {
                accessKind: 'public',
                boundedHydration: { kind: 'readOnly' },
                bottomNoticeVisible: true,
                kind: 'readOnly',
            },
        });
        expect(Object.keys(frame.capability)).toEqual([
            'accessKind',
            'boundedHydration',
            'bottomNoticeVisible',
            'canApprovePermissions',
            'canSendMessages',
            'catchUpIndicator',
            'composerVisible',
            'flashListStartsFromBottom',
            'kind',
            'permissionDisabledReason',
            'streamingFollow',
            'toolNavigationDisabled',
        ]);
    });

    it('resolves sidechain frames through the shared renderer shell contract', () => {
        expect(resolveSidechainTranscriptListShellFrame({ platformOS: 'web' })).toMatchObject({
            capability: {
                boundedHydration: { kind: 'sidechain' },
                kind: 'sidechain',
            },
            dataOrder: 'oldest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    inverted: false,
                    scrollEventThrottle: 32,
                },
            },
        });
        expect(resolveSidechainTranscriptListShellFrame({ platformOS: 'ios' })).toMatchObject({
            capability: {
                boundedHydration: { kind: 'sidechain' },
                kind: 'sidechain',
            },
            dataOrder: 'newest-first',
            renderer: 'flashList',
            rendererOptions: {
                flashList: {
                    inverted: true,
                    scrollEventThrottle: 16,
                },
            },
        });
    });

    it('does not consume transcriptListImplementation as a runtime renderer switch', () => {
        expect(CHAT_LIST).not.toContain("useSetting('transcriptListImplementation')");
        expect(CHAT_LIST).not.toContain('setting: transcriptListImplementation');
        expect(CHAT_LIST).not.toContain('listImplementation: transcriptListImplementation');
        expect(TRANSCRIPT_LIST).not.toContain("useSetting('transcriptListImplementation')");
        expect(TRANSCRIPT_LIST).not.toContain('listImplementation: transcriptListImplementation');
    });

    it('keeps ChatList runtime telemetry on the canonical FlashList identity without the retired resolver', () => {
        expect(VIEWPORT_TELEMETRY).not.toContain(RETIRED_TELEMETRY_LIST_IMPLEMENTATION_RESOLVER);
        expect(CHAT_LIST).not.toContain(RETIRED_TELEMETRY_LIST_IMPLEMENTATION_RESOLVER);
        expect(CHAT_LIST).not.toContain('telemetryListImplementation');
        expect(VIEWPORT_TELEMETRY).toContain("'flash_v2'");
    });

    it('routes native confirmation ownership through the lifecycle host', () => {
        const forbiddenImports = [
            ['viewport/lifecycle/nativeExplicitJump', 'Confirmation'].join(''),
            ['viewport/lifecycle/nativeEntrySettle', 'Confirmation'].join(''),
        ];
        const forbiddenSymbols = [
            ['createNativeExplicitJump', 'ConfirmationState'].join(''),
            ['resolveNativeExplicitJump', 'ConfirmationEffects'].join(''),
            ['createNativeEntrySettle', 'ConfirmationState'].join(''),
            ['resolveNativeEntrySettle', 'ConfirmationEffects'].join(''),
            ['NativeExplicitJump', 'ConfirmationState'].join(''),
            ['NativeEntrySettle', 'ConfirmationState'].join(''),
            'pendingNativeExplicitJumpConfirmRef',
            'pendingNativeEntrySettleConfirmRef',
        ];

        expect(JUMP_HOST).toContain('lifecycleHost.armNativeExplicitJumpConfirmation');
        expect(JUMP_HOST).toContain('lifecycleHost.clearNativeExplicitJumpConfirmation');
        expect(NATIVE_VIEWPORT_LIFECYCLE_HOST).toContain('lifecycleHost.armNativeEntrySettleConfirmation');
        expect(SESSION_ENTRY_LIFECYCLE_HOST).toContain('lifecycleHost.resetNativeEntrySettleConfirmation');
        expect(BOTTOM_FOLLOW_HOST).toContain('lifecycleHost.observeNativeScrollConfirmation');
        expect(LIFECYCLE_HOST).toContain('createNativeConfirmationOwner');
        expect(LIFECYCLE_HOST).toContain('observeNativeScrollConfirmation');
        for (const forbiddenImport of forbiddenImports) {
            expect(CHAT_LIST).not.toContain(forbiddenImport);
        }
        for (const forbiddenSymbol of forbiddenSymbols) {
            expect(CHAT_LIST).not.toContain(forbiddenSymbol);
        }
    });
});
