// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import type { FindSurfaceRegistration } from '@happier-dev/plugin-ui/components';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { useFindSurfaceRegistrationWithHost } from '@happier-dev/plugin-ui/advanced';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { buildForgeCiLogIndexV1, buildLogIndexV1 } from '../runtime/logs/index.js';
import { createForgeCiMountedViewV1, type LogViewV1, type LogViewStateV1 } from './mountedCiIntent.js';
import { useForgeCiLogViewerV1, useLogViewerV1, type LogViewerModelV1 } from './useForgeCiLogViewer.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mounted CI log viewer data', () => {
  it('supplies the controlled log model in a native host without a plugin surface provider', async () => {
    const log = { logId: 'selected-page', text: 'first\n\u001b[31m🙂 needle\u001b[0m\nlast',
      startLine: 1, startByte: 0, complete: true, continuation: null };
    let index = buildLogIndexV1({ sourceKey: 'native-resource-revision-1', positionBasis: 'page', log });
    // The native physical host owns these controlled presentation inputs, not the shared index/Find logic.
    let state: LogViewStateV1 = { selection: { kind: 'all' }, groupExpanded: {}, revealedLine: null, timestampsVisible: true };
    const listeners = new Set<() => void>();
    const view: LogViewV1 = {
      getSnapshot: () => state,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      invoke(operation) {
        if (operation.kind === 'setSelection') state = { ...state, selection: operation.selection };
        else if (operation.kind === 'setGroupExpanded') state = { ...state, groupExpanded: { ...state.groupExpanded, [operation.groupId]: operation.expanded } };
        else state = { ...state, revealedLine: operation.line };
        for (const listener of listeners) listener();
      },
    };
    let current: LogViewerModelV1 | null = null;
    let registered: FindSurfaceRegistration | null = null;
    let active = true;
    let registrations = 0;
    let disposals = 0;
    const host = { register(value: FindSurfaceRegistration) {
      registered = value; registrations++;
      return () => { if (registered === value) registered = null; disposals++; };
    }, refresh() {} };
    function NativeHost() {
      current = useLogViewerV1({ index, view, active, surfaceId: 'native-log', containsFocus: () => true, isInputFocused: () => false });
      useFindSurfaceRegistrationWithHost(current.findRegistration, host);
      return null;
    }
    function model() { if (!current) throw new Error('Native log model was not mounted'); return current; }
    function registration() { if (!registered) throw new Error('Native Find was not registered'); return registered; }
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<NativeHost />); });
      expect(model().lines.map(line => line.plainText)).toEqual(['first', '🙂 needle', 'last']);
      expect(model().index.positionBasis).toBe('page');
      expect(model().index.complete).toBe(false);
      expect(model().index.hasCompletePrefix).toBe(false);
      await act(async () => { view.invoke({ kind: 'setSelection', selection: { kind: 'excerpt', startLine: 3, endLine: 3 } }); });
      expect(model().lines).toEqual([index.lines[2]]);
      await act(async () => { registration().open(); registration().controller.setQuery('needle'); });
      expect(model().findSnapshot.status).toEqual({ kind: 'results', current: 1, total: 1, coverage: 'loaded' });
      expect(state.selection).toEqual({ kind: 'excerpt', startLine: 2, endLine: 3 });
      expect(state.revealedLine).toBe(2);
      expect(model().getLineRanges(index.lines[1]!.id)).toEqual([{ start: 3, end: 9, current: true }]);
      const heldIndex = model().index;
      await act(async () => { view.invoke({ kind: 'setSelection', selection: { kind: 'tail', lines: 1 } }); });
      expect(model().lines).toEqual([index.lines[2]]);
      await act(async () => { registration().controller.setQuery('first'); });
      expect(state.selection).toEqual({ kind: 'tail', lines: 3 });
      expect(model().index).toBe(heldIndex);
      const previousLine = index.lines[0]!;
      index = buildLogIndexV1({ sourceKey: 'native-resource-revision-2', positionBasis: 'page', log, baseline: index });
      await act(async () => { root.render(<NativeHost />); });
      expect(model().findSnapshot.status).toEqual({ kind: 'idle' });
      expect(model().index.lines[0]!.id).not.toBe(previousLine.id);
      expect(model().getLineRanges(previousLine.id)).toEqual([]);
      active = false;
      await act(async () => { root.render(<NativeHost />); });
      expect(registered).toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
    }
    expect(disposals).toBe(registrations);
  });

  it('joins the public host Find boundary, shares mounted timestamps, and disposes registration and temporary folds', async () => {
    const job = createForgeCiConformanceVectorsV1().github.job;
    const index = buildForgeCiLogIndexV1({ log: { kind: 'available', job: job.ref, logId: 'public-log',
      text: '##[group]Tests\nfailed test\n##[endgroup]', startLine: 80, startByte: 0, complete: true, continuation: null } });
    const view = createForgeCiMountedViewV1({ mountId: 'public-ci', phone: false });
    await view.invoke({ mountId: view.mountId, operation: { kind: 'selectAttempt', selection: job.ref.selection } });
    await view.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job: job.ref } });
    let registered: FindSurfaceRegistration | null = null;
    let registrations = 0;
    let disposals = 0;
    let current: ReturnType<typeof useForgeCiLogViewerV1> | null = null;
    const revealed: number[] = [];
    let restoredFocus = 0;
    const surface = defineUiSurface(() => {
      current = useForgeCiLogViewerV1({ index, view, surfaceId: 'job-log', containsFocus: () => true,
        isInputFocused: () => false, onRevealLine: line => revealed.push(line.number),
        onCloseFind: () => { restoredFocus++; } });
      return <Text value={String(current.timestampsVisible)} />;
    });
    function controller() {
      if (!registered) throw new Error('Find surface was not registered');
      return registered.controller;
    }
    function openFind() {
      if (!registered) throw new Error('Find surface was not registered');
      registered.open();
    }
    function model() {
      if (!current) throw new Error('Log viewer was not mounted');
      return current;
    }
    let page!: PluginUiTestkit;
    await act(async () => { page = await createPluginUiTestkit({
      identity: { instanceId: 'ci-log', mountNonce: 'ci-log-mount' },
      authorPlugin: { id: 'happier.example.ci', version: '0.0.0' }, surface,
      surfaceContext: createSurfaceContextFixture(), launchInput: null,
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ strictMode: true, find: {
        register(value) {
          registered = value;
          registrations++;
          return () => { if (registered === value) registered = null; disposals++; };
        },
        refresh() {},
      } }),
    }); });
    try {
      expect(model().findRegistered).toBe(true);
      await act(async () => {
        openFind();
        controller().setQuery('failed');
      });
      expect(model().findSnapshot.isOpen).toBe(true);
      expect(controller().status).toEqual({ kind: 'results', current: 1, total: 1, coverage: 'loaded' });
      expect(revealed).toEqual([81]);
      expect(view.getSnapshot()?.groupExpanded[index.groups[0]!.id]).toBe(true);
      const held = model().findSnapshot.matches;
      await act(async () => {
        await view.invoke({ mountId: view.mountId, operation: { kind: 'setTimestampsVisible', visible: false } });
      });
      expect(model().timestampsVisible).toBe(false);
      expect(model().findSnapshot.matches).toBe(held);
      expect(model().index).toBe(index);
      await act(async () => {
        await view.invoke({ mountId: view.mountId, operation: { kind: 'setTailLines', lines: 1 } });
      });
      expect(model()).toHaveProperty('lines', [index.lines.at(-1)]);
      expect(model().index).toBe(index);
      expect(model().findSnapshot.matches).toBe(held);
      await act(async () => { controller().close(); });
      expect(restoredFocus).toBe(1);
      expect(view.getSnapshot()?.groupExpanded[index.groups[0]!.id]).toBe(false);
      await act(async () => { openFind(); controller().setQuery('failed'); });
      await act(async () => { view.openSummary(); });
      expect(model().available).toBe(false);
    } finally {
      await act(async () => { await page.dispose(); });
    }
    expect(registered).toBeNull();
    expect(disposals).toBe(registrations);
    expect(view.getSnapshot()?.groupExpanded[index.groups[0]!.id]).toBe(false);
    expect(restoredFocus).toBe(1);
  });
});
