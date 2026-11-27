import { expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
    configure: vi.fn(),
    logIn: vi.fn(),
    setLogLevel: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('@/config', () => ({ config: { revenueCatAppleKey: 'apple-key' } }));
vi.mock('react-native-purchases', () => ({
    default: sdk,
    LOG_LEVEL: { VERBOSE: 'VERBOSE', DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' },
}));

it('skips startup on self-hosted and configures once across account changes', async () => {
    const { ensurePurchasesConfiguredAtLaunch } = await import('./syncPurchases');
    await ensurePurchasesConfiguredAtLaunch({ accountId: 'first', storePlansOffered: false });
    await ensurePurchasesConfiguredAtLaunch({ accountId: 'first', storePlansOffered: true, shouldContinue: () => false });
    expect(sdk.configure).not.toHaveBeenCalled();
    expect(sdk.logIn).not.toHaveBeenCalled();

    await ensurePurchasesConfiguredAtLaunch({ accountId: 'first', storePlansOffered: true });
    await ensurePurchasesConfiguredAtLaunch({ accountId: 'first', storePlansOffered: true });
    await ensurePurchasesConfiguredAtLaunch({ accountId: 'second', storePlansOffered: true });
    expect(sdk.configure).toHaveBeenCalledTimes(1);
    expect(sdk.configure).toHaveBeenCalledWith(expect.objectContaining({ appUserID: 'first' }));
    expect(sdk.logIn).toHaveBeenCalledExactlyOnceWith('second');
});
