import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  return createExpoRouterMock().module;
});

const { storage } = await import('@/sync/domains/state/storageStore');
const { DocThreadsSpecimen } = await import('./DocThreadsSpecimen');

afterEach(() => standardCleanup());

describe('DocThreadsSpecimen', () => {
  it('draws each margin state through the real thread card and leaves no seeded Session behind', async () => {
    const screen = await renderScreen(<DocThreadsSpecimen />);
    await flushHookEffects();
    const card = (id: string) => `artifact:passage-thread:dev-doc-${id}`;
    // Each frame reaches the state it is named for in the owner, not a copied layout.
    expect(
      screen.findByTestId(`${card('open')}.proposal.accept`),
    ).not.toBeNull();
    expect(
      screen.findByTestId(`${card('conflict')}.proposal.movedOn`),
    ).not.toBeNull();
    expect(
      screen.findByTestId(`${card('readonly')}.proposal.cantEdit`),
    ).not.toBeNull();
    expect(
      screen.findByTestId(`${card('accepted')}.proposal.undo`),
    ).not.toBeNull();
    expect(
      screen.findByTestId(`${card('declined')}.proposal.declined`),
    ).not.toBeNull();
    expect(screen.findByTestId(`${card('changed')}.detached`)).not.toBeNull();
    expect(screen.findByTestId(`${card('reply')}.reply`)).not.toBeNull();
    expect(screen.findByTestId('artifact:comments.loading')).not.toBeNull();
    const seeded = () =>
      Object.values(storage.getState().sessionListRowsByServerId).some(
        (rows) => rows && 'dev-doc-threads-agent' in rows,
      );
    expect(seeded()).toBe(true);
    await screen.unmount();
    expect(seeded()).toBe(false);
  });
});
