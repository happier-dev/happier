import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { ActionSettingsTargetModeControl } from '@/components/settings/actions/ActionSettingsTargetModeControl';
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
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
const originalState = storage.getState();

afterEach(() => {
  standardCleanup();
  navigation.push.mockClear();
  storage.setState(originalState, true);
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

async function render(state: SessionInstructionsSource, serverId = 'home-a') {
  const session = createSessionFixture({ id: 'bot', serverId });
  return renderScreen(
    <SessionInstructionsBody
      session={session}
      serverId={serverId}
      source={state}
    />,
  );
}

describe('Work › Instructions', () => {
  it('admits the exact Agent edits mode and preserves current neighboring Account policies', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ actionsSettingsV1: { v: 1, actions: {} } }));
    try {
      const screen = await render(source({ status: 'ready', ref, document: documentOf('Current instructions') }), account.scope.serverId);
      const control = screen.findAllByType(ActionSettingsTargetModeControl)[0];
      if (!control) throw new Error('Agent edits control missing');
      const select = control.props.onChange;
      act(() => account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1, actions: {
        'prompt_doc.create': { disabledSurfaces: ['mcp'] },
        'prompt_doc.update': { disabledSurfaces: ['cli'] },
      } } })));
      await act(async () => { select('allowed'); });
      await vi.waitFor(() => expect(account.persistedSettings.actionsSettingsV1.actions['prompt_doc.update']?.approvalWaivedSurfaces).toContain('agent'));
      expect(account.persistedSettings.actionsSettingsV1.actions['prompt_doc.create']?.disabledSurfaces).toEqual(['mcp']);
      expect(account.persistedSettings.actionsSettingsV1.actions['prompt_doc.update']?.disabledSurfaces).toEqual(['cli']);
    } finally { standardCleanup(); await account.dispose(); }
  });

  it('does not bypass disabled settings.set when changing Agent edits', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ actionsSettingsV1: { v: 1, actions: {
      'settings.set': { disabledSurfaces: ['ui'] },
    } } }));
    try {
      const screen = await render(source({ status: 'ready', ref, document: documentOf('Current instructions') }), account.scope.serverId);
      const control = screen.findAllByType(ActionSettingsTargetModeControl)[0];
      if (!control) throw new Error('Agent edits control missing');
      await act(async () => { control.props.onChange('allowed'); });
      expect(account.settings.actionsSettingsV1.actions['prompt_doc.update']?.approvalWaivedSurfaces).not.toContain('agent');
      expect(account.writes).toEqual([]);
    } finally { standardCleanup(); await account.dispose(); }
  });

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

  it('offers Detach for a healthy attachment without hiding the document', async () => {
    const screen = await render(source({ status: 'ready', ref, document: documentOf('Current instructions') }));
    expect(screen.findByTestId('session-work-instructions.detach')).toBeTruthy();
    await screen.pressByTestIdAsync('session-work-instructions.detach');
    expect(screen.findByTestId('session-work-instructions.body')).toBeTruthy();
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
