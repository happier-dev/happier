import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildPiAgentRuntimeDescriptorV1,
  readCanonicalPiAgentRuntimeDescriptorV1,
} from './runtimeDescriptorV1.js';

describe('pi runtime descriptor v1', () => {
  it('owns the provider codec inside the plugin leaf', () => {
    const source = readFileSync(new URL('./runtimeDescriptorV1.ts', import.meta.url), 'utf8');

    const protocolImportPrefix = '@happier-dev/' + 'protocol';
    expect(source).not.toContain(`from '${protocolImportPrefix}`);
    expect(source).not.toContain(`from "${protocolImportPrefix}`);
  });

  it('builds absolute-preferred resume descriptors with optional sessionFile', () => {
    const built = buildPiAgentRuntimeDescriptorV1({
      resumeStrategy: 'sessionFileAbsolutePreferred',
      providerSessionId: 'pi-session-1',
      sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
    });

    expect(built).toEqual({
      v: 1,
      agentId: 'pi',
      agent: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        providerSessionId: 'pi-session-1',
        sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
      },
    });
  });

  it('canonicalizes absolute-preferred descriptors', () => {
    const canonical = readCanonicalPiAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'pi',
      agent: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        providerSessionId: ' pi-session-1 ',
        sessionFile: ' /tmp/pi/sessions/pi-session-1.jsonl ',
      },
    });

    expect(canonical).toEqual({
      agentId: 'pi',
      resumeStrategy: 'sessionFileAbsolutePreferred',
      providerSessionId: 'pi-session-1',
      sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
    });
  });

  it('keeps legacy by-session-id descriptors readable', () => {
    const canonical = readCanonicalPiAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'pi',
      agent: {
        resumeStrategy: 'sessionFileBySessionId',
        providerSessionId: 'pi-session-1',
      },
    });

    expect(canonical).toEqual({
      agentId: 'pi',
      resumeStrategy: 'sessionFileBySessionId',
      providerSessionId: 'pi-session-1',
      sessionFile: null,
    });
  });

  it('keeps legacy vendorSessionId descriptors readable', () => {
    const canonical = readCanonicalPiAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'pi',
      agent: {
        resumeStrategy: 'sessionFileBySessionId',
        vendorSessionId: 'legacy-pi-session',
      },
    });

    expect(canonical?.providerSessionId).toBe('legacy-pi-session');
  });

  it('fails closed for malformed or wrong-provider descriptors', () => {
    expect(readCanonicalPiAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'opencode',
      agent: {
        resumeStrategy: 'sessionFileBySessionId',
        providerSessionId: 'wrong-provider-session',
      },
    } as unknown as Parameters<typeof readCanonicalPiAgentRuntimeDescriptorV1>[0])).toBeNull();

    expect(readCanonicalPiAgentRuntimeDescriptorV1({
      v: 1,
      providerId: 'pi',
    } as unknown as Parameters<typeof readCanonicalPiAgentRuntimeDescriptorV1>[0])).toBeNull();
  });

  it('fails closed when canonical and deployed identity fields conflict', () => {
    expect(readCanonicalPiAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'pi',
      providerId: 'opencode',
      agent: { resumeStrategy: 'sessionFileBySessionId' },
    })).toBeNull();
  });
});
