import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  isAskHappierStatusOfferState,
  startAskHappier,
} from './askHappierEntry';

const boundary = vi.hoisted(() => ({
  push: vi.fn(),
  confirm: vi.fn(async () => true),
  alertAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: boundary.push } }).module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({
    spies: { confirm: boundary.confirm, alertAsync: boundary.alertAsync },
  }).module;
});

let home:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(() => {
  home?.dispose();
  home = undefined;
  resetSessionDraftRepositoryForTests();
  boundary.push.mockReset();
  boundary.confirm.mockReset();
  boundary.alertAsync.mockClear();
});

async function prepareUnavailableGuide() {
  const catalog = createPromptLibraryCatalogBoundary();
  home = await createPlainArtifactHomeFixture(
    'https://ask-happier-entry.test',
    {
      handleRequest: async (path, init) =>
        path === '/v1/artifacts' && init?.method === 'POST'
          ? Response.json({ error: 'unavailable' }, { status: 503 })
          : await catalog.handle(path, init),
    },
  );
  const lifetime = captureActiveServerAccountScopeLifetime();
  if (!lifetime) throw new Error('Expected admitted Account');
  return lifetime;
}

describe('Ask Happier entry owner', () => {
  it('offers the explicit blank bot when the guide cannot be prepared and opens it only on that choice', async () => {
    const lifetime = await prepareUnavailableGuide();
    boundary.confirm.mockResolvedValueOnce(false);
    await startAskHappier({ lifetime });
    expect(boundary.confirm).toHaveBeenCalledTimes(1);
    expect(boundary.push).not.toHaveBeenCalled();

    boundary.confirm.mockResolvedValueOnce(true);
    await startAskHappier({ lifetime });
    expect(boundary.push).toHaveBeenCalledTimes(1);
    const route = boundary.push.mock.calls[0]?.[0] as {
      params: { draftId: string };
    };
    expect(
      readNewSessionDraftFromRepository({
        scope: lifetime.scope,
        draftId: route.params.draftId,
      }),
    ).toMatchObject({
      sessionName: 'Happier',
      initialSessionFacts: { bot: { kind: 'bot' } },
    });
    expect(home!.boundary.list()).toEqual([]);
  });

  it('offers Ask Happier beside a status only when the Session needs the person', () => {
    expect(isAskHappierStatusOfferState('disconnected')).toBe(true);
    expect(isAskHappierStatusOfferState('failed')).toBe(true);
    expect(isAskHappierStatusOfferState('ready')).toBe(false);
    expect(isAskHappierStatusOfferState('thinking')).toBe(false);
  });
});
