import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionOperationSharedPresentationV1Schema,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

const accessibilityPlatform = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ View: 'View' });
    return {
        ...base,
        AccessibilityInfo: {
            ...base.AccessibilityInfo,
            announceForAccessibility: announceForAccessibilityMock,
        },
        Platform: {
            ...base.Platform,
            get OS() {
                return accessibilityPlatform.os;
            },
        },
    };
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) =>
        React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (
        props: Record<string, unknown> & { children?: React.ReactNode },
    ) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

function createPresentation(overrides: Record<string, unknown> = {}) {
    return ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'private-operation-id',
        revision: 41,
        kind: 'materialize',
        status: 'running',
        phase: 'importing',
        ...overrides,
    });
}

describe('ExternalSessionOperationSharedCard accessibility', () => {
    it('offers local Dismiss for a terminal shared presentation with the exact identity', async () => {
        accessibilityPlatform.os = 'web';
        const onDismiss = vi.fn();
        const presentation = createPresentation({
            status: 'completed',
            phase: 'publishing',
        });
        const { ExternalSessionOperationSharedCard } = await import(
            './ExternalSessionOperationSharedCard'
        );
        const screen = await renderScreen(
            <ExternalSessionOperationSharedCard
                presentation={presentation}
                onDismiss={onDismiss}
            />,
        );

        expect(
            screen.findByTestId('external-session-operation-action-dismiss')?.props,
        ).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'externalSessions.operationActionDismiss',
        });
        await screen.pressByTestIdAsync(
            'external-session-operation-action-dismiss',
        );
        expect(onDismiss).toHaveBeenCalledWith({
            operationId: 'private-operation-id',
            revision: 41,
        });
    });

    it.each([
        ['a running shared presentation', createPresentation(), vi.fn()],
        [
            'a terminal presentation without a mounted dismissal owner',
            createPresentation({ status: 'completed', phase: 'publishing' }),
            undefined,
        ],
    ] as const)('does not offer Dismiss for %s', async (
        _label,
        presentation,
        onDismiss,
    ) => {
        accessibilityPlatform.os = 'web';
        const { ExternalSessionOperationSharedCard } = await import(
            './ExternalSessionOperationSharedCard'
        );
        const screen = await renderScreen(
            <ExternalSessionOperationSharedCard
                presentation={presentation}
                onDismiss={onDismiss}
            />,
        );

        expect(
            screen.findByTestId('external-session-operation-action-dismiss'),
        ).toBeNull();
    });

    it.each(['web', 'android'] as const)(
        'publishes one polite shared-safe status region on %s',
        async (platformOS) => {
            accessibilityPlatform.os = platformOS;
            announceForAccessibilityMock.mockClear();
            const { ExternalSessionOperationSharedCard } = await import(
                './ExternalSessionOperationSharedCard'
            );
            const screen = await renderScreen(
                <ExternalSessionOperationSharedCard
                    presentation={createPresentation()}
                />,
            );

            const status = screen.findByTestId(
                'external-session-operation-shared-a11y-status',
            );
            expect(status?.props).toMatchObject({
                accessibilityLiveRegion: 'polite',
                role: 'status',
                'aria-live': 'polite',
                'aria-atomic': true,
            });
            const announcement = String(status?.props.children.props.children);
            expect(announcement).toContain(
                'externalSessions.operationTitleMaterialize',
            );
            expect(announcement).toContain(
                'externalSessions.operationStatusRunning',
            );
            expect(announcement).toContain(
                'externalSessions.operationPhaseImporting',
            );
            expect(announcement).not.toContain('private-operation-id');
            expect(announcement).not.toContain('41');
            expect(announceForAccessibilityMock).not.toHaveBeenCalled();
        },
    );

    it('announces only bounded shared semantic transitions on iOS', async () => {
        accessibilityPlatform.os = 'ios';
        announceForAccessibilityMock.mockClear();
        const { ExternalSessionOperationSharedCard } = await import(
            './ExternalSessionOperationSharedCard'
        );
        const screen = await renderScreen(
            <ExternalSessionOperationSharedCard
                presentation={createPresentation()}
            />,
        );

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining(
                'externalSessions.operationPhaseImporting',
            ),
        );

        await screen.update(
            <ExternalSessionOperationSharedCard
                presentation={createPresentation({ revision: 42 })}
            />,
        );
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);

        await screen.update(
            <ExternalSessionOperationSharedCard
                presentation={createPresentation({
                    revision: 43,
                    status: 'completed',
                    phase: 'publishing',
                })}
            />,
        );
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        const finalAnnouncement = String(
            announceForAccessibilityMock.mock.lastCall?.[0],
        );
        expect(finalAnnouncement).toContain(
            'externalSessions.operationStatusCompleted',
        );
        expect(finalAnnouncement).toContain(
            'externalSessions.operationPhasePublishing',
        );
        expect(finalAnnouncement).not.toContain('private-operation-id');
        expect(finalAnnouncement).not.toContain('43');
    });
});
