import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
afterEach(standardCleanup);

const { DeploymentTreeRow, DeploymentEnvironmentStateMark } =
  await import('./DeploymentEnvironmentRow');

const failed = { tone: 'danger' as const, text: 'Deploy failed' };
const deploying = { tone: null, text: 'Deploying' };

describe('the one Environment row (UI refinements 2026-11-15 08:57Z)', () => {
  it('ends with the shared plugin-ui Status mark while the Environment needs the person, and never a work-status pill or row mark', async () => {
    const screen = await renderScreen(
      <DeploymentTreeRow
        testID="env"
        selected={false}
        onPress={vi.fn()}
        row={{
          kind: 'environment',
          title: 'Staging',
          state: failed,
          fact: 'v1.42',
        }}
      />,
    );
    const end = screen.root.findAll(
      (node) =>
        node.props.testID === 'env:end' && node.props.presentation === 'inline',
    )[0]!;
    expect(end.props).toMatchObject({
      label: 'Deploy failed',
      tone: 'danger',
      presentation: 'inline',
    });
    // The state replaces the quiet fact; it is said once.
    expect(screen.getTextContent()).not.toContain('v1.42');
    expect(
      screen.root.findAll((node) =>
        /WorkStatusRowMark|StatusPill/.test(
          String(typeof node.type === 'string' ? node.type
            : 'displayName' in node.type ? node.type.displayName : node.type.name),
        ),
      ),
    ).toEqual([]);
  });

  it('ends with its one quiet fact when healthy, pulses while a deploy works, and marks a platform Environment as a cloud', async () => {
    const healthy = await renderScreen(
      <DeploymentTreeRow
        testID="env"
        selected={false}
        onPress={vi.fn()}
        row={{
          kind: 'environment',
          title: 'Production',
          titleQualifier: null,
          platform: true,
          state: null,
          fact: 'v1.42',
        }}
      />,
    );
    expect(healthy.getTextContent()).toContain('v1.42');
    expect(
      healthy.root.findAll((node) => node.props.name === 'cloud').length,
    ).toBeGreaterThan(0);
    const working = await renderScreen(
      <DeploymentTreeRow
        testID="env2"
        selected={false}
        onPress={vi.fn()}
        row={{ kind: 'environment', title: 'Production', state: deploying }}
      />,
    );
    expect(
      working.root.findAll(
        (node) =>
          node.props.testID === 'env2:end' && node.props.presentation === 'inline',
      )[0]!.props,
    ).toMatchObject({ label: 'Deploying', pulsing: true });
  });

  it('draws what an Environment runs with the same row: a database ends with its engine', async () => {
    const screen = await renderScreen(
      <DeploymentTreeRow
        testID="db"
        selected={false}
        onPress={vi.fn()}
        child
        row={{ kind: 'database', title: 'billing-db', fact: 'PostgreSQL 16' }}
      />,
    );
    expect(screen.getTextContent()).toContain('PostgreSQL 16');
    expect(
      screen.root.findAll((node) => node.props.name === 'stack').length,
    ).toBeGreaterThan(0);
  });

  it('keeps the shared needs-you row treatment while the Environment needs the person, and drops it while it works or is healthy', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const previous = storage.getState().localSettings;
    storage.getState().applyLocalSettings({ sessionListNeedsYouHighlight: 'accent' });
    try {
      const highlighted = (state: typeof failed | typeof deploying | null) =>
        renderScreen(
          <DeploymentTreeRow testID="env" selected={false} onPress={vi.fn()}
            row={{ kind: 'environment', title: 'Staging', state, fact: 'v1.42' }} />,
        ).then((screen) => screen.findByTestId('env:needs-you:accent') !== null);
      expect(await highlighted(failed)).toBe(true);
      expect(await highlighted(deploying)).toBe(false);
      expect(await highlighted(null)).toBe(false);
    } finally {
      storage.setState({ localSettings: previous });
    }
  });

  it('renders the state mark outside any Collection or plugin surface (a column, an Item row)', async () => {
    const screen = await renderScreen(
      <DeploymentEnvironmentStateMark state={failed} testID="mark" />,
    );
    expect(screen.getTextContent()).toContain('Deploy failed');
  });
});
