import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';

import { readProjectManifest, updateProjectManifest } from './projectManifestFile';

describe('guarded project repository file', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function root() { const value = await mkdtemp(join(tmpdir(), 'happier-project-manifest-')); roots.push(value); return value; }

  it('creates only from absent basis and writes exact raw bytes while allowing diagnosed unknown keys', async () => {
    const directory = await root();
    expect(await readProjectManifest({ root: directory })).toEqual({ basis: { kind: 'absent' }, document: null });
    const bytes = '{ "version" : 1, "future" : { "keep": true } }\r\n';
    const saved = await updateProjectManifest({ root: directory, expectedBasis: { kind: 'absent' }, bytes });
    expect(saved).toMatchObject({ status: 'saved', basis: { kind: 'present', hash: createHash('sha256').update(bytes).digest('hex') }, document: { status: 'valid' } });
    expect(await readFile(join(directory, '.happier/project.json'), 'utf8')).toBe(bytes);
    const conflict = await updateProjectManifest({ root: directory, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}' });
    expect(conflict).toMatchObject({ status: 'conflict', current: { document: { bytes } } });
  });

  it('returns current outside edit and refuses invalid bytes without changing the existing file', async () => {
    const directory = await root();
    await mkdir(join(directory, '.happier'));
    await writeFile(join(directory, '.happier/project.json'), '{"version":1}');
    const inspected = await readProjectManifest({ root: directory });
    const changed = '{"version":1,"external":true}\n';
    await writeFile(join(directory, '.happier/project.json'), changed);
    expect(await updateProjectManifest({ root: directory, expectedBasis: inspected.basis, bytes: '{"version":1,"scripts":{}}' })).toMatchObject({ status: 'conflict', current: { document: { bytes: changed } } });
    expect(await updateProjectManifest({ root: directory, expectedBasis: inspected.basis, bytes: '{"version":2}' })).toMatchObject({ status: 'refused', code: 'invalid_manifest' });
    expect(await readFile(join(directory, '.happier/project.json'), 'utf8')).toBe(changed);
  });

  it('reloads structured edits with all untouched content and diagnostics preserved', async () => {
    const directory = await root();
    const bytes = '{\n "version":1, "future":{"retain":true}, "scripts":{"a":{"source":{"kind":"command","command":"before","futureSource":true},"futureEntry":42}}\n}\n';
    await updateProjectManifest({ root: directory, expectedBasis: { kind: 'absent' }, bytes });
    const snapshot = await readProjectManifest({ root: directory });
    if (!snapshot.document) throw new Error('present manifest required');
    const edited = editProjectManifestDocument(snapshot.document, [
      { kind: 'set', path: ['scripts', 'a', 'source', 'command'], value: 'after' },
      { kind: 'set', path: ['scripts', 'b'], value: { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'build' } } },
      { kind: 'reorder', path: ['scripts'], keys: ['b', 'a'] },
    ]);
    expect(edited.status).toBe('valid');
    expect(await updateProjectManifest({ root: directory, expectedBasis: snapshot.basis, bytes: edited.bytes })).toMatchObject({ status: 'saved' });
    const reloaded = await readProjectManifest({ root: directory });
    expect(reloaded.document).toMatchObject({ status: 'valid', original: { future: { retain: true }, scripts: { a: { futureEntry: 42, source: { futureSource: true } } } } });
    expect(reloaded.document?.diagnostics.filter(d => d.code === 'unrecognized_key')).toHaveLength(3);
    expect(reloaded.document?.bytes).toContain('"future":{"retain":true}');
  });
});
