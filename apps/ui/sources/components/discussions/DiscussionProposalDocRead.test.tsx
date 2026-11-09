import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import type { AdmittedDocRead } from '@/components/artifacts/ArtifactEditProposal';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { DiscussionProposalDocRead } from './DiscussionProposalDocRead';

afterEach(() => standardCleanup());

const scope = { serverId: 'home', accountId: 'alice' };
const ready = (bodyVersion: number) => ({
  ok: true as const,
  result: {
    ref: { kind: 'doc' as const, serverId: 'home', artifactId: 'runbook' },
    openCommentCount: 1,
    artifact: {
      artifactId: 'runbook',
      ownerAccountId: 'alice',
      access: 'owner' as const,
      publicAudience: 'none' as const,
      header: { title: 'Runbook' },
      seq: bodyVersion,
      createdAt: 1,
      updatedAt: bodyVersion,
      body: 'Current text.',
      revision: { headerVersion: 1, bodyVersion },
    },
  },
});

describe('DiscussionProposalDocRead', () => {
  it('keeps the last admitted Doc read while an unrelated Discussion append revalidates it', async () => {
    const pending = createDeferred<ReturnType<typeof ready>>();
    let reads = 0;
    const execute = vi.fn(async (actionId: string) => {
      if (actionId !== 'doc.read') throw new Error(`Unexpected action ${actionId}`);
      reads += 1;
      return reads === 1 ? ready(4) : pending.promise;
    });
    const client = createArtifactActionsClient(scope, execute as never);
    const observations: AdmittedDocRead[] = [];
    const binding: ServerCredentialAccountScopeBinding = {
      ...scope,
      scope,
      revision: 1,
      isCurrent: () => true,
      onRetire: () => ({ dispose: () => undefined }),
    };

    await renderScreen(
      <DiscussionProposalDocRead
        artifactId="runbook"
        client={client}
        accountLifetime={binding}
        onRead={(_artifactId, _client, read) => {
          if (read) observations.push(read);
        }}
      />,
    );
    await vi.waitFor(() =>
      expect(observations.at(-1)?.status).toBe('ready'),
    );

    // The Home publication caused by appending a thread message can conservatively wake readers.
    // The admitted revision remains the proposal's basis until that revalidation settles.
    await act(async () => {
      publishHomeAccountChange('home');
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await flushHookEffects();
    expect(observations.at(-1)).toMatchObject({
      status: 'ready',
      value: { artifact: { revision: { bodyVersion: 4 } } },
    });

    await act(async () => pending.resolve(ready(5)));
    await vi.waitFor(() =>
      expect(observations.at(-1)).toMatchObject({
        status: 'ready',
        value: { artifact: { revision: { bodyVersion: 5 } } },
      }),
    );
  });
});
