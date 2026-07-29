import { describe, expect, it } from 'vitest';
import {
  ProviderErrorCodeV1Schema,
  createProviderErrorV1,
} from '@happier-dev/protocol';

import { presentProviderCliRefusal } from './presentProviderCliRefusal';

describe('Provider CLI refusal presentation', () => {
  it('has a bounded actionable presentation for every closed Provider error code', () => {
    for (const code of ProviderErrorCodeV1Schema.options) {
      const error = createProviderErrorV1(code);
      const presentation = presentProviderCliRefusal(error);
      expect(presentation.join('\n'), code).toContain(code);
      expect(presentation).toHaveLength(2);
      expect(presentation.every((line) => line.length > 0 && line.length <= 512), code).toBe(true);
    }
  });

  it('renders only typed bounded context fields', () => {
    const error = {
      ...createProviderErrorV1('provider_binding_changed', {
        connectionId: 'pc_gateway',
        machineId: 'machine-1',
      }),
      transportMessage: 'secret=do-not-render',
    };

    const presentation = presentProviderCliRefusal(error);
    expect(presentation).toContain('Connection: pc_gateway');
    expect(presentation).toContain('Machine: machine-1');
    expect(presentation.join('\n')).not.toContain('do-not-render');
  });

  it('renders source profile context without terminal control characters and keeps it bounded', () => {
    const presentation = presentProviderCliRefusal(
      createProviderErrorV1('provider_profile_migration_conflict', {
        sourceProfileId: 'profile\n\u001b[31m\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u2028\u2029\u{e0001}spoof',
      }),
    );

    expect(presentation).toContain(
      'Source profile: profile\\u000a\\u001b[31m\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069\\u2028\\u2029\\u{e0001}spoof',
    );
    expect(presentation.every((line) => !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(line))).toBe(true);

    const boundedPresentation = presentProviderCliRefusal(
      createProviderErrorV1('provider_profile_migration_conflict', {
        sourceProfileId: '\u001b'.repeat(256),
      }),
    );
    expect(boundedPresentation.every((line) => line.length <= 512)).toBe(true);

    const escapeBoundaryPresentation = presentProviderCliRefusal(
      createProviderErrorV1('provider_profile_migration_conflict', {
        sourceProfileId: `aaaa${'\u001b'.repeat(82)}b`,
      }),
    );
    expect(escapeBoundaryPresentation).toContain(`Source profile: aaaa${'\\u001b'.repeat(81)}…`);

    const surrogateBoundaryPresentation = presentProviderCliRefusal(
      createProviderErrorV1('provider_profile_migration_conflict', {
        sourceProfileId: `${'\u001b'.repeat(81)}${'a'.repeat(8)}😀b`,
      }),
    );
    expect(surrogateBoundaryPresentation).toContain(
      `Source profile: ${'\\u001b'.repeat(81)}${'a'.repeat(8)}…`,
    );
  });

  it('presents an invalid Provider RPC read as retryable after reloading current state', () => {
    const presentation = presentProviderCliRefusal(
      createProviderErrorV1('provider_rpc_response_invalid', { machineId: 'machine-a' }),
    );

    expect(presentation[0]).toContain('provider_rpc_response_invalid');
    expect(presentation[0]).toMatch(/Provider (?:RPC )?response (?:was invalid|could not be read)/i);
    expect(presentation[1]).toMatch(/reload.*try again/i);
  });

  it('presents an unknown Provider mutation outcome as review-only without implying replay', () => {
    const presentation = presentProviderCliRefusal(
      createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
        connectionId: 'pc_gateway',
        machineId: 'machine-a',
      }),
    );

    expect(presentation[0]).toContain('provider_rpc_mutation_outcome_unknown');
    expect(presentation[0]).toMatch(/may have.*(applied|completed).*could not.*confirm/i);
    expect(presentation[1]).toMatch(/review.*current Provider state/i);
    expect(presentation[1]).not.toMatch(/\b(?:retry|replay|repeat|try again)\b/i);
  });
});
