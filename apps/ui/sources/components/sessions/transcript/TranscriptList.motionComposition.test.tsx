import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUseSettingMock, createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Message } from '@happier-dev/session-core/messages';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostState = vi.hoisted(() => ({
    motionConfigs: [] as Array<Record<string, any> | null>,
}));

installTranscriptCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: () => undefined }),
            },
        });
    },
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

vi.mock('@/components/sessions/transcript/MessageView', async () => {
    const { useTranscriptMotion } = await import('./motion/TranscriptMotionContext');
    return {
        MessageViewWithSessionCommon: () => {
            hostState.motionConfigs.push(useTranscriptMotion()?.config ?? null);
            return React.createElement('MessageViewWithSessionCommon');
        },
    };
});

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock().module;
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('TranscriptList motion composition', () => {
    afterEach(() => {
        hostState.motionConfigs.length = 0;
        standardCleanup();
    });

    it('installs the effective reduced-motion config for the public/read-only transcript surface', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        const messages: Message[] = [{
            kind: 'agent-text', id: 'assistant-1', localId: null, createdAt: 1,
            text: 'Hello', isThinking: false,
        }];
        const source = createTestSessionTranscriptSource({
            sessionId: 'public-session', metadata: null, messages,
            interaction: { canSendMessages: false, canApprovePermissions: false, permissionDisabledReason: 'public' },
        });
        await renderWithSessionTranscriptSource(
            <TranscriptList
                datasetKey="public:public-session:1"
                metadata={null}
                messages={messages}
            />,
            source,
        );

        expect(hostState.motionConfigs).toContainEqual(expect.objectContaining({
            preset: 'off',
            animateNewItemsEnabled: false,
        }));
    });
});
