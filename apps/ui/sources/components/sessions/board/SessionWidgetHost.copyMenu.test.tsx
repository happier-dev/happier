import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionSurfaceNoteDocumentV1,
  SessionSurfaceItemV1Schema,
  type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import type { SessionBoardItemProjection } from '@/sync/domains/session/board';

import {
  SessionWidgetHost,
  type SessionWidgetHostProps,
} from './SessionWidgetHost';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-gesture-handler', async () => {
  const { createGestureHandlerMock } =
    await import('@/dev/testkit/mocks/gestureHandler');
  return createGestureHandlerMock();
});

/**
 * The copies a visual offers from its ⋯ menu. Every visual, typed or HTML, becomes a widget through
 * one entry; a second "Add to…" that opens the same panel from another host is a duplicate.
 */

function itemOf(
  source: SessionSurfaceItemV1['source'],
): SessionBoardItemProjection {
  return {
    itemId: 'visual-1',
    revision: 'rev-1',
    state: {
      kind: 'ready',
      item: SessionSurfaceItemV1Schema.parse({
        v: 1,
        title: 'Build time by package',
        frame: 'frameless',
        height: { mode: 'auto', fallback: 'regular' },
        source,
      }),
    },
  };
}

async function menuIds(
  item: SessionBoardItemProjection,
): Promise<readonly string[]> {
  const props = {
    sessionId: 'session-1',
    serverId: 'home-1',
    item,
    host: 'inlineTranscript',
    density: 'compact',
    frame: 'reply',
    canEdit: false,
    testID: 'widget',
  } satisfies SessionWidgetHostProps;
  const screen = await renderScreen(<SessionWidgetHost {...props} />);
  const owners = screen.root.findAll(
    (node) =>
      Array.isArray((node.props as { actions?: unknown }).actions) &&
      (node.props as { overflowTriggerTestID?: string })
        .overflowTriggerTestID === 'widget-actions',
  );
  const actions =
    (
      owners.at(-1)?.props as
        | { actions: ReadonlyArray<{ id: string }> }
        | undefined
    )?.actions ?? [];
  return actions.map((action) => action.id);
}

describe('a visual’s copies in its ⋯ menu', () => {
  beforeEach(() => {
    storage.setState({ profileScope: { serverId: 'home-1', accountId: 'account-1' } });
  });
  afterEach(() => { standardCleanup(); storage.setState({ profileScope: null }); });
  it('offers native builtin promotion and sharing alongside reading', async () => {
    const ids = await menuIds(itemOf({ kind: 'widget', instance: { v: 1, id: 'visual-1',
      definition: { kind: 'builtin', id: 'usage_daily' }, bindings: {} } }));
    expect(ids).toContain('saveAsYours');
    expect(ids).toContain('shareVisual');
    expect(ids).toContain('addTo');
    expect(ids).toContain('about');
  });
  it('makes a typed visual a widget through one entry', async () => {
    const ids = await menuIds(
      itemOf({
        kind: 'declarative',
        document: createSessionSurfaceNoteDocumentV1('Body'),
      }),
    );
    expect(
      ids.filter((id) => id === 'saveAsYours' || id === 'addVisualTo'),
    ).toEqual(['saveAsYours']);
    expect(ids).toContain('shareVisual');
  });

  it('makes an HTML visual a widget through the same entry, beside Save as Artifact and Share', async () => {
    const html = artifactHtmlBundleFromBodyV1('<b>hi</b>');
    const ids = await menuIds(
      itemOf({
        kind: 'hostedHtml',
        source: html,
      }),
    );
    expect(
      ids.filter((id) => id === 'saveAsYours' || id === 'addVisualTo'),
    ).toEqual(['saveAsYours']);
    expect(ids).toEqual(
      expect.arrayContaining(['saveArtifact', 'shareVisual']),
    );
  });

  it('copies any ready visual into another Session at its exact revision, and never one without a revision', async () => {
    const note = itemOf({ kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Body') });
    expect(await menuIds(note)).toContain('copyToSession');
    expect(await menuIds({ ...note, revision: null })).not.toContain('copyToSession');
  });
});

