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
const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');

describe("a column row's trailing status (UI refinements 2026-11-16, revised 2026-11-18 10:40Z)", () => {
  const row = (status: React.ReactNode) => (
    <CollectionNavigationRow testID="row" title="grant-u4-147-withdrawal" status={status} selected={false} onPress={() => {}} />
  );
  const endOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root.findAll(
    (node) => node.props.testID === 'row:end' && typeof node.type === 'string',
  )[0];

  it("says an attention state with its dot and words in the row's end ('● Deploy failed', as the lab draws)", async () => {
    const screen = await renderScreen(row(<InlineStatus testID="row:end" tone="danger" label="Deploy failed" />));
    expect(screen.getTextContent()).toContain('grant-u4-147-withdrawal');
    expect(screen.getTextContent()).toContain('Deploy failed');
  });

  it("keeps a neutral state to its dot, its words the accessible name, so the name takes the rest", async () => {
    const screen = await renderScreen(row(<InlineStatus testID="row:end" tone="muted" label="Deployed" />));
    expect(screen.getTextContent()).toContain('grant-u4-147-withdrawal');
    expect(screen.getTextContent()).not.toContain('Deployed');
    const end = endOf(screen);
    expect(end?.props['aria-label'] ?? end?.props.accessibilityLabel).toBe('Deployed');
  });

  it("keeps a page-surface column row's description to one line (LABPARITY-ACCEPT-B fix 4: Environments rail wrapped to three)", async () => {
    const line = 'NLDW3-5-36-33 · eadc · Compose · ff91a03 deployed by you 4 days ago with a long commit subject';
    const screen = await renderScreen(
      <ListPresentationProvider value="page">
        <CollectionNavigationRow testID="rail" surface="page" title="grant-u4-150-withdrawal" subtitle={line} selected={false} onPress={() => {}} />
      </ListPresentationProvider>,
    );
    const texts = screen.root.findAll((node) => typeof node.type === 'string' && node.props.children === line);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((node) => node.props.numberOfLines === 1)).toBe(true);
  });

  // UI refinements ruling 2026-11-19 (O-DEPLOY ASK 08:18Z, Services column at 300 px): a state that needs the person is
  // the reason to look at the row, so the count gives way to it; the name and the disclosure keep their places.
  it('gives the count way to a state that needs the person, and keeps it beside a quiet state', async () => {
    const counted = (props: Readonly<{ needsYou: boolean; status: React.ReactNode }>) => (
      <CollectionNavigationRow testID="row" title="W1-OWNSERVER-FLEET" status={props.status} needsYou={props.needsYou}
        count={2} disclosure={{ expanded: false, onToggle: () => {} }} selected={false} onPress={() => {}} />
    );
    const failing = await renderScreen(counted({ needsYou: true, status: <InlineStatus testID="row:end" tone="danger" label="Failed" /> }));
    expect(failing.getTextContent()).toContain('Failed');
    expect(failing.getTextContent()).not.toMatch(/(^|\D)2(\D|$)/);
    expect(failing.findByTestId('row:disclosure')).toBeTruthy();
    await failing.unmount();

    const quiet = await renderScreen(counted({ needsYou: false, status: <InlineStatus testID="row:end" tone="muted" label="Deployed" /> }));
    expect(quiet.getTextContent()).toMatch(/(^|\D)2(\D|$)/);
    expect(quiet.findByTestId('row:disclosure')).toBeTruthy();
  });

  it("keeps the words where a status stands on its own, outside a row's end", async () => {
    const screen = await renderScreen(
      <InlineStatus tone="danger" label="Deploy failed" />,
    );
    expect(screen.getTextContent()).toContain('Deploy failed');
  });
});
