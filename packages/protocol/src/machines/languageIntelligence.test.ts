import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import {
  DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, DaemonLspSyncRequestSchema,
  DaemonLspWatchResponseSchema,
} from './languageIntelligence.js';

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };

describe('language intelligence Machine wire contract', () => {
  it('admits only the live inline operation with captured buffer identity and no client credential or policy authority', () => {
    const request = { rootPath: '/repo', path: 'a.ts', kind: 'ai.inlineSuggest', version: 3, languageId: 'typescript',
      position: { line: 1, character: 4 }, inlineSuggestion: { connectionId: 'pc_source', modelId: 'base', prefix: 'const ', suffix: '\n' } };
    expect(DaemonLspQueryRequestSchema.parse(request)).toEqual(request);
    for (const extra of [{ key: 'secret' }, { url: 'https://outside.test' }, { headers: { authorization: 'secret' } }, { enabled: true }]) {
      expect(DaemonLspQueryRequestSchema.safeParse({ ...request, inlineSuggestion: { ...request.inlineSuggestion, ...extra } }).success).toBe(false);
    }
    expect(DaemonLspQueryRequestSchema.safeParse({ ...request, kind: 'ai.nextEdit' }).success).toBe(false);
    expect(DaemonLspQueryRequestSchema.safeParse({ ...request, position: { line: 1, symbol: 'value' } }).success).toBe(false);
    expect(DaemonLspQueryRequestSchema.safeParse({ ...request, version: undefined }).success).toBe(false);
    expect(DaemonLspQueryRequestSchema.safeParse({ ...request, kind: 'hover' }).success).toBe(false);
  });
  it('accepts editor synchronization and symbol-addressed disk queries without admitting native process controls', () => {
    expect(DaemonLspSyncRequestSchema.parse({ rootPath: '/repo', op: { op: 'external', paths: ['src/a.ts'] } })).toEqual({
      rootPath: '/repo', op: { op: 'external', paths: ['src/a.ts'] },
    });
    expect(DaemonLspSyncRequestSchema.safeParse({ rootPath: '/repo', op: { op: 'open', path: 'a.ts', languageId: 'typescript',
      version: 0, text: '', unsaved: false, executable: '/tmp/evil' } }).success).toBe(false);
    const query = { rootPath: '/repo', path: 'a.ts', kind: 'definition', text: 'disk', position: { line: 1, symbol: 'value', occurrence: 2 } };
    expect(DaemonLspQueryRequestSchema.parse(query)).toEqual(query);
    for (const position of [{ line: -1, character: 0 }, { line: 0, character: 0, symbol: 'x' }, { line: 0 }, { line: 0, symbol: 'x', occurrence: 0 }]) {
      expect(DaemonLspQueryRequestSchema.safeParse({ ...query, position }).success).toBe(false);
    }
    for (const path of ['../secret', '/etc/passwd', 'C:/secret', 'src\\a.ts', 'src/../secret']) {
      expect(DaemonLspQueryRequestSchema.safeParse({ ...query, path }).success).toBe(false);
    }
  });

  it('preserves typed refusals, explicit list completeness and strict nested payloads', () => {
    expect(DaemonLspQueryResponseSchema.parse({ status: 'error', errorCode: 'unsaved_editor_changes', diskHash: 'a'.repeat(64) })).toMatchObject({ errorCode: 'unsaved_editor_changes' });
    expect(DaemonLspQueryResponseSchema.safeParse({ status: 'error', errorCode: 'unsaved_editor_changes' }).success).toBe(false);
    expect(DaemonLspQueryResponseSchema.safeParse({ status: 'error', errorCode: 'symbol_not_found' }).success).toBe(false);
    const response = { status: 'ok', kind: 'definition', locations: [{ serverId: 'test/lsp', path: 'src/a.ts', range }], hasMore: false };
    expect(DaemonLspQueryResponseSchema.parse(response)).toEqual(response);
    expect(DaemonLspQueryResponseSchema.safeParse({ ...response, hasMore: undefined }).success).toBe(false);
    expect(DaemonLspQueryResponseSchema.safeParse({ ...response, locations: [{ ...response.locations[0], uri: 'file:///secret' }] }).success).toBe(false);
    expect(DaemonLspQueryResponseSchema.safeParse({ ...response, locations: [{ ...response.locations[0], path: '/outside/lib.ts' }] }).success).toBe(false);
    expect(DaemonLspQueryResponseSchema.parse({ ...response, locations: [{ ...response.locations[0], path: '/outside/lib.ts', outsideWorkspace: true }] })).toMatchObject({ status: 'ok' });
  });

  it('carries diagnostics replacement provenance so a stale or unavailable answer cannot become a confirmed empty answer', () => {
    const response = { status: 'ok', revision: 1, servers: [], diagnostics: { 'src/a.ts': { 'test/lsp': {
      state: 'checking', generation: 'native-start', version: 2, items: [],
    } } } };
    expect(DaemonLspWatchResponseSchema.parse(response)).toEqual(response);
    expect(DaemonLspWatchResponseSchema.safeParse({ ...response, diagnostics: { 'src/a.ts': { 'test/lsp': [] } } }).success).toBe(false);
    expect(DaemonLspWatchResponseSchema.safeParse({ ...response, diagnostics: { '../secret': response.diagnostics['src/a.ts'] } }).success).toBe(false);
    expect(DaemonLspWatchResponseSchema.safeParse({ ...response, diagnostics: { 'src/a.ts': { 'test/lsp': { state: 'ready', version: 2, items: [] } } } }).success).toBe(false);
  });

  it('retains and validates prototype-named workspace paths in diagnostics replacements', () => {
    const entry = { state: 'ready', generation: 'native-start', version: 1, items: [] };
    const servers = Object.fromEntries(['test/lsp', '__proto__'].map((serverId) => [serverId, entry]));
    const diagnostics = Object.fromEntries(['__proto__', 'constructor'].map((path) => [path, servers]));
    const response = { status: 'ok', revision: 1, servers: [], diagnostics };
    const parsed = DaemonLspWatchResponseSchema.parse(response);
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') throw new Error('Expected diagnostics replacement');
    expect(Object.keys(parsed.diagnostics).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(parsed.diagnostics, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed.diagnostics.__proto__, '__proto__')).toBe(true);
    for (const invalid of [[], new Date(), new Error('native failure'),
      Object.fromEntries([['__proto__', { 'test/lsp': { ...entry, generation: undefined } }]]),
      Object.fromEntries([['__proto__', { 'test/lsp': { ...entry, unknown: true } }]]),
      { '../secret': servers }, { 'a.ts': { '': entry } },
    ]) expect(DaemonLspWatchResponseSchema.safeParse({ ...response, diagnostics: invalid }).success).toBe(false);
    expect(z.toJSONSchema(DaemonLspWatchResponseSchema)).toMatchObject({
      anyOf: expect.arrayContaining([expect.objectContaining({ properties: expect.objectContaining({
        diagnostics: expect.objectContaining({ type: 'object', additionalProperties: expect.objectContaining({
          type: 'object', additionalProperties: expect.objectContaining({ type: 'object', additionalProperties: false }),
        }) }),
      }) })]),
    });
  });
});
