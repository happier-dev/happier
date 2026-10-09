import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import type { SessionInstructionsSource } from '../useSessionInstructionsSource';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});

afterEach(() => {
  standardCleanup();
  navigation.push.mockClear();
});

const { SessionInstructionsBody, resolveSessionInstructionsAccess } =
  await import('./SessionInstructionsSection');

const ref = {
  kind: 'doc',
  serverId: 'home-a',
  artifactId: 'instructions-doc',
} as const;
const revision = { headerVersion: 2, bodyVersion: 3 };
function source(
  overrides: Partial<SessionInstructionsSource>,
): SessionInstructionsSource {
  return {
    status: 'none',
    document: null,
    stale: false,
    ref: null,
    retry: async () => {},
    ...overrides,
  } as SessionInstructionsSource;
}
function documentOf(markdown: string) {
  return {
    ok: true,
    artifactId: 'instructions-doc',
    title: 'Release captain',
    markdown,
    revision,
  } as unknown as NonNullable<SessionInstructionsSource['document']>;
}

async function render(state: SessionInstructionsSource) {
  const session = createSessionFixture({ id: 'bot', serverId: 'home-a' });
  return renderScreen(
    <SessionInstructionsBody
      session={session}
      serverId="home-a"
      source={state}
    />,
  );
}

describe('Work › Instructions', () => {
  it('renders an attached document in place with its source line, and Edit opens the Prompt Library editor', async () => {
    const screen = await render(
      source({
        status: 'ready',
        ref,
        document: documentOf('You look after releases.'),
      }),
    );
    expect(screen.findByTestId('session-work-instructions.body')).toBeTruthy();
    expect(screen.getTextContent()).toContain('sessionInstructions.source');
    await screen.pressByTestIdAsync('session-work-instructions.edit');
    expect(navigation.push).toHaveBeenCalledWith(
      '/settings/prompts/docs/instructions-doc?serverId=home-a',
    );
  });

  it('keeps the last body while refreshing or unreachable, and never shows it as a failure', async () => {
    const refreshing = await render(
      source({
        status: 'refreshing',
        ref,
        stale: true,
        document: documentOf('Last version'),
      }),
    );
    expect(
      refreshing.findByTestId('session-work-instructions.refreshing'),
    ).toBeTruthy();
    expect(
      refreshing.findByTestId('session-work-instructions.body'),
    ).toBeTruthy();
    standardCleanup();
    const offline = await render(
      source({
        status: 'unavailable',
        ref,
        stale: true,
        document: documentOf('Last version'),
      }),
    );
    expect(
      offline.findByTestId('session-work-instructions.stale'),
    ).toBeTruthy();
    expect(offline.findByTestId('session-work-instructions.body')).toBeTruthy();
  });

  it('distinguishes a valid empty document, no attachment, a deleted document and owner-private instructions', async () => {
    const empty = await render(
      source({ status: 'ready', ref, document: documentOf('  ') }),
    );
    expect(empty.findByTestId('session-work-instructions.empty')).toBeTruthy();
    expect(empty.findByTestId('session-work-instructions.body')).toBeNull();
    standardCleanup();
    const none = await render(source({ status: 'none' }));
    expect(none.findByTestId('session-work-instructions.create')).toBeTruthy();
    standardCleanup();
    const missing = await render(source({ status: 'not_found' }));
    expect(
      missing.findByTestId('session-work-instructions.not_found'),
    ).toBeTruthy();
    expect(
      missing.findByTestId('session-work-instructions.detach'),
    ).toBeTruthy();
    standardCleanup();
    const shared = await render(source({ status: 'owner_private' }));
    expect(
      shared.findByTestId('session-work-instructions.owner_private'),
    ).toBeTruthy();
    expect(shared.findByTestId('session-work-instructions.body')).toBeNull();
    expect(shared.findByTestId('session-work-instructions.edit')).toBeNull();
  });

  it('withholds instructions from a shared viewer before any read', () => {
    expect(
      resolveSessionInstructionsAccess(
        createSessionFixture({ id: 'shared', accessLevel: 'view' }),
      ),
    ).toBe('owner_private');
    expect(resolveSessionInstructionsAccess(null)).toBe('unavailable');
  });
});
