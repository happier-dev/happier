import { describe, expect, it } from 'vitest';

import {
  describeRegistrySourceFailure,
  registrySourceFailureLine,
} from './describeRegistrySourceStatus';

describe('registry outage words', () => {
  it('names an unreachable source in one sentence, never "this registry" after a name', () => {
    expect(
      describeRegistrySourceFailure(
        { state: 'unreachable' },
        'Happier curated marketplace',
      ),
    ).toBe('Couldn’t reach Happier curated marketplace');
    expect(describeRegistrySourceFailure(null, 'MCP Registry')).toBe(
      'Couldn’t reach MCP Registry',
    );
  });

  it('keeps a typed reason other than unreachable beside the source', () => {
    expect(
      describeRegistrySourceFailure({ state: 'auth_failed' }, 'Acme'),
    ).toBe('Acme · Token rejected. Replace the token.');
  });

  it('an outage line without a known source says the catalogs, and always has Details to reveal', () => {
    const line = registrySourceFailureLine(
      { status: { state: 'unreachable' } },
      null,
    );
    expect(line.message).toBe('Couldn’t reach the catalogs');
    expect(line.details.length).toBeGreaterThan(0);
  });

  it('keeps what the producer said about held rows behind Details, under the named line', () => {
    const line = registrySourceFailureLine(
      {
        status: { state: 'unreachable' },
        message: 'Updated earlier · Couldn’t reach this registry.',
      },
      'skills.sh',
    );
    expect(line.message).toBe('Couldn’t reach skills.sh');
    expect(line.details).toContain(
      'Updated earlier · Couldn’t reach this registry.',
    );
  });
});
