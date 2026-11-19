// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { preflightTriageRouteLensV1, TRIAGE_ROUTE_DEFAULT_LENS_V1 } from '../navigation/location.js';
import { PluginError } from '@happier-dev/plugin-sdk';
import { TriageTaskOrigin, TriageTaskOriginLink } from './taskOrigin.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

it('opens the persisted Review backlink without reading finding bodies', async () => {
  const entryRef = testkitEntryRef({ kindId: 'issue', entryId: 'review-task' });
  const originReview = { reviewId: 'review-1', findingIds: ['finding-1', 'finding-2'] };
  const reads: string[] = [];
  const opens: unknown[] = [];
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'persisted-review-origin', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => {
      const [unrelated, setUnrelated] = React.useState(0);
      return <><TriageTaskOrigin entryRef={{ ...entryRef }} />
        <Button title={`Unrelated ${unrelated}`} onPress={() => setUnrelated(value => value + 1)} /></>;
    }),
    surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: {
      executeAction: ({ action, input }) => {
        reads.push(action);
        expect(input).toEqual({ v: 1, entryRef });
        if (action === 'tasks/read-origin-error-v1') return { v: 1, originError: null };
        expect(action).toBe('tasks/read-origin-review-v1');
        return { v: 1, originReview };
      },
      openResource: ({ resource }) => { opens.push(resource); },
    },
  });
  mounted.push(fixture);
  await fixture.findByRole('button', { name: 'Review' });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Unrelated 0' })); });
  expect(reads.sort()).toEqual(['tasks/read-origin-error-v1', 'tasks/read-origin-review-v1']);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Review' })); });
  expect(opens).toEqual([{ kind: 'artifact', artifactId: 'review-1' }]);
});

it('reads the persisted origin once per open or explicit refresh and opens the complete error reference', async () => {
  const entryRef = testkitEntryRef({ kindId: 'issue', entryId: 'created-issue' });
  const originError = { entryRef: testkitEntryRef({ kindId: 'error-issue', collisionScope: 'production', entryId: 'checkout-error' }),
    display: { title: 'Checkout fails after payment', scopeLabel: 'Production' } };
  const reads: unknown[] = [];
  const opens: unknown[] = [];
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'persisted-error-origin', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => {
      const [refresh, setRefresh] = React.useState(0);
      const [unrelated, setUnrelated] = React.useState(0);
      return <><TriageTaskOrigin entryRef={{ ...entryRef }} refreshGeneration={refresh} />
        <Button title={`Unrelated ${unrelated}`} onPress={() => setUnrelated(value => value + 1)} />
        <Button title="Refresh task" onPress={() => setRefresh(value => value + 1)} /></>;
    }),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: {
      executeAction: ({ action, input }) => {
        if (action === 'tasks/read-origin-review-v1') return { v: 1, originReview: null };
        expect(action).toBe('tasks/read-origin-error-v1'); reads.push(input); return { v: 1, originError };
      },
      openSurface: request => { opens.push(request); },
    },
  });
  mounted.push(fixture);
  const label = 'From error: Checkout fails after payment';
  await fixture.getByRole('button', { name: label });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Unrelated 0' })); });
  expect(reads).toEqual([{ v: 1, entryRef }]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh task' })); });
  expect(reads).toEqual([{ v: 1, entryRef }, { v: 1, entryRef }]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: label })); });
  const route = preflightTriageRouteLensV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: originError.entryRef });
  expect(route.kind).toBe('accepted');
  expect(opens).toMatchObject([{ view: { pluginId: 'happier.triage', localId: 'triage' },
    ...(route.kind === 'accepted' ? { subPath: route.subPath } : {}) }]);
});


it('presents the linked origin navigation Code and Request ID without exposing raw details', async () => {
  const received: unknown[] = [];
  const notifications: string[] = [];
  const error = new PluginError({ code: 'destination_unavailable', details: { requestId: 'origin-open-17', private: 'never display' } });
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'origin-navigation-failure', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => <TriageTaskOriginLink origin={{ entryRef: testkitEntryRef(), display: { title: 'Error', scopeLabel: 'Production' } }} />),
    surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { openSurface: async () => { throw error; },
      presentActionFailure: async ({ failure }) => { received.push(failure); return { reason: 'Cannot open', nextStep: 'Try again', technicalDetails: [
        { key: 'code', label: 'Code', value: failure.errorCode },
        { key: 'requestId', label: 'Request ID', value: failure.requestId! },
      ] }; }, notify: async ({ message }) => { notifications.push(message); } },
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'From error: Error' })); });
  await vi.waitFor(() => expect(notifications.join(' ')).toContain('origin-open-17'));
  expect(received).toEqual([expect.objectContaining({ errorCode: 'destination_unavailable', requestId: 'origin-open-17' })]);
  expect(notifications.join(' ')).toContain('destination_unavailable');
  expect(notifications.join(' ')).toContain('origin-open-17');
  expect(notifications.join(' ')).not.toContain('never display');
});


it('presents a failed origin relationship read once and keeps its existing retry available', async () => {
  const received: unknown[] = [];
  const notifications: string[] = [];
  let reads = 0;
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'origin-relationship-failure', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => <TriageTaskOrigin entryRef={testkitEntryRef()} />),
    surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { executeAction: async ({ action }) => { if (action === 'tasks/read-origin-review-v1') return { v: 1, originReview: null };
        reads += 1; if (reads === 1) throw new PluginError({ code: 'origin_read_unavailable',
        details: { requestId: 'origin-read-17' } }); return { v: 1, originError: null }; },
      presentActionFailure: async ({ failure }) => { received.push(failure); return { reason: 'Cannot read', nextStep: 'Try again', technicalDetails: [
        { key: 'code', label: 'Code', value: failure.errorCode },
        { key: 'requestId', label: 'Request ID', value: failure.requestId! },
      ] }; }, notify: async ({ message }) => { notifications.push(message); } },
  });
  mounted.push(fixture);
  await fixture.findByRole('button', { name: 'Retry origin link' });
  expect(received).toEqual([expect.objectContaining({ errorCode: 'origin_read_unavailable', requestId: 'origin-read-17' })]);
  await vi.waitFor(() => expect(notifications.join(' ')).toContain('origin-read-17'));
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Retry origin link' })); });
  expect(reads).toBe(2);
  expect(received).toHaveLength(1);
});

it('keeps a superseded origin relationship read quiet', async () => {
  let failRead!: (error: unknown) => void;
  const held = new Promise<never>((_resolve, reject) => { failRead = reject; });
  const received: unknown[] = [];
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'origin-relationship-cancel', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => {
      const [shown, setShown] = React.useState(true);
      return <>{shown ? <TriageTaskOrigin entryRef={testkitEntryRef()} /> : null}<Button title="Close task" onPress={() => setShown(false)} /></>;
    }), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { executeAction: () => held, presentActionFailure: async ({ failure }) => { received.push(failure);
      return { reason: 'Cannot read', nextStep: 'Try again', technicalDetails: [] }; } },
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Close task' })); });
  await act(async () => { failRead(new PluginError({ code: 'origin_read_unavailable', details: { requestId: 'old-read' } })); });
  expect(received).toEqual([]);
});
