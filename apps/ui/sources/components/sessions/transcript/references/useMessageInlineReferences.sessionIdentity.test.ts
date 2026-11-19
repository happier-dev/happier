import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/dev/testkit/hooks/renderHook';
import {
  createTestSessionTranscriptSource,
  renderHookWithSessionTranscriptSource,
} from '@/dev/testkit/sessionTranscriptSource';
import { storage } from '@/sync/domains/state/storageStore';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveMessageStructuredReferences } from './messageStructuredReferences';
import { useMessageInlineReferences } from './useMessageInlineReferences';

/**
 * An inline `@Session` chip names its target as it is now (live title, Agent mark), from the real
 * store, and renders only when one of its own targets changes.
 */

function renderable(
  id: string,
  metadata: SessionListRenderableSession['metadata'],
): SessionListRenderableSession {
  return {
    id,
    seq: 1,
    createdAt: 1,
    updatedAt: 1_000,
    active: false,
    activeAt: 1,
    metadataVersion: 1,
    agentStateVersion: 1,
    metadata,
    thinking: false,
    thinkingAt: 0,
    presence: 1,
    encryptionMode: 'plain',
  };
}

function seed(rows: Record<string, SessionListRenderableSession>) {
  storage.setState((state) => ({
    ...state,
    sessions: {},
    sessionListRowsByServerId: { 'server-a': rows },
    ordinarySessionListMembershipByServerId: { 'server-a': Object.keys(rows) },
  }));
}

function messageWith(sessionId: string, label: string) {
  const ref = `session:${sessionId}`;
  const token = `[${label}](happier-ref:${ref})`;
  const meta = {
    happierStructuredInputV1: {
      v: 1,
      mentions: [{ kind: 'happier.session', ref, token, label }],
    },
  };
  return {
    ref,
    projection: resolveMessageStructuredReferences({
      text: `see ${token}`,
      meta,
    }),
  };
}

async function render(sessionId: string, label: string) {
  const navigate = vi.fn();
  const { ref, projection } = messageWith(sessionId, label);
  let renders = 0;
  const hook = await renderHookWithSessionTranscriptSource(
    () => {
      renders += 1;
      return useMessageInlineReferences({
        projection,
        pictures: [],
        serverId: 'server-a',
        openPath: () => false,
      });
    },
    { source: createTestSessionTranscriptSource({ navigate }) },
  );
  return { hook, ref, navigate, renders: () => renders };
}

let previousState: ReturnType<typeof storage.getState>;
beforeEach(() => {
  previousState = storage.getState();
});
afterEach(() => {
  storage.setState(previousState);
});

describe('useMessageInlineReferences session identity', () => {
  it('leads with the target Agent and its live title instead of the authored label', async () => {
    seed({
      target: renderable('target', {
        name: 'Renamed relay work',
        path: '/repo',
        flavor: 'codex',
      }),
    });
    const { hook, ref } = await render('target', 'Title at compose time');
    expect(hook.getCurrent().inlineReferences!.resolve(ref)).toMatchObject({
      label: 'Renamed relay work',
      agentId: 'codex',
    });
  });

  it('keeps the authored label and Session glyph for a target this viewer does not hold', async () => {
    seed({});
    const { hook, ref } = await render('unknown', 'Release prep');
    const resolved = hook.getCurrent().inlineReferences!.resolve(ref);
    expect(resolved).toMatchObject({
      label: 'Release prep',
      glyph: 'conversations',
    });
    expect(resolved?.agentId).toBeUndefined();
  });

  it('dims a deleted target and stops opening it', async () => {
    seed({
      gone: renderable('gone', { name: 'Gone', path: '/repo', flavor: 'claude' }),
      kept: renderable('kept', { name: 'Kept', path: '/repo', flavor: 'claude' }),
    });
    storage.getState().deleteSession('gone');
    const live = await render('kept', 'Kept');
    const liveInk = live.hook.getCurrent().inlineReferences!.resolve(live.ref)!.foreground;
    const { hook, ref, navigate } = await render('gone', 'Release prep');
    const resolved = hook.getCurrent().inlineReferences!.resolve(ref)!;
    expect(resolved.label).toBe('Release prep');
    expect(resolved.foreground).not.toBe(liveInk);
    await act(async () => { hook.getCurrent().inlineReferences!.onPress?.(ref); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('follows a rename of its target and ignores churn on other Sessions', async () => {
    seed({
      target: renderable('target', {
        name: 'First',
        path: '/repo',
        flavor: 'codex',
      }),
      other: renderable('other', {
        name: 'Other',
        path: '/repo',
        flavor: 'claude',
      }),
    });
    const { hook, ref, renders } = await render('target', 'First');
    const settled = renders();
    await act(async () => {
      storage.setState((state) => ({
        ...state,
        sessionListRowsByServerId: {
          'server-a': {
            ...state.sessionListRowsByServerId['server-a'],
            other: renderable('other', {
              name: 'Other renamed',
              path: '/repo',
              flavor: 'claude',
            }),
          },
        },
      }));
    });
    expect(renders()).toBe(settled);
    await act(async () => {
      storage.setState((state) => ({
        ...state,
        sessionListRowsByServerId: {
          'server-a': {
            ...state.sessionListRowsByServerId['server-a'],
            target: renderable('target', {
              name: 'Second',
              path: '/repo',
              flavor: 'codex',
            }),
          },
        },
      }));
    });
    expect(hook.getCurrent().inlineReferences!.resolve(ref)?.label).toBe(
      'Second',
    );
  });
});
