import { artifactHtmlBundleFromBodyV1 } from '../../artifacts/artifactHtmlV1.js';
import { describe, expect, it } from 'vitest';
import { SessionSurfaceItemV1Schema, SessionSurfaceItemV1StoredSchema, isSessionSurfaceItemSourceCompatible } from './item.js';
import { createSessionSurfaceNoteDocumentV1, readSessionSurfaceNoteTextV1 } from './declarative/note.js';

describe('Session surface items', () => {
  const note = { v: 1, title: '', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'stack', children: [] } } } };
  it('normalizes retained Board items at the stored owner and preserves explicit transcript intent', () => {
    expect(SessionSurfaceItemV1StoredSchema.parse(note)).toMatchObject({ destination: 'board' });
    expect(SessionSurfaceItemV1StoredSchema.parse({ ...note, destination: 'transcript' })).toMatchObject({ destination: 'transcript' });
  });
  it('keeps creation destination fixed through content updates', () => {
    const transcript = SessionSurfaceItemV1Schema.parse({ ...note, destination: 'transcript' });
    expect(isSessionSurfaceItemSourceCompatible(transcript, { ...transcript, title: 'Edited' })).toBe(true);
    expect(isSessionSurfaceItemSourceCompatible(transcript, { ...transcript, destination: 'board' })).toBe(false);
  });
  it('accepts an explicitly saved blank native note', () => {
    expect(SessionSurfaceItemV1Schema.parse(note)).toEqual(note);
  });
  it('drops additive stored document fields without weakening required fields or snapshot inertness', () => {
    const snapshot = { ...note, source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Frozen' } } },
      snapshot: { asOf: '2026-09-05T00:00:00.000Z', provenance: [{ label: 'Status' }] } };
    const stored = { ...snapshot, extra: true, height: { ...snapshot.height, extra: true }, source: { ...snapshot.source,
      extra: true, document: { ...snapshot.source.document, extra: true, root: { ...snapshot.source.document.root, extra: true } } },
      snapshot: { ...snapshot.snapshot, extra: true, provenance: [{ label: 'Status', extra: true }] } };
    expect(SessionSurfaceItemV1StoredSchema.parse(stored)).toEqual({ ...snapshot, destination: 'board' });
    expect(SessionSurfaceItemV1Schema.safeParse(stored).success).toBe(false);
    for (const invalid of [
      { ...stored, height: { mode: 'fixed' } },
      { ...stored, source: { kind: 'unknown' } },
      { ...stored, snapshot: { ...stored.snapshot, asOf: null } },
      { ...stored, source: { kind: 'declarative', document: { version: 1, root: {
        kind: 'action', hostAction: 'session.message.send', label: 'Send', input: { text: 'Hello' }, extra: true,
      } } } },
    ]) expect(SessionSurfaceItemV1StoredSchema.safeParse(invalid).success).toBe(false);
  });
  it('normalizes stored widget references while retaining shared-content privacy admission', () => {
    const instance = { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'dashboard' } },
      bindings: { connection: { kind: 'viewer', purpose: 'metrics' } } };
    const canonical = { ...note, source: { kind: 'widget', instance } };
    const stored = { ...canonical, source: { ...canonical.source, extra: true, instance: { ...instance, extra: true,
      definition: { ...instance.definition, extra: true, surface: { ...instance.definition.surface, extra: true } },
      bindings: { connection: { ...instance.bindings.connection, extra: true } },
    } } };
    expect(SessionSurfaceItemV1StoredSchema.parse(stored)).toEqual({ ...canonical, destination: 'board' });
    expect(SessionSurfaceItemV1Schema.safeParse(stored).success).toBe(false);
    expect(SessionSurfaceItemV1StoredSchema.safeParse({ ...stored, source: { kind: 'widget', instance: {
      ...instance, definition: { kind: 'artifact', artifactId: 'private-definition', extra: true },
    } } }).success).toBe(false);
    expect(SessionSurfaceItemV1StoredSchema.safeParse({ ...stored, source: { kind: 'widget', instance: {
      ...instance, bindings: { connection: { kind: 'value', value: {
        service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'author-connection',
      } } },
    } } }).success).toBe(false);
  });
  it('persists only the walkthrough comparison selector, never frozen progress or result authority', () => {
    const item = { ...note, source: { kind: 'walkthrough', comparison: 'session' } };
    expect(SessionSurfaceItemV1Schema.parse(item)).toEqual(item);
    expect(SessionSurfaceItemV1Schema.safeParse({ ...item, source: { ...item.source, reviewedCount: 2 } }).success).toBe(false);
    expect(SessionSurfaceItemV1Schema.safeParse({ ...item, source: { kind: 'walkthrough', comparison: 'latest' } }).success).toBe(false);
  });
  it('accepts canonical host Action requests as data without plugin or caller authority', () => {
    const root = { kind: 'action', hostAction: 'session.message.send', label: 'Send', input: { text: 'Hello' } };
    const item = { ...note, source: { kind: 'declarative', document: { version: 1, root } } };
    expect(SessionSurfaceItemV1Schema.parse(item)).toEqual(item);
    expect(SessionSurfaceItemV1Schema.safeParse({ ...note, source: { kind: 'declarative', document: {
      version: 1, root: { ...root, effect: { kind: 'composerApply', expectedRevision: 0, operations: [{ kind: 'text.clear' }] } },
    } } }).success).toBe(false);
  });
  it('roundtrips blank and Markdown notes through the ordinary declarative document', () => {
    for (const text of ['', '# Note\n\nBody', '    indented code\n']) {
      expect(readSessionSurfaceNoteTextV1(createSessionSurfaceNoteDocumentV1(text))).toBe(text);
    }
    expect(readSessionSurfaceNoteTextV1({ version: 1, root: { kind: 'status', label: 'Status', value: 'Ready' } })).toBeNull();
  });
  it('rejects plugin authority and renderer-only nodes in Session authored content', () => {
    for (const root of [
      { kind: 'field', label: 'Secret', control: { kind: 'secret', settingId: 'secret' } },
      { kind: 'action', label: 'Run', action: { pluginId: 'com.acme.test', localId: 'run' } },
      { kind: 'item', title: 'Run', action: 'run' },
    ]) {
      expect(SessionSurfaceItemV1Schema.safeParse({ ...note, source: { kind: 'declarative', document: { version: 1, root } } }).success).toBe(false);
    }
  });
  it('reuses declarative preflight and rejects excess UTF-8 bytes before recursion', () => {
    expect(SessionSurfaceItemV1Schema.safeParse({ ...note, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'x'.repeat(512 * 1024) } } } }).success).toBe(false);
  });
  it('stores configured shared widgets without admitting private definition references', () => {
    const instance = { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'dashboard' } }, bindings: { connection: { kind: 'viewer', purpose: 'metrics' }, session: { kind: 'context', slot: 'session' } } };
    const item = { ...note, source: { kind: 'widget', instance } };
    expect(SessionSurfaceItemV1Schema.safeParse(item).success).toBe(true);
    expect(SessionSurfaceItemV1Schema.safeParse({ ...item, source: { kind: 'widget', instance: { ...instance, definition: { kind: 'artifact', artifactId: 'private-definition' } } } }).success).toBe(false);
    expect(SessionSurfaceItemV1Schema.safeParse({ ...item, source: { kind: 'widget', instance: { ...instance, token: 'private-token' } } }).success).toBe(false);
  });
  it('requires viewer intent instead of pinning an author connection into shared content', () => {
    const instance = { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'dashboard' } }, bindings: { connection: { kind: 'value', value: { service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'author-connection' } } } };
    expect(SessionSurfaceItemV1Schema.safeParse({ ...note, source: { kind: 'widget', instance } }).success).toBe(false);
  });
  it('recognizes private connection selections inside opaque values even with additive fields', () => {
    const privateValue = { service: { pluginId: 'com.acme.test', localId: 'cloud', extra: true }, accountId: 'author-connection', extra: true };
    const instance = { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'dashboard' } },
      bindings: { connection: { kind: 'value', value: { nested: [privateValue] } } } };
    const item = { ...note, source: { kind: 'widget', instance } };
    expect(SessionSurfaceItemV1Schema.safeParse(item).success).toBe(false);
    expect(SessionSurfaceItemV1StoredSchema.safeParse(item).success).toBe(false);
  });
  it('keeps source class and exact widget definition immutable while permitting instance input edits', () => {
    const previous = SessionSurfaceItemV1Schema.parse(note);
    const instance = { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'com.acme.test', localId: 'dashboard' } }, bindings: {} };
    const installed = SessionSurfaceItemV1Schema.parse({ ...note, source: { kind: 'widget', instance } });
    expect(isSessionSurfaceItemSourceCompatible(previous, { ...previous, title: 'Changed' })).toBe(true);
    expect(isSessionSurfaceItemSourceCompatible(previous, installed)).toBe(false);
    const changed = SessionSurfaceItemV1Schema.parse({ ...note, source: { kind: 'widget', instance: { ...instance, bindings: { session: { kind: 'value', value: 'session-b' } } } } });
    expect(isSessionSurfaceItemSourceCompatible(installed, changed)).toBe(true);
    const replaced = SessionSurfaceItemV1Schema.parse({ ...note, source: { kind: 'widget', instance: { ...instance, definition: { ...instance.definition, surface: { pluginId: 'com.acme.test', localId: 'other' } } } } });
    expect(isSessionSurfaceItemSourceCompatible(installed, replaced)).toBe(false);
  });
  it('accepts the canonical hosted HTML source and keeps its authority class immutable', () => {
    const hosted = SessionSurfaceItemV1Schema.parse({
      ...note,
      source: {
        kind: 'hostedHtml',
        source: artifactHtmlBundleFromBodyV1('<main>Hello</main>'),
        requestedCapabilities: { hostMethods: ['context'] },
      },
    });
    expect(hosted.source.kind).toBe('hostedHtml');
    expect(isSessionSurfaceItemSourceCompatible(hosted, {
      ...hosted,
      source: {
        kind: 'hostedHtml',
        source: artifactHtmlBundleFromBodyV1('<main>Changed</main>'),
        requestedCapabilities: { hostMethods: ['context'] },
      },
    })).toBe(true);
    expect(isSessionSurfaceItemSourceCompatible(hosted, SessionSurfaceItemV1Schema.parse(note))).toBe(false);
  });
});
