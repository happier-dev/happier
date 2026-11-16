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
afterEach(standardCleanup);

const { CollectionNavigationRow } = await import('./CollectionList');
const { InlineStatus } = await import('@/components/ui/status/InlineStatus');

describe("a column row's trailing status (UI refinements 2026-11-16: the name tells rows apart)", () => {
  it("draws only the status dot in the row's end, keeping its words as the accessible name, so the name takes the rest", async () => {
    const screen = await renderScreen(
      <CollectionNavigationRow
        testID="row"
        title="grant-u4-147-withdrawal"
        status={
          <InlineStatus
            testID="row:end"
            tone="warning"
            label="Running, not verified"
          />
        }
        selected={false}
        onPress={() => {}}
      />,
    );
    expect(screen.getTextContent()).toContain('grant-u4-147-withdrawal');
    expect(screen.getTextContent()).not.toContain('Running, not verified');
    const end = screen.root.findAll(
      (node) =>
        node.props.testID === 'row:end' && typeof node.type === 'string',
    )[0];
    expect(end?.props['aria-label'] ?? end?.props.accessibilityLabel).toBe(
      'Running, not verified',
    );
  });

  it("keeps the words where a status stands on its own, outside a row's end", async () => {
    const screen = await renderScreen(
      <InlineStatus tone="danger" label="Deploy failed" />,
    );
    expect(screen.getTextContent()).toContain('Deploy failed');
  });
});
