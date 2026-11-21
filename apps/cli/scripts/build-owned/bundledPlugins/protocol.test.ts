import { describe, expect, it } from 'vitest';
import { renderProtocolAgentProviderIdsV1Ts } from './protocol.ts';

describe('Protocol Agent provider ID projection', () => {
  it('routes the generated schema through the Protocol Zod runtime policy', () => {
    const generated = renderProtocolAgentProviderIdsV1Ts(['claude']);

    expect(generated).toContain("import { z } from '../../zodRuntimePolicy.js';");
  });
});
