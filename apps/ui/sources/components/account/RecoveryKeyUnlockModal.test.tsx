import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from './accountTestHelpers';
import { installPasswordKdfWorkerBoundary } from '@/dev/testkit/mocks/passwordKdfWorker';
import { keyChallengeV2Fixture } from '@/dev/testkit/fixtures/authChallengeFixtures';

const runtime = vi.hoisted(() => ({
    focused: [] as string[],
}));

// The host TextInput is the platform boundary that receives focus; PasswordField and its ref
// forwarding stay real above it.
installAccountCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock, createFocusableTextInputMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TextInput: createFocusableTextInputMock(() => {}, (props) => { runtime.focused.push(String(props.testID)); }),
        });
    },
});

// installAccountCommonModuleMocks registers its mocks when it runs, so the owner graph loads after it.
const { RecoveryKeyUnlockModal } = await import('./RecoveryKeyUnlockModal');
const recovery = await import('@/auth/password/recoverPasswordEnvelopeSecret');
const { preparePasswordCredentialMaterialV1 } = await import('@/auth/password/preparePasswordCredential');

async function passwordService(secret: Uint8Array) {
    const prepared = await preparePasswordCredentialMaterialV1({ password: 'right password value', secret });
    return vi.fn(async (path: string, _init?: RequestInit) => path.endsWith('/prelogin')
        ? Response.json({ v: 1, kind: 'e2ee_password_unlock', kdf: prepared.envelope.kdf })
        : Response.json({ envelope: prepared.envelope, expectedAccountId: 'account-a',
            challenge: keyChallengeV2Fixture({ challengeId: 'recovery-challenge', nonce: 'recovery-nonce' }),
        }));
}

beforeEach(() => installPasswordKdfWorkerBoundary());

afterEach(() => {
    standardCleanup();
    runtime.focused.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('RecoveryKeyUnlockModal', () => {
    it('focuses the password field after a failed local unlock', async () => {
        const request = await passwordService(new Uint8Array(32).fill(29));
        const screen = await renderScreen(<RecoveryKeyUnlockModal
            email="person@example.test"
            request={request}
            onUnlocked={vi.fn()}
            onClose={vi.fn()}
        />);

        await act(async () => screen.findByTestId('recovery-key-unlock-password')?.props.onChangeText('wrong password value'));
        await screen.pressByTestIdAsync('recovery-key-unlock-submit');

        await vi.waitFor(async () => { await act(async () => {}); expect(runtime.focused).toEqual(['recovery-key-unlock-password']); });
        expect(screen.findHostByTestId('recovery-key-unlock-password-error')).not.toBeNull();
    });

    it('clears the recovered bytes after handing a usable view to the disclosure owner', async () => {
        const request = await passwordService(new Uint8Array(32).fill(29));
        // Observe the real return value to verify the caller erases its local secret buffer.
        const recover = vi.spyOn(recovery, 'recoverPasswordEnvelopeSecret');
        const observed: number[][] = [];
        const screen = await renderScreen(<RecoveryKeyUnlockModal
            email="person@example.test"
            request={request}
            onUnlocked={(value) => { observed.push(Array.from(value)); }}
            onClose={vi.fn()}
        />);

        await act(async () => screen.findByTestId('recovery-key-unlock-password')?.props.onChangeText('right password value'));
        await screen.pressByTestIdAsync('recovery-key-unlock-submit');

        await vi.waitFor(async () => { await act(async () => {}); expect(observed[0]).toEqual(new Array(32).fill(29)); });
        expect(await recover.mock.results[0]!.value).toEqual(new Uint8Array(32));
        expect(screen.findByTestId('recovery-key-unlock-password')?.props.value).toBe('');
    });

    it('asks for the sign-in email too when the caller does not know it, and unlocks with what was typed', async () => {
        const request = await passwordService(new Uint8Array(32).fill(5));
        const onUnlocked = vi.fn();
        const screen = await renderScreen(<RecoveryKeyUnlockModal
            email={null}
            request={request}
            onUnlocked={onUnlocked}
            onClose={vi.fn()}
        />);

        await act(async () => screen.findByTestId('recovery-key-unlock-email')?.props.onChangeText('person@example.test'));
        await act(async () => screen.findByTestId('recovery-key-unlock-password')?.props.onChangeText('wrong password value'));
        await screen.pressByTestIdAsync('recovery-key-unlock-submit');
        // A wrong pair is a typed error under the field; the key is not disclosed.
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findHostByTestId('recovery-key-unlock-password-error')).not.toBeNull(); });
        expect(onUnlocked).not.toHaveBeenCalled();
        expect(request.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).email === 'person@example.test')).toBe(true);

        await act(async () => screen.findByTestId('recovery-key-unlock-password')?.props.onChangeText('right password value'));
        await screen.pressByTestIdAsync('recovery-key-unlock-submit');
        await vi.waitFor(async () => { await act(async () => {}); expect(onUnlocked).toHaveBeenCalledTimes(1); });
    });
});
