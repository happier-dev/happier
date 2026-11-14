import { describe, expect, it, vi } from 'vitest';
import {
  createHomeCredentialDestinationDigestV1,
  type OpenedAccountDirectoryHomeEntryV1,
  type HomeLoginAssertionV1,
  type HomeLoginRedemptionResultV1,
} from '@happier-dev/protocol';

import {
  continueAccountServiceHomeEnrollment,
  enrollAccountServiceHome,
  observeAccountServiceHomeApproval,
  publishAccountServiceHomeLink,
  runAccountServiceDirectoryJourney,
  selectAccountServiceAuthenticationMethod,
  resolveAccountServiceHomeTarget,
  type AccountServiceHomeEnrollmentAdapters,
} from './index.js';
import { CredentialRequestRedirectError } from '../homeTarget/credentialRequestRedirectPolicy.js';

const HOME_A = createHome('srv_home_a', false);
const HOME_B = createHome('srv_home_b', true);
const HOME_C = createHome('srv_home_c', false);
const ACCOUNT_SUBJECT = { accountId: 'account-1', encryptionMode: 'e2ee' } as const;

function createHome(
  homeServerIdentityId: string,
  preferred: boolean,
): OpenedAccountDirectoryHomeEntryV1 {
  const canonicalServerUrl = `https://${homeServerIdentityId}.example.test`;
  return {
    v: 1,
    homeServerIdentityId,
    canonicalServerUrl,
    label: homeServerIdentityId,
    preferred,
    connectionDescriptor: {
      v: 1,
      homeServerIdentityId,
      canonicalServerUrl,
      revision: 1,
      endpoints: [{ kind: 'https', url: canonicalServerUrl }],
    },
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_001,
  };
}

function createAssertion(
  home = HOME_B,
  overrides: Partial<HomeLoginAssertionV1> = {},
): HomeLoginAssertionV1 {
  return {
    v: 1,
    purpose: 'happier.home-login',
    issuerServerIdentityId: 'srv_directory',
    issuerSubjectId: 'account-1',
    audienceHomeServerIdentityId: home.homeServerIdentityId,
    credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(
      home.connectionDescriptor,
    ),
    clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    issuedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_120_000,
    keyId: 'a'.repeat(64),
    signatureBase64Url: 'A'.repeat(86),
    ...overrides,
  };
}

function createEnrollmentHarness(options: Readonly<{
  assertion?: HomeLoginAssertionV1;
  redemption?: HomeLoginRedemptionResultV1;
}> = {}) {
  const adoptionOrder: string[] = [];
  const transport = { id: 'transport-b' };
  const successfulRedemption: HomeLoginRedemptionResultV1 = {
    v: 1,
    homeServerIdentityId: HOME_B.homeServerIdentityId,
    sealedHomeTokenBase64Url: 'A'.repeat(43),
    issuedAtMs: 1_700_000_001_000,
    expiresAtMs: 1_700_000_121_000,
  };
  const adapters: AccountServiceHomeEnrollmentAdapters<string, typeof transport, string, string> = {
    createRequesterKeyPair: vi.fn(async () => ({
      publicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      secretKey: 'requester-secret',
    })),
    requestAssertion: vi.fn(async () => options.assertion ?? createAssertion()),
    openHomeTransport: vi.fn(async () => ({
      transport,
      authenticatedCredentialDestination: {
        kind: 'https' as const,
        applicationUrl: HOME_B.canonicalServerUrl,
      },
    })),
    observeHomeBeforeRedemption: vi.fn(async ({ home }) => ({
      homeServerIdentityId: home.homeServerIdentityId,
      connectionDescriptor: home.connectionDescriptor,
      provenance: 'public' as const,
    })),
    redeemAssertion: vi.fn(async () => options.redemption ?? successfulRedemption),
    decodeHomeCredential: vi.fn(async () => 'home-credential'),
    observeAuthenticatedHome: vi.fn(async () => ({
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      connectionDescriptor: HOME_B.connectionDescriptor,
      provenance: 'authenticated' as const,
    })),
    commitHomeCredential: vi.fn(async () => 'committed-profile-b'),
    reconcileAuthenticatedHome: vi.fn(async () => {}),
    closeHomeTransport: vi.fn(async () => {}),
  };
  const adoptHome = vi.fn(async (home: OpenedAccountDirectoryHomeEntryV1) => {
    adoptionOrder.push(home.homeServerIdentityId);
  });
  return { adapters, adoptHome, adoptionOrder };
}

describe('Account Service deterministic domain operations', () => {
  it.each(['requestAssertion', 'redeemAssertion', 'reconcileAuthenticatedHome'] as const)('preserves %s redirect refusal without enrollment fallback or retry', async (phase) => {
    const { adapters, adoptHome } = createEnrollmentHarness();
    const refusal = new CredentialRequestRedirectError(307);
    const enrollmentAdapters = { ...adapters, [phase]: async () => { throw refusal; } } satisfies typeof adapters;
    await expect(runAccountServiceDirectoryJourney({
      directory: { homes: [HOME_B], preferredHomeServerIdentityId: HOME_B.homeServerIdentityId },
      issuerServerIdentityId: 'srv_directory', adoptHome, enrollmentAdapters, nowMs: 1_700_000_002_000,
    })).rejects.toBe(refusal);
    expect(adapters.commitHomeCredential).not.toHaveBeenCalled();
    if (phase === 'requestAssertion') expect(adapters.openHomeTransport).not.toHaveBeenCalled();
    else expect(adapters.closeHomeTransport).toHaveBeenCalledOnce();
  });

  it('selects the exact linked Home before a different preferred Home and never substitutes for an absent target', () => {
    const directory = { homes: [HOME_A, HOME_B], preferredHomeServerIdentityId: HOME_B.homeServerIdentityId };
    expect(resolveAccountServiceHomeTarget({ directory, explicitHomeServerIdentityId: HOME_A.homeServerIdentityId }))
      .toEqual({ kind: 'selected', basis: 'explicit', home: HOME_A });
    expect(resolveAccountServiceHomeTarget({ directory, explicitHomeServerIdentityId: HOME_C.homeServerIdentityId }))
      .toEqual({ kind: 'explicit_target_not_linked', homeServerIdentityId: HOME_C.homeServerIdentityId });
  });

  it('selects preferred then structurally sole, otherwise returns the complete chooser or no Homes', () => {
    expect(resolveAccountServiceHomeTarget({ directory: { homes: [HOME_A, HOME_B], preferredHomeServerIdentityId: HOME_B.homeServerIdentityId } }))
      .toEqual({ kind: 'selected', basis: 'preferred', home: HOME_B });
    expect(resolveAccountServiceHomeTarget({ directory: { homes: [HOME_A], preferredHomeServerIdentityId: null } }))
      .toEqual({ kind: 'selected', basis: 'sole', home: HOME_A });
    expect(resolveAccountServiceHomeTarget({ directory: { homes: [HOME_A, HOME_C], preferredHomeServerIdentityId: null } }))
      .toEqual({ kind: 'choose_home', homes: [HOME_A, HOME_C] });
    expect(resolveAccountServiceHomeTarget({ directory: { homes: [], preferredHomeServerIdentityId: null } }))
      .toEqual({ kind: 'no_homes' });
  });

  it('rejects invalid Directory data even when the explicit Home itself is valid', () => {
    expect(resolveAccountServiceHomeTarget({
      directory: { homes: [HOME_A, HOME_A], preferredHomeServerIdentityId: null },
      explicitHomeServerIdentityId: HOME_A.homeServerIdentityId,
    })).toEqual({ kind: 'invalid_directory', reason: 'invalid_directory' });
    expect(resolveAccountServiceHomeTarget({ directory: { homes: [HOME_A], preferredHomeServerIdentityId: HOME_B.homeServerIdentityId } }))
      .toEqual({ kind: 'invalid_directory', reason: 'invalid_directory' });
  });

  it('rejects an advertised requested method that is unavailable without selecting a fallback', () => {
    expect(selectAccountServiceAuthenticationMethod({
      advertised: { keyLoginAvailable: true, oauthProviderIds: ['github'] },
      requested: { kind: 'oauth', providerId: 'google' },
    })).toEqual({
      kind: 'requested_method_unavailable',
      requestedMethod: { kind: 'oauth', providerId: 'google' },
    });
  });

  it('adopts all three Homes without focus but asserts, redeems, and enrolls only the preferred Home', async () => {
    const { adapters, adoptHome, adoptionOrder } = createEnrollmentHarness();

    const result = await runAccountServiceDirectoryJourney({
      directory: {
        homes: [HOME_A, HOME_B, HOME_C],
        preferredHomeServerIdentityId: HOME_B.homeServerIdentityId,
      },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(adoptionOrder).toEqual([
      HOME_A.homeServerIdentityId,
      HOME_B.homeServerIdentityId,
      HOME_C.homeServerIdentityId,
    ]);
    expect(adapters.requestAssertion).toHaveBeenCalledOnce();
    expect(adapters.requestAssertion).toHaveBeenCalledWith({
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });
    expect(adapters.openHomeTransport).toHaveBeenCalledOnce();
    expect(adapters.redeemAssertion).toHaveBeenCalledOnce();
    expect(adapters.commitHomeCredential).toHaveBeenCalledOnce();
    expect(adapters.commitHomeCredential).toHaveBeenCalledWith(expect.objectContaining({
      transport: expect.anything(),
    }));
    expect(result).toMatchObject({
      kind: 'home_enrolled',
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      adoption: { kind: 'completed', failures: [] },
      enrollment: { kind: 'enrolled', commit: 'committed-profile-b' },
    });
  });

  it('stops before assertion or redemption when the selected Home adoption fails', async () => {
    const { adapters, adoptHome } = createEnrollmentHarness();
    const adoptionError = new Error('selected Home profile conflict');
    vi.mocked(adoptHome).mockImplementation(async (candidate) => {
      if (candidate.homeServerIdentityId === HOME_B.homeServerIdentityId) throw adoptionError;
    });

    const result = await runAccountServiceDirectoryJourney({
      directory: {
        homes: [HOME_A, HOME_B],
        preferredHomeServerIdentityId: HOME_B.homeServerIdentityId,
      },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toMatchObject({
      kind: 'home_adoption_failed',
      selection: 'preferred',
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      adoption: {
        kind: 'partial',
        adopted: [{ homeServerIdentityId: HOME_A.homeServerIdentityId }],
        failures: [{ homeServerIdentityId: HOME_B.homeServerIdentityId, error: adoptionError }],
      },
    });
    expect(adapters.createRequesterKeyPair).not.toHaveBeenCalled();
    expect(adapters.requestAssertion).not.toHaveBeenCalled();
    expect(adapters.openHomeTransport).not.toHaveBeenCalled();
    expect(adapters.redeemAssertion).not.toHaveBeenCalled();
  });

  it('enrolls the selected Home while reporting a non-selected adoption failure as partial', async () => {
    const { adapters, adoptHome } = createEnrollmentHarness();
    const adoptionError = new Error('other Home profile conflict');
    vi.mocked(adoptHome).mockImplementation(async (candidate) => {
      if (candidate.homeServerIdentityId === HOME_A.homeServerIdentityId) throw adoptionError;
    });

    const result = await runAccountServiceDirectoryJourney({
      directory: {
        homes: [HOME_A, HOME_B],
        preferredHomeServerIdentityId: HOME_B.homeServerIdentityId,
      },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toMatchObject({
      kind: 'home_enrolled',
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      adoption: {
        kind: 'partial',
        adopted: [{ homeServerIdentityId: HOME_B.homeServerIdentityId }],
        failures: [{ homeServerIdentityId: HOME_A.homeServerIdentityId, error: adoptionError }],
      },
    });
    expect(adapters.requestAssertion).toHaveBeenCalledOnce();
    expect(adapters.redeemAssertion).toHaveBeenCalledOnce();
  });

  it('reports all failed adoptions distinctly while preserving the structural chooser', async () => {
    const { adapters, adoptHome } = createEnrollmentHarness();
    vi.mocked(adoptHome).mockRejectedValue(new Error('profile store unavailable'));
    const homes = [
      { ...HOME_A, preferred: false },
      { ...HOME_B, preferred: false },
    ];

    const result = await runAccountServiceDirectoryJourney({
      directory: { homes, preferredHomeServerIdentityId: null },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toMatchObject({
      kind: 'choose_home',
      homes,
      adoption: { kind: 'failed', adopted: [], failures: [{}, {}] },
    });
    expect(adapters.requestAssertion).not.toHaveBeenCalled();
  });

  it('commits only after verified authenticated observation and exact route reconciliation', async () => {
    const harness = createEnrollmentHarness();
    const order: string[] = [];
    vi.mocked(harness.adapters.commitHomeCredential).mockImplementationOnce(async () => {
      order.push('commit');
      return 'committed-profile-b';
    });
    vi.mocked(harness.adapters.observeAuthenticatedHome).mockImplementationOnce(async () => {
      order.push('observe_authenticated');
      return {
        homeServerIdentityId: HOME_B.homeServerIdentityId,
        connectionDescriptor: HOME_B.connectionDescriptor,
        provenance: 'authenticated',
      };
    });
    vi.mocked(harness.adapters.reconcileAuthenticatedHome).mockImplementationOnce(async () => {
      order.push('reconcile');
    });

    const result = await continueAccountServiceHomeEnrollment({
      home: HOME_B,
      assertion: createAssertion(),
      requesterSecretKey: 'requester-secret',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toEqual({ kind: 'enrolled', commit: 'committed-profile-b' });
    expect(order).toEqual(['observe_authenticated', 'reconcile', 'commit']);
  });

  it('rejects a public post-redemption observation before reconciliation or credential commit', async () => {
    const harness = createEnrollmentHarness();
    vi.mocked(harness.adapters.observeAuthenticatedHome).mockResolvedValueOnce({
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      connectionDescriptor: HOME_B.connectionDescriptor,
      provenance: 'public',
    });

    await expect(continueAccountServiceHomeEnrollment({
      home: HOME_B,
      assertion: createAssertion(),
      requesterSecretKey: 'requester-secret',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    })).resolves.toEqual({
      kind: 'verification_failed',
      stage: 'post_redemption',
      reason: 'authenticated_observation_required',
    });
    expect(harness.adapters.reconcileAuthenticatedHome).not.toHaveBeenCalled();
    expect(harness.adapters.commitHomeCredential).not.toHaveBeenCalled();
  });

  it('does not commit when exact route reconciliation fails', async () => {
    const harness = createEnrollmentHarness();
    vi.mocked(harness.adapters.reconcileAuthenticatedHome).mockRejectedValueOnce(
      new Error('projection refresh unavailable'),
    );

    await expect(continueAccountServiceHomeEnrollment({
      home: HOME_B,
      assertion: createAssertion(),
      requesterSecretKey: 'requester-secret',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    })).resolves.toEqual({
      kind: 'verification_failed',
      stage: 'post_redemption',
      reason: 'authenticated_reconciliation_failed',
    });
    expect(harness.adapters.commitHomeCredential).not.toHaveBeenCalled();
  });

  it('keeps a pre-redemption destination contradiction terminal and distinct from retryable post-redemption failures', async () => {
    const harness = createEnrollmentHarness();
    const result = await continueAccountServiceHomeEnrollment({
      home: HOME_B,
      assertion: createAssertion(HOME_B, {
        credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(
          HOME_A.connectionDescriptor,
        ),
      }),
      requesterSecretKey: 'requester-secret',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toEqual({
      kind: 'verification_failed',
      reason: 'credential_destination_mismatch',
    });
    expect(harness.adapters.redeemAssertion).not.toHaveBeenCalled();
    expect(harness.adapters.commitHomeCredential).not.toHaveBeenCalled();
  });

  it('retains the same process-local invocation for a post-redemption retry', async () => {
    const harness = createEnrollmentHarness();
    vi.mocked(harness.adapters.observeAuthenticatedHome)
      .mockResolvedValueOnce({
        homeServerIdentityId: HOME_B.homeServerIdentityId,
        connectionDescriptor: HOME_B.connectionDescriptor,
        provenance: 'public',
      })
      .mockResolvedValueOnce({
        homeServerIdentityId: HOME_B.homeServerIdentityId,
        connectionDescriptor: HOME_B.connectionDescriptor,
        provenance: 'authenticated',
      });

    const journey = await runAccountServiceDirectoryJourney({
      directory: {
        homes: [HOME_B],
        preferredHomeServerIdentityId: HOME_B.homeServerIdentityId,
      },
      issuerServerIdentityId: 'srv_directory',
      adoptHome: harness.adoptHome,
      enrollmentAdapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(journey).toMatchObject({
      kind: 'home_failed',
      selection: 'preferred',
      enrollment: {
        kind: 'verification_failed',
        stage: 'post_redemption',
        retry: expect.any(Function),
      },
    });
    if (journey.kind !== 'home_failed'
      || journey.enrollment.kind !== 'verification_failed'
      || !('stage' in journey.enrollment)
      || !journey.enrollment.retry) {
      throw new Error('Expected retained post-redemption invocation');
    }

    await expect(journey.enrollment.retry({ nowMs: 1_700_000_003_000 })).resolves.toEqual({
      kind: 'enrolled',
      commit: 'committed-profile-b',
    });
    expect(harness.adapters.createRequesterKeyPair).toHaveBeenCalledOnce();
    expect(harness.adapters.requestAssertion).toHaveBeenCalledOnce();
    expect(harness.adapters.redeemAssertion).toHaveBeenCalledTimes(2);
    expect(harness.adapters.commitHomeCredential).toHaveBeenCalledOnce();
  });

  it('does not re-enter the retained invocation after the original assertion expires', async () => {
    const harness = createEnrollmentHarness();
    vi.mocked(harness.adapters.observeAuthenticatedHome).mockResolvedValue({
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      connectionDescriptor: HOME_B.connectionDescriptor,
      provenance: 'public',
    });
    const assertion = createAssertion();
    const result = await enrollAccountServiceHome({
      home: HOME_B,
      issuerServerIdentityId: 'srv_directory',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    });
    if (result.kind !== 'verification_failed'
      || !('stage' in result)
      || !result.retry) {
      throw new Error('Expected retained post-redemption invocation');
    }

    await expect(result.retry({ nowMs: assertion.expiresAtMs })).resolves.toEqual({
      kind: 'verification_failed',
      reason: 'redemption_expired',
    });
    expect(harness.adapters.requestAssertion).toHaveBeenCalledOnce();
    expect(harness.adapters.openHomeTransport).toHaveBeenCalledOnce();
    expect(harness.adapters.redeemAssertion).toHaveBeenCalledOnce();
    expect(harness.adapters.commitHomeCredential).not.toHaveBeenCalled();
  });

  it('does not commit when authenticated Home observation is unavailable', async () => {
    const harness = createEnrollmentHarness();
    vi.mocked(harness.adapters.observeAuthenticatedHome).mockRejectedValueOnce(
      new Error('authenticated feature observation unavailable'),
    );

    const result = await continueAccountServiceHomeEnrollment({
      home: HOME_B,
      assertion: createAssertion(),
      requesterSecretKey: 'requester-secret',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toMatchObject({ kind: 'unavailable' });
    expect(harness.adapters.reconcileAuthenticatedHome).not.toHaveBeenCalled();
    expect(harness.adapters.commitHomeCredential).not.toHaveBeenCalled();
  });

  it('enrolls a sole non-preferred Home through the production Directory journey', async () => {
    const { adapters, adoptHome } = createEnrollmentHarness();
    const home = { ...HOME_B, preferred: false };
    const result = await runAccountServiceDirectoryJourney({
      directory: { homes: [home], preferredHomeServerIdentityId: null },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });
    expect(result).toMatchObject({
      kind: 'home_enrolled',
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      selection: 'sole',
      enrollment: { kind: 'enrolled', commit: 'committed-profile-b' },
    });
  });

  it('never starts enrollment for an absent explicit target despite a preferred Home', async () => {
    const { adapters, adoptHome } = createEnrollmentHarness();
    const result = await runAccountServiceDirectoryJourney({
      directory: { homes: [HOME_B], preferredHomeServerIdentityId: HOME_B.homeServerIdentityId },
      explicitHomeServerIdentityId: HOME_A.homeServerIdentityId,
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });
    expect(result).toMatchObject({ kind: 'explicit_target_not_linked', homeServerIdentityId: HOME_A.homeServerIdentityId });
    expect(adapters.requestAssertion).not.toHaveBeenCalled();
    expect(adapters.commitHomeCredential).not.toHaveBeenCalled();
  });

  it('adopts every Home but makes no assertion when several Homes have no preference', async () => {
    const { adapters, adoptHome, adoptionOrder } = createEnrollmentHarness();
    const homes = [
      { ...HOME_A, preferred: false },
      { ...HOME_B, preferred: false },
      { ...HOME_C, preferred: false },
    ];

    const result = await runAccountServiceDirectoryJourney({
      directory: { homes, preferredHomeServerIdentityId: null },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(adoptionOrder).toHaveLength(3);
    expect(adapters.createRequesterKeyPair).not.toHaveBeenCalled();
    expect(adapters.requestAssertion).not.toHaveBeenCalled();
    expect(adapters.openHomeTransport).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'choose_home', homes });
  });

  it('distinguishes an empty Directory from linked Homes with no preferred Home', async () => {
    const { adapters, adoptHome } = createEnrollmentHarness();

    const result = await runAccountServiceDirectoryJourney({
      directory: { homes: [], preferredHomeServerIdentityId: null },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toMatchObject({
      kind: 'no_linked_homes',
      adoption: { kind: 'completed', adopted: [], failures: [] },
    });
    expect(adoptHome).not.toHaveBeenCalled();
    expect(adapters.createRequesterKeyPair).not.toHaveBeenCalled();
  });

  it('does not request or redeem a preferred-Home assertion after Directory adoption is cancelled', async () => {
    const { adapters, adoptHome } = createEnrollmentHarness();
    let cancelled = false;
    vi.mocked(adoptHome).mockImplementationOnce(async () => {
      cancelled = true;
    });

    const result = await runAccountServiceDirectoryJourney({
      directory: {
        homes: [HOME_A, HOME_B],
        preferredHomeServerIdentityId: HOME_B.homeServerIdentityId,
      },
      issuerServerIdentityId: 'srv_directory',
      adoptHome,
      enrollmentAdapters: adapters,
      nowMs: 1_700_000_002_000,
      shouldCancel: () => cancelled,
    });

    expect(result).toMatchObject({ kind: 'cancelled' });
    expect(adoptHome).toHaveBeenCalledOnce();
    expect(adapters.createRequesterKeyPair).not.toHaveBeenCalled();
    expect(adapters.requestAssertion).not.toHaveBeenCalled();
  });

  it.each([
    [
      'assertion audience',
      HOME_B,
      createAssertion(HOME_B, { audienceHomeServerIdentityId: HOME_A.homeServerIdentityId }),
      'assertion_audience_mismatch',
    ],
    [
      'destination digest',
      HOME_B,
      createAssertion(HOME_B, {
        credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(
          HOME_A.connectionDescriptor,
        ),
      }),
      'credential_destination_mismatch',
    ],
    [
      'Home identity',
      { ...HOME_B, homeServerIdentityId: HOME_A.homeServerIdentityId },
      createAssertion(HOME_B),
      'home_identity_mismatch',
    ],
    [
      'descriptor',
      { ...HOME_B, canonicalServerUrl: HOME_A.canonicalServerUrl },
      createAssertion(HOME_B),
      'descriptor_mismatch',
    ],
  ])('fails a %s mismatch before transport, redemption, or credential commit', async (
    _label,
    home,
    assertion,
    reason,
  ) => {
    const harness = createEnrollmentHarness({ assertion });

    const result = await runAccountServiceDirectoryJourney({
      directory: {
        homes: [home as OpenedAccountDirectoryHomeEntryV1],
        preferredHomeServerIdentityId: home.homeServerIdentityId,
      },
      issuerServerIdentityId: 'srv_directory',
      adoptHome: harness.adoptHome,
      enrollmentAdapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(result).toMatchObject({
      kind: reason === 'home_identity_mismatch' || reason === 'descriptor_mismatch'
        ? 'invalid_directory'
        : 'home_failed',
      enrollment: { kind: 'verification_failed', reason },
    });
    expect(harness.adapters.openHomeTransport).not.toHaveBeenCalled();
    expect(harness.adapters.redeemAssertion).not.toHaveBeenCalled();
    expect(harness.adapters.commitHomeCredential).not.toHaveBeenCalled();
  });

  it('returns a typed durable approval and a later observation can enroll with the same assertion', async () => {
    const approvalRequired: HomeLoginRedemptionResultV1 = {
      v: 1,
      outcome: 'approval_required',
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      approvalId: 'approval-b',
      deviceLabel: null,
      expiresAtMs: 1_700_000_120_000,
    };
    const harness = createEnrollmentHarness({ redemption: approvalRequired });
    const first = await runAccountServiceDirectoryJourney({
      directory: {
        homes: [HOME_B],
        preferredHomeServerIdentityId: HOME_B.homeServerIdentityId,
      },
      issuerServerIdentityId: 'srv_directory',
      adoptHome: harness.adoptHome,
      enrollmentAdapters: harness.adapters,
      nowMs: 1_700_000_002_000,
    });

    expect(first).toMatchObject({
      kind: 'home_awaiting_approval',
      enrollment: {
        kind: 'approval_required',
        approval: { approvalId: 'approval-b', homeServerIdentityId: HOME_B.homeServerIdentityId },
      },
    });
    if (first.kind !== 'home_awaiting_approval') throw new Error('approval expected');

    const successfulRedemption: HomeLoginRedemptionResultV1 = {
      v: 1,
      homeServerIdentityId: HOME_B.homeServerIdentityId,
      sealedHomeTokenBase64Url: 'A'.repeat(43),
      issuedAtMs: 1_700_000_003_000,
      expiresAtMs: 1_700_000_123_000,
    };
    vi.mocked(harness.adapters.redeemAssertion).mockResolvedValueOnce(successfulRedemption);
    const resumed = await observeAccountServiceHomeApproval({
      approval: first.enrollment.approval,
      adapters: harness.adapters,
      nowMs: 1_700_000_004_000,
    });

    expect(resumed).toEqual({ kind: 'enrolled', commit: 'committed-profile-b' });
    expect(harness.adapters.redeemAssertion).toHaveBeenLastCalledWith({
      transport: { id: 'transport-b' },
      assertion: createAssertion(),
      approvalId: 'approval-b',
    });
    expect(harness.adapters.commitHomeCredential).toHaveBeenCalledOnce();
  });

  it('reports cancellation when the active attempt is aborted during Home transport acquisition', async () => {
    const harness = createEnrollmentHarness();
    let cancelled = false;
    vi.mocked(harness.adapters.openHomeTransport).mockImplementationOnce(async () => {
      cancelled = true;
      throw new DOMException('Aborted', 'AbortError');
    });

    const result = await continueAccountServiceHomeEnrollment({
      home: HOME_B,
      assertion: createAssertion(),
      requesterSecretKey: 'requester-secret',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
      shouldCancel: () => cancelled,
    });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(harness.adapters.commitHomeCredential).not.toHaveBeenCalled();
    expect(harness.adapters.closeHomeTransport).not.toHaveBeenCalled();
  });

  it('preserves an indeterminate commit failure when cancellation races credential custody', async () => {
    const harness = createEnrollmentHarness();
    const commitError = Object.assign(new Error('credential custody interrupted'), {
      homeCredentialCommitted: true,
    });
    let cancelled = false;
    vi.mocked(harness.adapters.commitHomeCredential).mockImplementationOnce(async () => {
      cancelled = true;
      throw commitError;
    });

    const result = await continueAccountServiceHomeEnrollment({
      home: HOME_B,
      assertion: createAssertion(),
      requesterSecretKey: 'requester-secret',
      adapters: harness.adapters,
      nowMs: 1_700_000_002_000,
      shouldCancel: () => cancelled,
    });

    expect(result).toEqual({ kind: 'unavailable', error: commitError });
    expect(harness.adapters.commitHomeCredential).toHaveBeenCalledOnce();
  });

  it('publishes an optional link with distinct Home and Account Service credential adapters', async () => {
    const homeCredential = { kind: 'home' as const, token: 'home-token' };
    const accountServiceCredential = { kind: 'account_service' as const, token: 'directory-token' };
    const readHomeCredential = vi.fn(async () => homeCredential);
    const readAccountServiceCredential = vi.fn(async () => accountServiceCredential);
    const readAccountSubject = vi.fn(async () => ACCOUNT_SUBJECT);
    const publishLinkToHome = vi.fn(async () => {});
    const publishHomeToAccountService = vi.fn(async () => {});

    const result = await publishAccountServiceHomeLink({
      home: HOME_B,
      issuerServerIdentityId: 'srv_directory',
      issuerSigningKeyId: 'a'.repeat(64),
      issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
      adapters: {
        readHomeCredential,
        readAccountServiceCredential,
        readAccountSubject,
        publishLinkToHome,
        publishHomeToAccountService,
      },
    });

    expect(result).toEqual({ kind: 'linked', homeServerIdentityId: HOME_B.homeServerIdentityId });
    expect(readAccountSubject).toHaveBeenCalledWith(accountServiceCredential);
    expect(publishLinkToHome).toHaveBeenCalledWith(expect.objectContaining({ credential: homeCredential }));
    expect(publishHomeToAccountService).toHaveBeenCalledWith(expect.objectContaining({
      credential: accountServiceCredential,
      home: HOME_B,
      issuer: ACCOUNT_SUBJECT,
    }));
    expect(publishLinkToHome).not.toHaveBeenCalledWith(expect.objectContaining({ credential: accountServiceCredential }));
    expect(publishHomeToAccountService).not.toHaveBeenCalledWith(expect.objectContaining({ credential: homeCredential }));
  });

  it('reports the committed link when cancellation is observed only after both publications', async () => {
    let cancelled = false;
    const shouldCancel = vi.fn(() => cancelled);

    const result = await publishAccountServiceHomeLink({
      home: HOME_B,
      issuerServerIdentityId: 'srv_directory',
      issuerSigningKeyId: 'a'.repeat(64),
      issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
      shouldCancel,
      adapters: {
        readHomeCredential: vi.fn(async () => ({ token: 'home-token' })),
        readAccountServiceCredential: vi.fn(async () => ({ token: 'directory-token' })),
        readAccountSubject: vi.fn(async () => ACCOUNT_SUBJECT),
        publishLinkToHome: vi.fn(async () => {}),
        publishHomeToAccountService: vi.fn(async () => {
          cancelled = true;
        }),
      },
    });

    expect(result).toEqual({ kind: 'linked', homeServerIdentityId: HOME_B.homeServerIdentityId });
  });

  it('finishes Account Service publication when cancellation flips during the successful Home publication', async () => {
    let cancelled = false;
    const publishLinkToHome = vi.fn(async () => {
      cancelled = true;
    });
    const publishHomeToAccountService = vi.fn(async () => {});

    const result = await publishAccountServiceHomeLink({
      home: HOME_B,
      issuerServerIdentityId: 'srv_directory',
      issuerSigningKeyId: 'a'.repeat(64),
      issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
      shouldCancel: () => cancelled,
      adapters: {
        readHomeCredential: vi.fn(async () => ({ token: 'home-token' })),
        readAccountServiceCredential: vi.fn(async () => ({ token: 'directory-token' })),
        readAccountSubject: vi.fn(async () => ACCOUNT_SUBJECT),
        publishLinkToHome,
        publishHomeToAccountService,
      },
    });

    expect(result).toEqual({ kind: 'linked', homeServerIdentityId: HOME_B.homeServerIdentityId });
    expect(publishLinkToHome).toHaveBeenCalledOnce();
    expect(publishHomeToAccountService).toHaveBeenCalledOnce();
  });

  it('cancels before either irreversible publication when already cancelled', async () => {
    const publishLinkToHome = vi.fn(async () => {});
    const publishHomeToAccountService = vi.fn(async () => {});

    const result = await publishAccountServiceHomeLink({
      home: HOME_B,
      issuerServerIdentityId: 'srv_directory',
      issuerSigningKeyId: 'a'.repeat(64),
      issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
      shouldCancel: () => true,
      adapters: {
        readHomeCredential: vi.fn(async () => ({ token: 'home-token' })),
        readAccountServiceCredential: vi.fn(async () => ({ token: 'directory-token' })),
        readAccountSubject: vi.fn(async () => ACCOUNT_SUBJECT),
        publishLinkToHome,
        publishHomeToAccountService,
      },
    });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(publishLinkToHome).not.toHaveBeenCalled();
    expect(publishHomeToAccountService).not.toHaveBeenCalled();
  });

  it('reports a retryable failure when Account Service publication fails after the Home publication', async () => {
    const publicationError = new Error('account service unavailable');
    const publishLinkToHome = vi.fn(async () => {});
    const publishHomeToAccountService = vi.fn(async () => {
      throw publicationError;
    });

    const result = await publishAccountServiceHomeLink({
      home: HOME_B,
      issuerServerIdentityId: 'srv_directory',
      issuerSigningKeyId: 'a'.repeat(64),
      issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
      adapters: {
        readHomeCredential: vi.fn(async () => ({ token: 'home-token' })),
        readAccountServiceCredential: vi.fn(async () => ({ token: 'directory-token' })),
        readAccountSubject: vi.fn(async () => ACCOUNT_SUBJECT),
        publishLinkToHome,
        publishHomeToAccountService,
      },
    });

    expect(result).toEqual({ kind: 'failed', error: publicationError });
    expect(publishLinkToHome).toHaveBeenCalledOnce();
    expect(publishHomeToAccountService).toHaveBeenCalledOnce();
  });

  it('rejects a blank Account Service subject before either publication', async () => {
    const publishLinkToHome = vi.fn(async () => {});
    const publishHomeToAccountService = vi.fn(async () => {});

    const result = await publishAccountServiceHomeLink({
      home: HOME_B,
      issuerServerIdentityId: 'srv_directory',
      issuerSigningKeyId: 'a'.repeat(64),
      issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
      adapters: {
        readHomeCredential: vi.fn(async () => ({ token: 'home-token' })),
        readAccountServiceCredential: vi.fn(async () => ({ token: 'directory-token' })),
        readAccountSubject: vi.fn(async () => ({ ...ACCOUNT_SUBJECT, accountId: '   ' })),
        publishLinkToHome,
        publishHomeToAccountService,
      },
    });

    expect(result).toMatchObject({ kind: 'failed' });
    expect(publishLinkToHome).not.toHaveBeenCalled();
    expect(publishHomeToAccountService).not.toHaveBeenCalled();
  });
});
