import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { RequesterCodeCard } from './RequesterCodeCard';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(standardCleanup);

const LINK = 'happier://pair?v=2&code=approve-from-a-device';

describe('RequesterCodeCard', () => {
  it('mounts the focal frame while the requester is generating and keeps it when the code arrives', async () => {
    const screen = await renderScreen(
      <RequesterCodeCard link={null} qrAvailable={false} expiresAtMs={null} approved={false} />,
    );
    const frame = screen.findHostByTestId('restore-requester-qr-pending');
    expect(frame).toBeTruthy();
    expect(screen.findHostByTestId('restore-requester-qr')).toBeNull();
    const pill = screen.findHostByTestId('restore-requester-status');
    expect(pill).toBeTruthy();

    await act(async () => screen.update(
      <RequesterCodeCard link={LINK} qrAvailable expiresAtMs={Date.now() + 290_000} approved={false} />,
    ));
    expect(screen.findHostByTestId('restore-requester-qr')).toBe(frame);
    expect(screen.findHostByTestId('restore-requester-status')).toBe(pill);
  });

  // M4: approval keeps the code where it was under a check, and the one status line says so in place.
  it('keeps the shown code under a check and turns the wait into Approved in the same status line', async () => {
    const screen = await renderScreen(
      <RequesterCodeCard
        link={LINK}
        qrAvailable
        expiresAtMs={Date.now() + 290_000}
        approved={false}
      />,
    );
    expect(screen.findHostByTestId('restore-requester-countdown')).toBeTruthy();
    expect(screen.findHostByTestId('restore-requester-approved-check')).toBeFalsy();

    await act(async () => screen.update(
      <RequesterCodeCard link={LINK} qrAvailable expiresAtMs={null} approved />,
    ));

    expect(screen.findHostByTestId('restore-requester-qr')).toBeTruthy();
    expect(
      screen.findHostByTestId('restore-requester-approved-check'),
    ).toBeTruthy();
    expect(screen.findHostByTestId('restore-requester-approved')).toBeTruthy();
    expect(screen.findHostByTestId('restore-requester-countdown')).toBeFalsy();
    expect(screen.findAllHostsByTestId('restore-requester-status')).toHaveLength(1);
  });
});
