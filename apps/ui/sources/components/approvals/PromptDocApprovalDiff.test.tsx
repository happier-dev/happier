import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { createPromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { PromptDocApprovalDiff } from './PromptDocApprovalDiff';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
beforeEach(async () => { await loadSyncSingletonForTests(); });
afterEach(async () => {
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  await fixture?.dispose();
  fixture = undefined;
});

describe('PromptDocApprovalDiff', () => {
  it('keeps an unavailable existing comparison base unknown and retries its actual document read', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    let refuseRead = false;
    let readRefused = false;
    let artifactId: string | null = null;
    fixture = await createPlainArtifactHomeFixture('https://prompt-approval-read.test', {
      handleRequest: async (path, init) => {
        if (refuseRead && path === `/v1/artifacts/${artifactId}` && (init?.method ?? 'GET') === 'GET') {
          readRefused = true;
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        return catalog.handle(path, init);
      },
    });
    artifactId = await createPromptDoc({ title: 'Instructions', markdown: 'Accepted previous instructions.' });
    const request = { artifactId, title: 'Instructions', markdown: 'Proposed instructions.', expectedRevision: null };
    const control = await renderScreen(<PromptDocApprovalDiff request={request} serverId={fixture.home.id} />);
    await vi.waitFor(() => expect(control.findAllByType(DiffViewer)[0]?.props.oldText).toBe('Accepted previous instructions.'));
    await control.unmount();

    refuseRead = true;
    const screen = await renderScreen(<PromptDocApprovalDiff request={request} serverId={fixture.home.id} />);
    await vi.waitFor(() => expect(readRefused).toBe(true));
    await vi.waitFor(() => expect(screen.findByTestId('prompt-doc-approval-diff.unavailable')).not.toBeNull());
    expect(screen.findAllByType(DiffViewer)).toHaveLength(0);
    refuseRead = false;
    await act(async () => { screen.findByType(SurfaceStateCard).props.action.onPress(); });
    await vi.waitFor(() => expect(screen.findAllByType(DiffViewer)[0]?.props.oldText).toBe('Accepted previous instructions.'));
    expect(screen.findByType(DiffViewer).props.newText).toBe('Proposed instructions.');
    expect(screen.findByTestId('prompt-doc-approval-diff.unavailable')).toBeNull();
  });

  it('compares a valid empty saved document with the proposal', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    fixture = await createPlainArtifactHomeFixture('https://prompt-approval-empty.test', { handleRequest: catalog.handle });
    const artifactId = await createPromptDoc({ title: 'Empty instructions', markdown: '' });
    const screen = await renderScreen(<PromptDocApprovalDiff serverId={fixture.home.id}
      request={{ artifactId, title: 'Instructions', markdown: 'New instructions.', expectedRevision: null }} />);
    await vi.waitFor(() => expect(screen.findAllByType(DiffViewer)[0]?.props.oldText).toBe(''));
    expect(screen.findByType(DiffViewer).props.newText).toBe('New instructions.');
    expect(screen.findByTestId('prompt-doc-approval-diff.unavailable')).toBeNull();
  });
});
