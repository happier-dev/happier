import { createInTxHarness } from "../api/testkit/txHarness";

export function createSocialAccount(userId: string) {
    return {
        id: userId,
        username: userId,
        AccountIdentity: [{ provider: "github", profile: { login: userId } }],
    };
}

export function createInTxWithAccountLookup(
    findUnique: (...args: any[]) => unknown,
) {
    return createInTxHarness(() => ({
        account: {
            findUnique: (...args: any[]) => findUnique(...args),
        },
    }));
}
