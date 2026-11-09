import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionMessageAccountByline, type SessionMessageAccountBylineProps } from './SessionMessageAccountByline';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const actor = {
    v: 1 as const,
    serverId: 'home-a',
    accountId: 'alice-private-id',
    profile: { name: 'Alice Chen', firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null },
};
const defaults: SessionMessageAccountBylineProps = {
    messageId: 'message-1', actor,
    viewerScope: { serverId: 'home-a', accountId: 'bob-private-id' },
    hasOtherNamedCollaborator: false,
};

afterEach(standardCleanup);

describe('SessionMessageAccountByline', () => {
    it('announces the full actor name once and keeps the avatar decorative', async () => {
        const screen = await renderScreen(<SessionMessageAccountByline {...defaults} />);
        const label = screen.findHostByTestId('transcript-account-attribution:message-1');
        expect(label?.props.accessibilityLabel).toBe('message.accountActorSentBy(name=Alice Chen)');
        expect(label?.props.numberOfLines).toBe(1);
        expect(screen.findHostByTestId('transcript-account-avatar:message-1')?.props.accessibilityElementsHidden).toBe(true);
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain(actor.accountId);
    });

    it('hides solo self bylines, then shows You only for the exact Home Account in a collaborative session', async () => {
        const solo = await renderScreen(<SessionMessageAccountByline {...defaults} viewerScope={actor} />);
        expect(solo.findHostByTestId('transcript-account-attribution:message-1')).toBeNull();
        const shared = await renderScreen(<SessionMessageAccountByline {...defaults} viewerScope={actor} hasOtherNamedCollaborator />);
        expect(shared.findHostByTestId('transcript-account-attribution:message-1')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=message.accountActorYou)');
        const otherHome = await renderScreen(<SessionMessageAccountByline {...defaults} viewerScope={{ ...actor, serverId: 'home-b' }} />);
        expect(otherHome.findHostByTestId('transcript-account-attribution:message-1')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=Alice Chen)');
    });

    it('distinguishes former members from unnamed current members without exposing their IDs', async () => {
        const former = await renderScreen(<SessionMessageAccountByline {...defaults} actor={{ ...actor, profile: null }} />);
        expect(former.findHostByTestId('transcript-account-attribution:message-1')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=message.accountActorFormerMember)');
        const unnamed = await renderScreen(<SessionMessageAccountByline {...defaults} actor={{ ...actor, profile: { name: null, firstName: null, lastName: null, username: null, avatarUrl: null } }} />);
        expect(unnamed.findHostByTestId('transcript-account-attribution:message-1')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=message.accountActorUnnamedMember)');
        const currentWithoutProfile = await renderScreen(<SessionMessageAccountByline {...defaults} actor={{ ...actor, accessibility: 'current', profile: null }} />);
        expect(currentWithoutProfile.findHostByTestId('transcript-account-attribution:message-1')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=message.accountActorUnnamedMember)');
        expect(JSON.stringify(former.tree.toJSON())).not.toContain(actor.accountId);
    });

    it('uses the same collaborative-audience rule for Pending and committed self bylines', async () => {
        const solo = await renderScreen(<SessionMessageAccountByline {...defaults} viewerScope={actor} />);
        expect(solo.findHostByTestId('transcript-account-attribution:message-1')).toBeNull();

        const shared = await renderScreen(
            <SessionMessageAccountByline {...defaults} viewerScope={actor} hasOtherNamedCollaborator />,
        );
        expect(shared.findHostByTestId('transcript-account-attribution:message-1')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=message.accountActorYou)');
    });

    it('renders no inferred attribution for an absent actor or unresolved viewer identity', async () => {
        const absent = await renderScreen(<SessionMessageAccountByline {...defaults} actor={null} />);
        expect(absent.findHostByTestId('transcript-account-attribution:message-1')).toBeNull();
        const unresolved = await renderScreen(<SessionMessageAccountByline {...defaults} viewerScope={null} />);
        expect(unresolved.findHostByTestId('transcript-account-attribution:message-1')).toBeNull();
    });
});
