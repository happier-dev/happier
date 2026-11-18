import { installPasswordKdfWorkerBoundary } from '@/dev/testkit/mocks/passwordKdfWorker';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { readNativeEmailVerificationContinuation, clearNativeEmailVerificationContinuation } from '@/sync/api/auth/nativeAuthEmail';
import { NativeAuthEmailAcceptedResponseV1Schema, NativeEmailPasswordPreloginResponseV1Schema, NativeEmailPasswordLoginResponseV1Schema, NativeEmailPasswordProvisionRequestV1Schema, NativeEmailPasswordProvisionResponseV1Schema, NativeEmailVerifyRequestV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { maskEmailForNativeAuthPreview } from '@happier-dev/protocol/auth/nativeAuthOneTimeOperation';
import { keyChallengeV2Fixture } from '@/dev/testkit/fixtures/authChallengeFixtures';
import { derivePasswordKeys, openPasswordEnvelope } from '@/auth/password/passwordEnvelope';
import { EmailPasswordAuthPanel } from './EmailPasswordAuthPanel';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let homeA = '';
let homeB = '';
function continuation() {
    return readNativeEmailVerificationContinuation({ homeServerIdentityId: 'srv_home_a', maskedDestination: maskEmailForNativeAuthPreview('person@example.test') });
}

beforeEach(async () => {
    await homes.reset();
    homeA = await homes.addHome({ name: 'Home A', serverUrl: 'https://home-a.example.test', serverIdentityId: 'srv_home_a', accountId: null });
    homeB = await homes.addHome({ name: 'Home B', serverUrl: 'https://home-b.example.test', serverIdentityId: 'srv_home_b', accountId: null });
    homes.answer(homeA, '/v1/auth/email/verify/request', { body: NativeAuthEmailAcceptedResponseV1Schema.parse({ accepted: true }) });
    homes.answer(homeA, '/v1/auth/email/prelogin', { body: NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' }) });
    homes.answer(homeA, '/v1/auth/email/login', { body: NativeEmailPasswordLoginResponseV1Schema.parse({ token: 'late-token' }) });
    homes.answer(homeA, '/v1/auth/email/provision', { body: NativeEmailPasswordProvisionResponseV1Schema.parse({ token: 'created', accountId: 'account-a', teamId: 'team-a' }) });
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    const retained = continuation();
    if (retained) clearNativeEmailVerificationContinuation(retained);
    router.push.mockReset();
    await homes.reset();
    await standardCleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * Fills whatever this creation step actually asks for. A Home that proves the
 * mailbox first renders no password fields, because the Account is created on
 * the verification landing rather than here.
 */
async function fillProvisionForm(rendered: NonNullable<typeof screen>) {
    await act(async () => {
        rendered.findByTestId('email-password-email')!.props.onChangeText(' Person@Example.test ');
        rendered.findByTestId('email-password-password')?.props.onChangeText('a sufficiently long password');
        rendered.findByTestId('email-password-confirm')?.props.onChangeText('a sufficiently long password');
    });
}

it('binds a transferable invitation to the verification request and retains its exact continuation', async () => {
    const admission = { kind: 'team_invitation' as const, token: 'A'.repeat(43) };
    screen = await renderScreen(
        <EmailPasswordAuthPanel
            target={{
                endpointUrl: 'https://home-a.example.test',
                canonicalServerUrl: 'https://home-a.example.test',
                addressAnchorUrl: 'https://home-a.example.test',
                serverId: homeA,
                serverIdentityId: 'srv_home_a',
            }}
            recoveryTarget="srv_home_a"
            action="provision"
            mode="keyless"
            admission={admission}
            invitationEmailVerificationRequired
            onAuthenticated={vi.fn()}
        />,
    );
    await fillProvisionForm(screen);

    await screen.pressByTestIdAsync('email-password-create');

    expect(NativeEmailVerifyRequestV1Schema.parse(homes.requestsFor('/v1/auth/email/verify/request')[0]?.input)).toEqual({ v: 1, email: 'person@example.test', admission });
    expect(continuation()).toEqual({
        homeServerIdentityId: 'srv_home_a',
        normalizedEmail: 'person@example.test',
        admission,
    });
    expect(homes.requestsFor('/v1/auth/email/provision')).toHaveLength(0);
});

it('provisions an addressed invitation directly without redundant mailbox verification', async () => {
    const admission = { kind: 'team_invitation' as const, token: 'B'.repeat(43) };
    screen = await renderScreen(
        <EmailPasswordAuthPanel
            target={{
                endpointUrl: 'https://home-a.example.test',
                canonicalServerUrl: 'https://home-a.example.test',
                addressAnchorUrl: 'https://home-a.example.test',
                serverId: homeA,
                serverIdentityId: 'srv_home_a',
            }}
            recoveryTarget="srv_home_a"
            action="provision"
            mode="keyless"
            admission={admission}
            invitationEmailVerificationRequired={false}
            onAuthenticated={vi.fn()}
        />,
    );
    await fillProvisionForm(screen);

    await screen.pressByTestIdAsync('email-password-create');

    expect(NativeEmailPasswordProvisionRequestV1Schema.parse(homes.requestsFor('/v1/auth/email/provision')[0]?.input)).toMatchObject({ admission });
    expect(homes.requestsFor('/v1/auth/email/verify/request')).toHaveLength(0);
    expect(continuation()).toBeNull();
});

it('does not retain a transferable invitation after its verification request loses navigation custody', async () => {
    let finishRequest!: () => void;
    homes.answer(homeA, '/v1/auth/email/verify/request', { body: NativeAuthEmailAcceptedResponseV1Schema.parse({ accepted: true }), respondAfter: new Promise<void>(resolve => { finishRequest = resolve; }) });
    const admission = { kind: 'team_invitation' as const, token: 'C'.repeat(43) };
    const renderPanel = (suffix: 'a' | 'b') => (
        <EmailPasswordAuthPanel
            target={{
                endpointUrl: `https://home-${suffix}.example.test`,
                canonicalServerUrl: `https://home-${suffix}.example.test`,
                addressAnchorUrl: `https://home-${suffix}.example.test`,
                serverId: suffix === 'a' ? homeA : homeB,
                serverIdentityId: `srv_home_${suffix}`,
            }}
            recoveryTarget={`srv_home_${suffix}`}
            action="provision"
            mode="keyless"
            admission={admission}
            invitationEmailVerificationRequired
            onAuthenticated={vi.fn()}
        />
    );
    screen = await renderScreen(renderPanel('a'));
    await fillProvisionForm(screen);
    await act(async () => {
        screen!.pressByTestId('email-password-create');
        await Promise.resolve();
    });

    await vi.waitFor(() => expect(homes.requestsFor('/v1/auth/email/verify/request')).toHaveLength(1));
    await screen.update(renderPanel('b'));
    await act(async () => finishRequest());

    expect(continuation()).toBeNull();
    expect(screen.findByTestId('email-password-sent-detail')).toBeNull();
});

it('retires a pending login when the exact Home target changes', async () => {
    let resolveLogin!: () => void;
    homes.answer(homeA, '/v1/auth/email/login', { body: NativeEmailPasswordLoginResponseV1Schema.parse({ token: 'late-token' }), respondAfter: new Promise<void>(resolve => { resolveLogin = resolve; }) });
    const onAuthenticated = vi.fn();
    const recoveryTarget = 'srv_home_a';
    const renderPanel = (suffix: 'a' | 'b') => <EmailPasswordAuthPanel
        target={{
            endpointUrl: `https://home-${suffix}.example.test`,
            canonicalServerUrl: `https://home-${suffix}.example.test`,
            addressAnchorUrl: `https://home-${suffix}.example.test`,
            serverId: suffix === 'a' ? homeA : homeB,
            serverIdentityId: `srv_home_${suffix}`,
        }}
        recoveryTarget={recoveryTarget}
        action="login"
        mode="either"
        onAuthenticated={onAuthenticated}
    />;
    screen = await renderScreen(renderPanel('a'));
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        screen!.findByTestId('email-password-password')!.props.onChangeText('a sufficiently long password');
    });
    await act(async () => {
        screen!.pressByTestId('email-password-submit');
        await Promise.resolve();
    });

    await vi.waitFor(() => expect(homes.requestsFor('/v1/auth/email/login')).toHaveLength(1));
    await screen.update(renderPanel('b'));
    await act(async () => { resolveLogin(); });

    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.findByTestId('email-password-email')!.props.value).toBe('');
});

it('erases the generated recovery secret when provisioning retires at the network boundary', async () => {
    installPasswordKdfWorkerBoundary();
    homes.answer(homeA, '/v1/auth/challenge', { body: keyChallengeV2Fixture({
        challengeId: 'provision-challenge',
        audience: { origin: 'https://home-a.example.test', serverIdentityId: 'srv_home_a' },
    }) });
    let resolveProvision!: () => void;
    homes.answer(homeA, '/v1/auth/email/provision', { body: NativeEmailPasswordProvisionResponseV1Schema.parse({ token: 'late-token', accountId: 'account-a', teamId: null }), respondAfter: new Promise<void>(resolve => { resolveProvision = resolve; }) });
    const erased: Array<{ before: Uint8Array; buffer: Uint8Array }> = [];
    const realFill = Uint8Array.prototype.fill;
    vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (this: Uint8Array, value, start, end) {
        if (value === 0 && this.length === 32) erased.push({ before: this.slice(), buffer: this });
        return realFill.call(this, value, start, end);
    });
    const onAuthenticated = vi.fn();
    const renderPanel = (home: 'a' | 'b') => <EmailPasswordAuthPanel
        target={{ endpointUrl: `https://home-${home}.example.test`, canonicalServerUrl: `https://home-${home}.example.test`, addressAnchorUrl: `https://home-${home}.example.test`, serverId: home === 'a' ? homeA : homeB, serverIdentityId: `srv_home_${home}` }}
        recoveryTarget={`srv_home_${home}`} action="provision" mode="keyed"
        admission={{ kind: 'team_invitation', token: 'D'.repeat(43) }} invitationEmailVerificationRequired={false}
        onAuthenticated={onAuthenticated}
    />;
    screen = await renderScreen(renderPanel('a'));
    await fillProvisionForm(screen);
    await act(async () => { screen!.pressByTestId('email-password-create'); });
    await vi.waitFor(() => expect(homes.requestsFor('/v1/auth/email/provision')).toHaveLength(1));
    const request = NativeEmailPasswordProvisionRequestV1Schema.parse(homes.requestsFor('/v1/auth/email/provision')[0]?.input);
    if (request.account.mode !== 'e2ee') throw new Error('Expected encrypted provisioning');
    const keys = await derivePasswordKeys('a sufficiently long password', request.account.envelope.kdf);
    const secret = await openPasswordEnvelope(request.account.envelope, keys.wrapKey);
    await screen.update(renderPanel('b'));
    await act(async () => { resolveProvision(); });
    expect(onAuthenticated).not.toHaveBeenCalled();
    const retiredSecret = erased.find(entry => entry.before.every((byte, index) => byte === secret[index]));
    expect(retiredSecret).toBeDefined();
    expect(retiredSecret?.buffer).toEqual(new Uint8Array(32));
    keys.authKey.fill(0);
    keys.wrapKey.fill(0);
    secret.fill(0);
});
