import { describe, expect, it } from 'vitest';

import { FEATURE_CATALOG, FEATURE_IDS, isFeatureId } from './catalog.js';

describe('feature catalog', () => {
  it('contains unique feature ids', () => {
    const unique = new Set(FEATURE_IDS);
    expect(unique.size).toBe(FEATURE_IDS.length);
  });

  it('does not include legacy inbox.friends feature id', () => {
    expect(isFeatureId('inbox.friends')).toBe(false);
  });

  it('includes files feature ids', () => {
    expect(isFeatureId('files.reviewComments')).toBe(true);
    expect(isFeatureId('files.diffSyntaxHighlighting')).toBe(true);
    expect(isFeatureId('files.editor')).toBe(true);
    expect(isFeatureId('files.syntaxHighlighting.advanced')).toBe(true);
  });

  it('includes execution runs feature id', () => {
    expect(isFeatureId('execution.runs')).toBe(true);
  });

  it('includes connected services quotas feature id', () => {
    expect(isFeatureId('connectedServices.quotas')).toBe(true);
  });

  it('includes OTA updates feature id', () => {
    expect(isFeatureId('updates.ota')).toBe(true);
  });

  it('includes sharing feature ids', () => {
    expect(isFeatureId('sharing.session')).toBe(true);
    expect(isFeatureId('sharing.public')).toBe(true);
    expect(isFeatureId('sharing.contentKeys')).toBe(true);
    expect(isFeatureId('sharing.pendingQueueV2')).toBe(true);
  });

  it('includes voice agent feature id', () => {
    expect(isFeatureId('voice.agent')).toBe(true);
  });

  it('includes happier voice feature id', () => {
    expect(isFeatureId('voice.happierVoice')).toBe(true);
  });

  it('does not include legacy connected.services ids', () => {
    expect(isFeatureId('connected.services')).toBe(false);
    expect(isFeatureId('connected.services.quotas')).toBe(false);
  });

  it('maps every catalog entry to a known feature id', () => {
    for (const key of Object.keys(FEATURE_CATALOG)) {
      expect(isFeatureId(key)).toBe(true);
    }
  });

  it('only references known feature ids in dependencies', () => {
    for (const entry of Object.values(FEATURE_CATALOG)) {
      for (const dep of entry.dependencies) {
        expect(isFeatureId(dep)).toBe(true);
      }
    }
  });

  it('does not contain dependency cycles', () => {
    const depsById = new Map(Object.entries(FEATURE_CATALOG).map(([id, e]) => [id, e.dependencies] as const));

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`cycle detected at ${id}`);
      visiting.add(id);
      const deps = depsById.get(id as any) ?? [];
      for (const dep of deps) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of Object.keys(FEATURE_CATALOG)) {
      visit(id);
    }
  });

  it('marks all features fail closed by default', () => {
    for (const entry of Object.values(FEATURE_CATALOG)) {
      expect(entry.defaultFailMode).toBe('fail_closed');
    }
  });
});
