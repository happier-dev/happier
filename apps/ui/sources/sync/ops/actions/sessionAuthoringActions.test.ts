import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { storage } from '@/sync/domains/state/storage';
import {
  publishAppliedActiveServerSnapshot,
  publishAppliedActiveServerRuntimeAvailability,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import {
  captureActiveServerAccountScopeLifetime,
  retireActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
  readPresentationNotice,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import { openSessionAuthoringAction, type SessionAuthoringOpenOutcome } from './sessionAuthoringActions';
import { CREATE_PET_SESSION_INTRO_V1, useCreatePetSession } from '@/components/pets/useCreatePetSession';
import { act, renderHook } from '@/dev/testkit';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { createNewSessionComposerDocumentOwner } from '@/components/sessions/composer/newSessionComposerDocumentOwner';
import { NewSessionShellHostProvider, useNewSessionShellHost } from '@/components/sessions/new/navigation/newSessionEntry';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
// Navigation and the Home's HTTP are the boundaries; the Action front door, its persisted policy and the draft owner run for real.
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      router: navigation,
    }).module,
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries({
  ...homes,
  request: createSessionReadBatchFetchBoundary(homes.request),
});
let serverId = '';
beforeEach(async () => {
  await homes.reset();
  serverId = await homes.addHome({
    name: 'Authoring',
    serverUrl: 'https://authoring-presenter.test',
    accountId: 'authoring-account',
    currentAccount: true,
  });
  publishAppliedActiveServerSnapshot({
    serverId,
    serverUrl: 'https://authoring-presenter.test',
    generation: 1,
  });
  storage
    .getState()
    .activateProfileScope({ serverId, accountId: 'authoring-account' });
  navigation.push.mockClear();
  retirePresentationNotice();
});
afterEach(async () => {
  retirePresentationNotice();
  resetSessionDraftRepositoryForTests();
  publishAppliedActiveServerRuntimeAvailability(false);
  await homes.reset();
});

const lifetime = () => {
  const captured = captureActiveServerAccountScopeLifetime();
  if (!captured) throw new Error('Expected the active Account');
  return captured;
};

describe('session.authoring.open: one owner reads and presents the result', () => {
  it('opens Create pet on the full page from a docked host with its intro and Hatch pet skill', async () => {
    storage.getState().applySettingsLocal({ newSessionPresentationModeV1: 'docked' });
    const machine = createMachineFixture({ id: 'pet-machine',
      metadata: createMachineMetadataFixture({ platform: 'win32', homeDir: 'C:\\Users\\pet-maker' }) });
    storage.setState(state => ({ machines: { [machine.id]: machine },
      authoringMemory: { ...state.authoringMemory, recentMachinePaths: [{ machineId: machine.id, path: 'C:\\repo' }] } }));
    const hook = await renderHook(() => ({ create: useCreatePetSession(), shell: useNewSessionShellHost() }), {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(NewSessionShellHostProvider, null, children),
    });
    try {
      expect(hook.getCurrent().shell?.enabled).toBe(true);
      let outcome!: SessionAuthoringOpenOutcome;
      await act(async () => { outcome = await hook.getCurrent().create(); });
      expect(outcome?.kind).toBe('opened');
      if (outcome?.kind !== 'opened') throw new Error(JSON.stringify(outcome));
      const scope = lifetime().scope;
      const draft = readNewSessionDraftFromRepository({ scope, draftId: outcome.draftId });
      expect(draft).toMatchObject({ selectedMachineId: machine.id, selectedPath: 'C:\\Users\\pet-maker',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        capabilitySelection: { skills: { forceIncludeSkillIds: ['happier:hatch-pet'] } } });
      expect(draft?.intro).toEqual(CREATE_PET_SESSION_INTRO_V1);
      const document = createNewSessionComposerDocumentOwner({ scope,
        ref: { kind: 'newSession', instanceId: outcome.draftId } }).read().document;
      expect(document.text).toBe('');
      expect(document.structuredInputMentions).toEqual([]);
      expect(navigation.push).toHaveBeenCalledOnce();
      expect(navigation.push).toHaveBeenCalledWith({ pathname: '/new', params: expect.objectContaining({
        draftId: outcome.draftId, draftServerId: scope.serverId, draftAccountId: scope.accountId,
      }) });
      expect(hook.getCurrent().shell?.visible).toBe(false);
    } finally { await hook.unmount(); }
  });
  it('opens New Session and shows nothing else when the Action is allowed', async () => {
    const outcome = await openSessionAuthoringAction(
      { seed: { prompt: 'Set this up' } },
      lifetime(),
    );
    expect(outcome).toMatchObject({
      kind: 'opened',
      draftId: expect.any(String),
    });
    expect(navigation.push).toHaveBeenCalledOnce();
    expect(readPresentationNotice()).toBeNull();
  });

  it('says why when the person turned the Action off, and opens nothing', async () => {
    await homes.setActionPolicy(
      serverId,
      'session.authoring.open',
      'ui',
      'off',
    );
    const outcome = await openSessionAuthoringAction(
      { seed: { prompt: 'Set this up' } },
      lifetime(),
    );
    expect(outcome).toMatchObject({
      kind: 'refused',
      errorCode: expect.any(String),
    });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toMatchObject({
      severity: 'error',
      message: expect.any(String),
    });
  });

  // A mounted caller's executor reports a created approval request in either published envelope (a receipt, or the
  // approval_required refusal); both read the same way and announce it once, with a way to review it.
  it.each([
    ['receipt', { ok: true as const, result: { kind: 'approval_request_created', actionId: 'session.authoring.open', artifactId: 'approval-1' } }],
    ['refusal', { ok: false as const, errorCode: 'approval_required', error: 'approval_required',
      details: { kind: 'approval_request_created', actionId: 'session.authoring.open', artifactId: 'approval-1' } }],
  ])('announces a waiting approval delivered as a %s', async (_shape, settlement) => {
    const outcome = await openSessionAuthoringAction({ seed: { prompt: 'Set this up' } }, lifetime(),
      { executeAction: async () => settlement });
    expect(outcome).toEqual({ kind: 'approvalPending', artifactId: 'approval-1' });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toMatchObject({ severity: 'info', undo: { label: expect.any(String) } });
  });

  it('stays quiet when the Account it was asked for has gone', async () => {
    const captured = lifetime();
    retireActiveServerAccountScopeLifetime();
    const outcome = await openSessionAuthoringAction(
      { seed: { prompt: 'Set this up' } },
      captured,
    );
    expect(outcome).toMatchObject({ kind: 'stale' });
    expect(readPresentationNotice()).toBeNull();
  });
});
