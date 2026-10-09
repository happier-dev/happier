import { describe, expect, it } from 'vitest';

import { ProjectManifestV1Schema, ProjectManifestV1StoredSchema } from './projectManifestV1.js';
import { editProjectManifestDocument, readProjectManifestDocument } from './projectManifestDocument.js';

describe('project manifest documents', () => {
  const bytes = '{\n  "version": 1,\n  "future": {"keep": [1, 2]},\n  "scripts": {\n    "build": {"source": {"kind":"command", "command":"old", "futureSource":true}, "futureEntry":{"ok":true}},\n    "test": {"source":{"kind":"native", "tool":"package_script", "file":"package.json", "target":"test"}}\n  }\n}\n';

  it('projects usable known fields while diagnosing and retaining recursive unknown content', () => {
    const document = readProjectManifestDocument(bytes);
    expect(document.status).toBe('valid');
    if (document.status !== 'valid') throw new Error('valid manifest required');
    expect(document.bytes).toBe(bytes);
    expect(document.original.future).toEqual({ keep: [1, 2] });
    expect(document.manifest.scripts?.build.source).toEqual({ kind: 'command', command: 'old' });
    expect(document.diagnostics.filter(d => d.code === 'unrecognized_key').map(d => d.path)).toEqual([
      ['future'], ['scripts', 'build', 'futureEntry'], ['scripts', 'build', 'source', 'futureSource'],
    ]);
    expect(ProjectManifestV1Schema.safeParse(document.original).success).toBe(false);
    expect(ProjectManifestV1StoredSchema.safeParse(document.original).success).toBe(true);
  });

  it('edits one field, imports a reference, removes and reorders without rewriting untouched bytes', () => {
    const edited = editProjectManifestDocument(readProjectManifestDocument(bytes), [
      { kind: 'set', path: ['scripts', 'build', 'source', 'command'], value: 'new' },
      { kind: 'set', path: ['scripts', 'deploy'], value: { source: { kind: 'pluginNative', adapter: { pluginId: 'example.pixi', localId: 'tasks' }, file: 'pixi.toml', target: 'deploy' } } },
      { kind: 'remove', path: ['scripts', 'test'] },
      { kind: 'reorder', path: ['scripts'], keys: ['deploy', 'build'] },
    ]);
    expect(edited.status).toBe('valid');
    if (edited.status !== 'valid') throw new Error('valid manifest required');
    expect(Object.keys(edited.manifest.scripts ?? {})).toEqual(['deploy', 'build']);
    expect(edited.bytes).toContain('"future": {"keep": [1, 2]}');
    expect(edited.bytes).toContain('"source": {"kind":"command", "command":"new", "futureSource":true}, "futureEntry":{"ok":true}');
    expect(edited.diagnostics.filter(d => d.code === 'unrecognized_key')).toHaveLength(3);
  });

  it('preserves invalid raw text and still rejects invalid required data and escaping references', () => {
    expect(readProjectManifestDocument('{\n"version":').bytes).toBe('{\n"version":');
    expect(readProjectManifestDocument('{"version":1,"scripts":{"bad":{"source":{"kind":"native","tool":"make","file":"../Makefile","target":"all"}}}}').status).toBe('invalid');
    expect(readProjectManifestDocument('{"version":1,"scripts":{"bad":{"future":true}}}').status).toBe('invalid');
    expect(readProjectManifestDocument('{"version":1,"environment":{"kind":"toolchain","tool":"nix_flake"}}').status).toBe('valid');
  });

  it('keeps optional observed memory demand and converts edited demand to declared', () => {
    const document = readProjectManifestDocument('{"version":1,"workspace":{"memoryDemand":{"bytes":4096,"basis":{"kind":"measured","operation":{"serverId":"s","machineId":"m","operationId":"o"}}}}}');
    expect(document.status).toBe('valid');
    const edited = editProjectManifestDocument(document, [{ kind: 'set', path: ['workspace', 'memoryDemand', 'bytes'], value: 8192 }]);
    if (edited.status !== 'valid') throw new Error('valid manifest required');
    expect(edited.manifest.workspace?.memoryDemand).toEqual({ bytes: 8192, basis: { kind: 'declared' } });
    expect(readProjectManifestDocument('{"version":1}')).toMatchObject({ status: 'valid', manifest: { version: 1 } });
  });

  it('retains nested unknown step fields and qualified environment facts through contained edits', () => {
    const document = readProjectManifestDocument('{"version":1,"environment":{"kind":"pluginToolchain","adapter":{"pluginId":"example.pixi","localId":"environment","future":true},"configPath":"pixi.toml"},"workspace":{"setup":[{"kind":"command","command":"before","future":{"retain":true}}]},"environmentVariables":[{"name":"TOKEN","kind":"secret","required":true,"future":true}]}');
    expect(document.status).toBe('valid');
    const edited = editProjectManifestDocument(document, [{ kind: 'set', path: ['workspace', 'setup', 0, 'command'], value: 'after' }]);
    if (edited.status !== 'valid') throw new Error('valid manifest required');
    expect(edited.bytes).toContain('"command":"after","future":{"retain":true}');
    expect(edited.manifest.environment).toEqual({ kind: 'pluginToolchain', adapter: { pluginId: 'example.pixi', localId: 'environment' }, configPath: 'pixi.toml' });
    expect(edited.manifest.environmentVariables).toEqual([{ name: 'TOKEN', kind: 'secret', required: true }]);
    expect(edited.diagnostics.filter(d => d.code === 'unrecognized_key')).toHaveLength(3);
  });

  it('reorders setup steps by index without dropping their unknown content', () => {
    const edited = editProjectManifestDocument(readProjectManifestDocument('{"version":1,"workspace":{"setup":[{"kind":"command","command":"one","future":{"keep":1}},{"kind":"command","command":"two","future":{"keep":2}}]}}'), [
      { kind: 'reorder', path: ['workspace', 'setup'], keys: [1, 0] },
    ]);
    expect(edited.status).toBe('valid');
    if (edited.status !== 'valid') throw new Error('valid manifest required');
    expect(edited.manifest.workspace?.setup).toEqual([{ kind: 'command', command: 'two' }, { kind: 'command', command: 'one' }]);
    expect(edited.original).toMatchObject({ workspace: { setup: [{ future: { keep: 2 } }, { future: { keep: 1 } }] } });
  });
});
