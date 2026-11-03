import { expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

it('uses neutral branding for an absent or invalid Account service without crashing', async () => {
    const { isDefaultAccountServiceUrl } = await import('./AccountServiceMark');
    expect(isDefaultAccountServiceUrl('')).toBe(false);
    expect(isDefaultAccountServiceUrl('invalid-url')).toBe(false);
    expect(isDefaultAccountServiceUrl('https://accounts.example.test')).toBe(false);
    expect(isDefaultAccountServiceUrl('https://api.happier.dev/')).toBe(true);
});
