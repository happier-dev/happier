import { beforeAll, describe, expect, it, vi } from 'vitest';

// Only native styling, icon rendering and navigation are platform boundaries.
// Keep the disclosure, text, storage and all internal presentation/domain owners real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

describe('buildNewSessionLaunchStatusBadges', () => {
    let buildNewSessionLaunchStatusBadges: typeof import('./newSessionLaunchStatusBadges').buildNewSessionLaunchStatusBadges;
    beforeAll(async () => {
        ({ buildNewSessionLaunchStatusBadges } = await import('./newSessionLaunchStatusBadges'));
    }, 120_000);
    it('explains why creation is disabled and withdraws the reason once it is ready', () => {
        const blocked = buildNewSessionLaunchStatusBadges({
            isCreating: false,
            disabledReason: 'Selected credentials are unavailable',
            requesterDisclosure: { owner: 'Alice', machine: 'devbox', signIn: 'full' },
            translate: (key) => key,
        });
        expect(blocked).toEqual([expect.objectContaining({ key: 'machine-requester-disclosure' }), expect.objectContaining({
            key: 'new-session-create-blocked',
            label: 'Selected credentials are unavailable',
            accessibilityLabel: 'Selected credentials are unavailable',
        })]);
        expect(buildNewSessionLaunchStatusBadges({
            isCreating: false, disabledReason: null, translate: (key) => key,
        })).toEqual([]);
    });
    it('uses the incumbent full-sign-in disclosure before a requester Machine launch starts', async () => {
        const badges = buildNewSessionLaunchStatusBadges({
            isCreating: false,
            requesterDisclosure: { owner: 'Alice', machine: 'devbox', signIn: 'full' },
            translate: (key) => key,
        });
        expect(badges).toEqual([expect.objectContaining({
            key: 'machine-requester-disclosure',
            label: 'Runs on Alice’s devbox',
            labelNumberOfLines: 0,
            renderPopover: expect.any(Function),
        })]);
        expect(buildNewSessionLaunchStatusBadges({
            isCreating: false, translate: (key) => key,
        })).toEqual([]);
    });
    it('does not add launch status while the create action is idle', async () => {
        expect(buildNewSessionLaunchStatusBadges({
            isCreating: false,
            translate: (key) => key,
        })).toEqual([]);
    });

    it('surfaces launch progress while a spawn request is unresolved', async () => {
        const translate = vi.fn((key: string) => key);

        expect(buildNewSessionLaunchStatusBadges({
            isCreating: true,
            disabledReason: 'Selected credentials are unavailable',
            translate,
        })).toEqual([{
            key: 'new-session-launch-starting',
            label: 'newSession.startingSession',
            accessibilityLabel: 'newSession.startingSession',
            testID: 'new-session-launch-status',
            tone: 'active',
            emphasis: 'prominent',
        }]);
        expect(translate).toHaveBeenCalledWith('newSession.startingSession');
    });
});
