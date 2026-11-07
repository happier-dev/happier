import { describe, expect, it } from 'vitest';

import { planTriageListContinuationV1, readTriageWindowStatementV1 } from './continuation.js';

const text = (_key: string, fallback?: string, values?: Readonly<Record<string, string | number>>) =>
  (fallback ?? '').replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? ''));
const lane = (health: 'failed' | 'healthy', sourceInstanceId = 'a') => ({
  sourceInstanceId, source: { pluginId: 'p', localId: 'l' }, exhausted: false,
  health: health === 'failed' ? { kind: 'failed', failure: { class: 'transient', code: 'x' } } : { kind: 'ok' },
}) as never;
const statement = (health: 'failed' | 'healthy') => readTriageWindowStatementV1({
  loadedCount: 2, window: { coverage: 'partial', lanes: [lane(health)] } as never, configuredSources: [],
  entries: planTriageListContinuationV1({ section: 'entries', state: { kind: 'unresumable' } as never, text }), text,
});

describe('the list footer beside a source failure', () => {
  it('names each source once rather than repeating connection logins', () => {
    const source = { pluginId: 'github', localId: 'forge' };
    const configuredSources = [
      { sourceInstanceId: 'a', source, displayLabel: 'alice-login' },
      { sourceInstanceId: 'b', source, displayLabel: 'bob-login' },
    ];
    expect(readTriageWindowStatementV1({ loadedCount: 2,
      window: { coverage: 'partial', lanes: [lane('healthy'), lane('healthy', 'b')] },
      configuredSources, readSourceName: () => 'GitHub', entries: { title: 'More entries may exist', description: '', tone: 'neutral', busy: false }, text,
    })).toEqual(['2 loaded', 'GitHub may have more']);
  });
  it('leaves a connection that failed to the page\'s one failure line', () => {
    expect(statement('failed')).toEqual(['2 loaded']);
  });
  it('still says a healthy read stopped short, which nothing else states', () => {
    expect(statement('healthy')).toEqual(['2 loaded', 'Some entries could not be reached']);
  });
});
