import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { SessionBoardAuthoredItemUpsertInputV1Schema } from '../sessions/board/actions.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '../sessions/board/item.js';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const visual: SessionSurfaceItemV1 = SessionSurfaceItemV1Schema.parse({
  v: 1, destination: 'board', title: 'QA Board visual', frame: 'frameless',
  height: { mode: 'auto', fallback: 'regular' },
  source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: '# REVISION ONE' } } },
});
const copyInput = {
  sessionId: 'destination', itemId: 'independent-copy', expectedItemRevision: null,
  destination: 'board', placement: { tabId: 'overview', tabTitle: 'Overview' },
  copySource: { serverId: 'home', sessionId: 'source', itemId: 'visual', expectedItemRevision: revision },
} as const;

/** Only the sealed record transport and native confirmation cross process/UI boundaries. */
function copyExecutor(sourceItem = visual) {
  const saved: SessionSurfaceItemV1[] = [];
  const confirmations: unknown[] = [];
  let sourceReads = 0;
  const executor = createActionExecutor({
    readAgentHtmlNetworkPolicy: async () => 'off',
    presentUserActionConfirmation: async ({ input }) => { confirmations.push(input); return true; },
    sessionBoardAction: async ({ actionId, input }) => {
      if (actionId === 'session.board.get') {
        sourceReads++;
        return { v: 1, serverId: 'home', sessionId: 'source',
          capabilities: { readTranscript: true, editSessionRecords: false }, layout: null,
          items: [{ itemId: 'visual', revision, title: sourceItem.title, sourceKind: sourceItem.source.kind, item: sourceItem }],
          incomplete: false, page: { cursor: null, hasNext: false } };
      }
      const request = SessionBoardAuthoredItemUpsertInputV1Schema.parse(input);
      const stored = SessionSurfaceItemV1Schema.parse(request.item);
      saved.push(stored);
      return { v: 1, serverId: 'home', sessionId: request.sessionId,
        result: { operation: 'upsert_item', itemId: request.itemId, outcome: 'created', itemRevision: revision, layoutRevision: revision },
        destination: { tabId: 'overview', width: 'medium' },
        itemDestination: stored.destination, preview: { title: stored.title, sourceKind: stored.source.kind } };
    },
  });
  return { executor, saved, confirmations, sourceReads: () => sourceReads };
}

describe('Session visual copy through the Action', () => {
  it('refuses caller-authored materialization of a copy before confirmation or storage', async () => {
    const { executor, saved, confirmations } = copyExecutor();
    expect(await executor.execute('session.board.item.upsert', { ...copyInput, item: visual }, {
      surface: 'ui', authority: 'present_user', serverId: 'home', defaultSessionId: 'destination',
    })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(saved).toEqual([]);
    expect(confirmations).toEqual([]);
  });
  it.each(['ui', 'agent', 'mcp'] as const)('copies the observed revision into an empty destination through %s', async surface => {
    const { executor, saved, sourceReads } = copyExecutor();
    const result = await executor.execute('session.board.item.upsert', copyInput, {
      surface, serverId: 'home', defaultSessionId: surface === 'ui' ? 'destination' : 'source',
      ...(surface === 'ui' ? { authority: 'present_user' as const } : {}),
      ...(surface === 'ui' ? {} : { ...(surface === 'mcp' ? { sessionListAccess: 'current_session' as const } : {}),
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'session.board.item.upsert': [surface] } }) }),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { sessionId: 'destination', result: { itemId: 'independent-copy' } } });
    expect(saved).toEqual([visual]);
    expect(sourceReads()).toBe(1);
  });

  it('confirms the retained source network and origins, even when new HTML creation is off', async () => {
    const htmlVisual = SessionSurfaceItemV1Schema.parse({ ...visual, source: { kind: 'hostedHtml',
      source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGI+aGk8L2I+' } } },
      requestedCapabilities: { networkOrigins: ['https://api.example.com', 'https://cdn.example.com'] },
    } });
    const { executor, saved, confirmations } = copyExecutor(htmlVisual);
    const result = await executor.execute('session.board.item.upsert', copyInput, {
      surface: 'ui', authority: 'present_user', serverId: 'home', defaultSessionId: 'destination',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.source).toMatchObject({ requestedCapabilities: { networkOrigins: ['https://api.example.com', 'https://cdn.example.com'] } });
    expect(confirmations).toHaveLength(1);
    const summary = getActionSpec('session.board.item.upsert').approvalPresentation?.summary(confirmations[0]);
    expect(summary).toContain('https://api.example.com');
    expect(summary).toContain('https://cdn.example.com');
    expect(summary).toMatch(/keeps.*network/i);
  });
});
