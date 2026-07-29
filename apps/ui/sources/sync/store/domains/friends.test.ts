import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFriendsDomain, type FriendsDomain } from './friends';

type FriendsTestState = FriendsDomain & { profile: { id: string } };

const assumeUsersMock = vi.hoisted(() => vi.fn());
const legacyAssumeUsersMock = vi.hoisted(() => vi.fn());
const getSyncSingletonMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: getSyncSingletonMock,
}));

vi.mock('../../sync', () => ({
    sync: {
        assumeUsers: legacyAssumeUsersMock,
    },
}));

function createTestDomain(): FriendsTestState {
    let state: FriendsTestState;
    const get = () => state;
    const set = (updater: FriendsTestState | Partial<FriendsTestState> | ((current: FriendsTestState) => FriendsTestState | Partial<FriendsTestState>)) => {
        state = {
            ...state,
            ...(typeof updater === 'function' ? updater(state) : updater),
        };
    };

    state = {
        profile: { id: 'me' },
        ...createFriendsDomain<FriendsTestState>({ get, set }),
    };

    return state;
}

describe('createFriendsDomain', () => {
    beforeEach(() => {
        assumeUsersMock.mockReset();
        legacyAssumeUsersMock.mockReset();
        getSyncSingletonMock.mockReset();
        getSyncSingletonMock.mockReturnValue({
            assumeUsers: assumeUsersMock,
        });
        assumeUsersMock.mockResolvedValue(undefined);
        legacyAssumeUsersMock.mockResolvedValue(undefined);
    });

    it('delegates assumeUsers through the runtime sync singleton', async () => {
        const domain = createTestDomain();

        await domain.assumeUsers(['user-1', 'user-2']);

        expect(getSyncSingletonMock).toHaveBeenCalledTimes(1);
        expect(assumeUsersMock).toHaveBeenCalledWith(['user-1', 'user-2']);
        expect(legacyAssumeUsersMock).not.toHaveBeenCalled();
    });
});
