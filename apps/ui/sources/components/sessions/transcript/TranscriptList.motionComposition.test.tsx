import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUseSettingMock, renderScreen, standardCleanup } from '@/dev/testkit';
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

describe('TranscriptList motion composition', () => {
    afterEach(() => {
        hostState.motionConfigs.length = 0;
        standardCleanup();
    });

    it('installs the effective reduced-motion config for the public/read-only transcript surface', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(
            <TranscriptList
                sessionId="public-session"
                datasetKey="public:public-session:1"
                metadata={null}
                messages={[
                    {
                        kind: 'agent-text',
                        id: 'assistant-1',
                        localId: null,
                        createdAt: 1,
                        text: 'Hello',
                    },
                ]}
                interaction={{ canSendMessages: false, canApprovePermissions: false, permissionDisabledReason: 'public' }}
            />,
        );

        expect(hostState.motionConfigs).toContainEqual(expect.objectContaining({
            preset: 'off',
            animateNewItemsEnabled: false,
        }));
    });
});
