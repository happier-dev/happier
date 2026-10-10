import { describe, expect, it } from 'vitest';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import {
  homeSettingEntryFixture,
  homeSettingsProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';

import { selectHomeSignInPlatforms } from './homeSignInPlatforms';

const plain = (
  key: string,
  group: string,
  overrides?: Partial<HomeSettingEntryV1>,
) =>
  homeSettingEntryFixture(key, {
    apply: 'restart',
    declaration: { type: 'string', section: 'policies', group },
    ...overrides,
  });
const secret = (
  key: string,
  group: string,
  overrides?: Partial<HomeSettingEntryV1>,
) => plain(key, group, { secretSet: false, ...overrides });

function workos(
  clientId?: Partial<HomeSettingEntryV1>,
  apiKey?: Partial<HomeSettingEntryV1>,
) {
  return selectHomeSignInPlatforms(
    homeSettingsProjectionFixture({
      entries: [
        secret('WORKOS_API_KEY', 'workos', apiKey),
        plain('WORKOS_CLIENT_ID', 'workos', clientId),
      ],
    }),
  ).find((platform) => platform.id === 'workos')!;
}

describe('selectHomeSignInPlatforms', () => {
  it('gathers GitHub sign-in from the github and oauth groups, the credential pair first, and leaves other groups out', () => {
    const platforms = selectHomeSignInPlatforms(
      homeSettingsProjectionFixture({
        entries: [
          plain('AUTH_GITHUB_ALLOWED_ORGS', 'github', {
            declaration: { type: 'list', section: 'policies', group: 'github' },
          }),
          secret('GITHUB_CLIENT_SECRET', 'github'),
          plain('OAUTH_STATE_TTL_SECONDS', 'oauth'),
          plain('GITHUB_CLIENT_ID', 'github'),
          plain('AUTH_SIGNUP_PROVIDERS', 'signup'),
          plain('WORKOS_CLIENT_ID', 'workos'),
        ],
      }),
    );

    expect(platforms.map((platform) => platform.id)).toEqual([
      'github',
      'workos',
    ]);
    const github = platforms[0]!;
    expect(github.primary.map((entry) => entry.key)).toEqual([
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
    ]);
    expect(github.access.map((entry) => entry.key)).toEqual([
      'AUTH_GITHUB_ALLOWED_ORGS',
    ]);
    expect(github.advanced.map((entry) => entry.key)).toEqual([
      'OAUTH_STATE_TTL_SECONDS',
    ]);
  });

  it('keeps GitHub\'s callback address beside the credential pair and who may sign in in its own group, out of Advanced', () => {
    const github = selectHomeSignInPlatforms(
      homeSettingsProjectionFixture({
        entries: [
          plain('AUTH_GITHUB_ALLOWED_ORGS', 'github', {
            declaration: { type: 'list', section: 'policies', group: 'github' },
          }),
          plain('GITHUB_HTTP_TIMEOUT_SECONDS', 'github'),
          plain('GITHUB_REDIRECT_URL', 'github'),
          plain('AUTH_GITHUB_ALLOWED_USERS', 'github'),
          secret('GITHUB_CLIENT_SECRET', 'github'),
          plain('GITHUB_CLIENT_ID', 'github'),
        ],
      }),
    )[0]!;

    expect(github.details.map((entry) => entry.key)).toEqual([
      'GITHUB_REDIRECT_URL',
    ]);
    expect(github.access.map((entry) => entry.key)).toEqual([
      'AUTH_GITHUB_ALLOWED_USERS',
      'AUTH_GITHUB_ALLOWED_ORGS',
    ]);
    expect(github.advanced.map((entry) => entry.key)).toEqual([
      'GITHUB_HTTP_TIMEOUT_SECONDS',
    ]);
    // WorkOS has neither: its row is the credential pair alone.
    expect(workos().details).toEqual([]);
    expect(workos().access).toEqual([]);
  });

  it('says what is missing, naming the first missing credential', () => {
    expect(workos().state).toEqual({ kind: 'not_set' });
    expect(
      workos(undefined, { secretSet: true, source: 'home' }).state,
    ).toEqual({ kind: 'partly_set', need: 'clientId' });
    expect(workos({ value: 'client_1', source: 'home' }).state).toEqual({
      kind: 'partly_set',
      need: 'apiKey',
    });
    // A blank stored value is not a credential.
    expect(
      workos({ value: '  ', source: 'home' }, { secretSet: true }).state,
    ).toEqual({ kind: 'partly_set', need: 'clientId' });
  });

  it("locks per key: ready when one of the pair is the deployment's, locked only when both are", () => {
    expect(
      workos(
        { value: 'client_1', source: 'home' },
        { secretSet: true, source: 'home' },
      ).state,
    ).toEqual({ kind: 'ready', partlyLocked: false });
    expect(
      workos(
        { value: 'client_1', source: 'home' },
        { secretSet: true, source: 'deployment', fixed: true },
      ).state,
    ).toEqual({ kind: 'ready', partlyLocked: true, lockedNeed: 'apiKey' });
    expect(
      workos(
        { value: 'client_1', source: 'deployment', fixed: true },
        { secretSet: true, source: 'deployment', fixed: true },
      ).state,
    ).toEqual({ kind: 'locked' });
  });

  it('puts a value the last start ignored before a pending change, and a pending change before a missing one', () => {
    expect(
      workos({
        value: 'client_1',
        source: 'home',
        applied: { value: null, pending: true },
      }).state,
    ).toEqual({ kind: 'pending' });
    const ignored = workos(
      {
        value: 'client_1',
        source: 'home',
        applied: { value: null, pending: true },
      },
      {
        secretSet: true,
        source: 'home',
        applied: {
          value: null,
          pending: false,
          ignoredReason: 'secret_unreadable',
        },
      },
    ).state;
    expect(ignored).toMatchObject({
      kind: 'ignored',
      entry: { key: 'WORKOS_API_KEY' },
    });
  });
});
