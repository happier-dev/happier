import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MENTION_KIND_V1, buildMentionRefForKindV1 } from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionReferenceTarget } from '@/sync/store/hooks';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const referenceTargetState = vi.hoisted(() => ({
    sessions: {} as Record<string, SessionReferenceTarget | undefined>,
}));

installMessageViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: () => null,
                useLocalSetting: createUseLocalSettingMock({ values: { uiMultiPanePanelsEnabled: false } }),
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => ({} as any),
                useSessionReferenceTarget: (sessionId: string) => (
                    referenceTargetState.sessions[sessionId] ?? { present: false, metadata: null }
                ),
            },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({ ToolView: () => null }));
vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({ ToolTimelineRow: () => null }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const SESSION_TOKEN = '@session:release-prep-a1b2c3';
const SESSION_TEXT = `compare with ${SESSION_TOKEN}`;

function sessionEnvelopeMeta(sessionId: string, label: string) {
    return {
        happierStructuredInputV1: {
            v: 1,
            mentions: [{
                kind: MENTION_KIND_V1.session,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, sessionId),
                token: SESSION_TOKEN,
                start: SESSION_TEXT.indexOf(SESSION_TOKEN),
                end: SESSION_TEXT.length,
                label,
            }],
        },
    } as any;
}

async function renderMessage(message: any) {
    const { MessageView } = await import('./MessageView');
    // Imported from the same module graph as `MessageView` so the row resolves this exact
    // `AppPaneContext` instance.
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    return renderScreen(
        <AppPaneProvider>
            <MessageView sessionId="s1" metadata={null} message={message} />
        </AppPaneProvider>,
    );
}

describe('MessageView structured references', () => {
    beforeEach(() => {
        referenceTargetState.sessions = {
            sess_42: { present: true, metadata: { name: 'Release prep', path: '/w', host: 'h' } },
        };
        routerPushSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders and navigates an envelope-backed session reference in the USER branch', async () => {
        const screen = await renderMessage({
            kind: 'user-text',
            id: 'u1',
            localId: 'local-u1',
            createdAt: 1,
            text: SESSION_TEXT,
            meta: sessionEnvelopeMeta('sess_42', 'Release prep'),
        });

        const chip = screen.findByTestId('transcript-session-reference:sess_42');
        expect(chip).toBeTruthy();
        expect(screen.getTextContent()).toContain('Release prep');

        await pressTestInstanceAsync(chip!, 'transcript-session-reference:sess_42');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/sess_42');
    });

    it('renders and navigates an envelope-backed session reference in the AGENT branch', async () => {
        const screen = await renderMessage({
            kind: 'agent-text',
            id: 'a1',
            localId: 'local-a1',
            createdAt: 2,
            text: SESSION_TEXT,
            meta: sessionEnvelopeMeta('sess_42', 'Release prep'),
        });

        const chip = screen.findByTestId('transcript-session-reference:sess_42');
        expect(chip).toBeTruthy();

        await pressTestInstanceAsync(chip!, 'transcript-session-reference:sess_42');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/sess_42');
    });

    it('renders the SAME text as plain text when no envelope entry backs it, in BOTH branches (INV-5)', async () => {
        const userScreen = await renderMessage({
            kind: 'user-text',
            id: 'u2',
            localId: 'local-u2',
            createdAt: 1,
            text: SESSION_TEXT,
        });
        const agentScreen = await renderMessage({
            kind: 'agent-text',
            id: 'a2',
            localId: 'local-a2',
            createdAt: 2,
            text: SESSION_TEXT,
        });

        expect(userScreen.findAllByTestId('transcript-session-reference:sess_42')).toHaveLength(0);
        expect(agentScreen.findAllByTestId('transcript-session-reference:sess_42')).toHaveLength(0);
        expect(userScreen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('transcript-session-reference:'))).toHaveLength(0);
        expect(agentScreen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('transcript-session-reference:'))).toHaveLength(0);
    });

    it('renders an unavailable referenced session inert rather than as a dead link', async () => {
        referenceTargetState.sessions = {};

        const screen = await renderMessage({
            kind: 'user-text',
            id: 'u3',
            localId: 'local-u3',
            createdAt: 1,
            text: SESSION_TEXT,
            meta: sessionEnvelopeMeta('sess_gone', 'Deleted work'),
        });

        const chip = screen.findByTestId('transcript-session-reference:sess_gone');
        expect(chip?.type).toBe('View');
        expect(chip?.props.onPress).toBeUndefined();
        expect(screen.getTextContent()).toContain('message.sessionReferenceUnavailable');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('renders a quoted file token the legacy text scan cannot parse, in BOTH branches', async () => {
        const text = 'open @"my file.ts" please';
        const meta = {
            happierStructuredInputV1: {
                v: 1,
                mentions: [{
                    kind: MENTION_KIND_V1.file,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'my file.ts'),
                    token: '@"my file.ts"',
                    start: 5,
                    end: 18,
                }],
            },
        } as any;

        const userScreen = await renderMessage({
            kind: 'user-text', id: 'u4', localId: 'local-u4', createdAt: 1, text, meta,
        });
        const agentScreen = await renderMessage({
            kind: 'agent-text', id: 'a4', localId: 'local-a4', createdAt: 2, text, meta,
        });

        expect(userScreen.findByTestId('linked-workspace-file:my file.ts')).toBeTruthy();
        expect(agentScreen.findByTestId('linked-workspace-file:my file.ts')).toBeTruthy();
    });

    it('still renders legacy pre-envelope file mentions from the text scan (D-5)', async () => {
        const screen = await renderMessage({
            kind: 'user-text',
            id: 'u5',
            localId: 'local-u5',
            createdAt: 1,
            text: 'look at @src/api.ts',
        });

        expect(screen.findByTestId('linked-workspace-file:src/api.ts')).toBeTruthy();
    });
});
