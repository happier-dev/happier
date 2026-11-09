import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeScmActionOperation } from './executeScmActionOperation';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { RpcHandler } from '@/api/rpc/types';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';

const registry = createTestGitScmBackendRegistry();

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(content = 'first\nold value\nthird\nold tail\n') {
  const root = await mkdtemp(join(tmpdir(), 'suggest-apply-'));
  roots.push(root);
  await writeFile(join(root, 'file.txt'), content);
  return root;
}
function suggestion(overrides = {}) {
  return { path: 'file.txt', commitOid: 'a'.repeat(40), startLine: 2, endLine: 2,
    originalLines: ['old value'], replacement: 'new value', outdated: false, ...overrides };
}
async function apply(root: string, suggestions = [suggestion()]) {
  return executeScmActionOperation({ actionId: 'scm.suggestion.apply',
    input: { sessionId: 'session-1', cwd: root, suggestions }, workingDirectory: root, registry,
    sessionId: 'session-1', accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
}

describe('Session checkout suggestion Action', () => {
  it('resolves GitHub paths from the repository root when the Session starts in a subdirectory', async () => {
    const root = await fixture();
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    const nested = join(root, 'nested');
    await mkdir(nested);
    expect(await executeScmActionOperation({ actionId: 'scm.suggestion.apply',
      input: { sessionId: 'session-1', cwd: nested, suggestions: [suggestion()] }, workingDirectory: nested, registry,
      sessionId: 'session-1', accessPolicy: { kind: 'restrictedRoots', roots: [root] } })).toMatchObject({ success: true });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toContain('new value');
  });
  it('reaches the same writer through the registered Session SCM transport', async () => {
    const root = await fixture();
    const handlers = new Map<string, RpcHandler>();
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, root,
      { registry, accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
    const handler = handlers.get('scm.suggestion.apply');
    if (!handler) throw new Error('Suggestion Action transport is absent');
    expect(await handler({ sessionId: 'session-1', suggestions: [suggestion()] }, {
      signal: new AbortController().signal, authorization: { kind: 'session.write', sessionId: 'session-1' },
    })).toMatchObject({ success: true });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toContain('new value');
  });
  it('applies exact anchored lines and leaves the change in the working tree', async () => {
    const root = await fixture();
    expect(await apply(root)).toMatchObject({ success: true, files: [{ path: 'file.txt', status: 'applied' }] });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nnew value\nthird\nold tail\n');
  });
  it('refuses changed lines without writing any part of the file', async () => {
    const root = await fixture('first\nsomeone else\nthird\nold tail\n');
    expect(await apply(root)).toMatchObject({ success: false, files: [{ errorCode: 'suggestion_conflict' }] });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nsomeone else\nthird\nold tail\n');
  });
  it('refuses an outdated suggestion without a write', async () => {
    const root = await fixture();
    expect(await apply(root, [suggestion({ outdated: true })])).toMatchObject({ success: false,
      files: [{ errorCode: 'suggestion_outdated' }] });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toContain('old value');
  });
  it('refuses overlapping suggestions as one atomic per-file batch', async () => {
    const root = await fixture();
    expect(await apply(root, [suggestion(), suggestion({ replacement: 'other' })])).toMatchObject({ success: false,
      files: [{ errorCode: 'suggestion_conflict' }] });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toContain('old value');
  });
  it('applies non-overlapping replacements against the original offsets', async () => {
    const root = await fixture();
    expect(await apply(root, [suggestion({ replacement: 'new\nextra' }), suggestion({ startLine: 4, endLine: 4,
      originalLines: ['old tail'], replacement: 'new tail' })])).toMatchObject({ success: true });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nnew\nextra\nthird\nnew tail\n');
  });
  it('keeps a valid sibling suggestion unapplied when the same file has a conflict', async () => {
    const root = await fixture();
    expect(await apply(root, [suggestion(), suggestion({ startLine: 4, endLine: 4,
      originalLines: ['different'], replacement: 'new tail' })])).toMatchObject({ success: false });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nold value\nthird\nold tail\n');
  });
  it('preserves CRLF and absence of a final newline', async () => {
    const root = await fixture('first\r\nold value');
    expect(await apply(root)).toMatchObject({ success: true });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\r\nnew value');
  });
  it('treats a trailing carriage return without LF as changed content', async () => {
    const root = await fixture('first\nold value\r');
    expect(await apply(root)).toMatchObject({ success: false, files: [{ errorCode: 'suggestion_conflict' }] });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nold value\r');
  });
  it('applies a snapshot that explicitly includes carriage-return content', async () => {
    const root = await fixture('first\nold value\r');
    expect(await apply(root, [suggestion({ originalLines: ['old value\r'] })])).toMatchObject({ success: true });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nnew value');
  });
  it('refuses a path outside the selected checkout', async () => {
    const root = await fixture();
    const outside = await fixture();
    expect(await apply(root, [suggestion({ path: join(outside, 'file.txt') })])).toMatchObject({ success: false,
      files: [{ errorCode: 'invalid_path' }] });
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toContain('old value');
  });
  it('deletes the selected complete lines for an empty replacement', async () => {
    const root = await fixture();
    expect(await apply(root, [suggestion({ replacement: '' })])).toMatchObject({ success: true });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first\nthird\nold tail\n');
  });
  it('reports separate files independently while preserving each conflicting file', async () => {
    const root = await fixture();
    await writeFile(join(root, 'other.txt'), 'first\nchanged\n');
    expect(await apply(root, [suggestion(), suggestion({ path: 'other.txt' })])).toMatchObject({ success: false,
      files: [{ path: 'file.txt', status: 'applied' }, { path: 'other.txt', errorCode: 'suggestion_conflict' }] });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toContain('new value');
    expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('first\nchanged\n');
  });
});
