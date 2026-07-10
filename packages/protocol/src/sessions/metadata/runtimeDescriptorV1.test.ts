import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as runtimeDescriptorV1 from './runtimeDescriptorV1.js';
import {
  RuntimeDescriptorV1Schema,
  readCanonicalRuntimeDescriptorV1ForAgent,
  readRuntimeDescriptorV1ForAgent,
} from './runtimeDescriptorV1.js';

describe('runtimeDescriptorV1 aliases', () => {
  it('dispatches agent-specific canonical readers through generated contributions', () => {
    const source = readFileSync(new URL('./runtimeDescriptorV1.ts', import.meta.url), 'utf8');
    const contributionsSource = readFileSync(
      new URL('../../agents/generated/runtime/descriptorContributionsV1.ts', import.meta.url),
      'utf8',
    );
    const indexSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const obsoleteProviderDescriptorImport = (providerId: string) => `./${providerId}/runtimeDescriptorV1.js`;

    expect(source).toContain('../../agents/runtimeDescriptorContributionsV1.js');
    expect(contributionsSource).not.toContain('@happier-dev/plugins-');
    expect(contributionsSource).toContain('./descriptors/codex.js');
    expect(contributionsSource).toContain('./descriptors/opencode.js');
    expect(contributionsSource).toContain('./descriptors/pi.js');
    expect(contributionsSource).not.toContain(obsoleteProviderDescriptorImport('codex'));
    expect(contributionsSource).not.toContain(obsoleteProviderDescriptorImport('opencode'));
    expect(contributionsSource).not.toContain(obsoleteProviderDescriptorImport('pi'));
    expect(source).not.toMatch(/\b(Codex|Pi)AgentRuntimeDescriptorV1\b/);
    expect(source).not.toMatch(/\bbuild(Codex|Pi)AgentRuntimeDescriptorV1\b/);
    expect(source).not.toMatch(/\bbuild(Codex|Pi)RuntimeIdentityDescriptorV1\b/);
    expect(source).not.toMatch(/switch\s*\(\s*providerId\s*\)/);
    expect(indexSource).not.toContain(`from '${obsoleteProviderDescriptorImport('pi').replace('./', './providers/')}'`);
    expect(indexSource).not.toMatch(/\b(Codex|Pi)AgentRuntimeDescriptorV1\b/);
    expect(indexSource).not.toMatch(/\bbuild(Codex|Pi)AgentRuntimeDescriptorV1\b/);
    expect(indexSource).not.toMatch(/\bbuild(Codex|Pi)RuntimeIdentityDescriptorV1\b/);
    expect(indexSource).not.toContain('readCanonicalPiAgentRuntimeDescriptorV1');
  });

  it('does not expose OpenCode-specific descriptor helpers from protocol', () => {
    expect(Object.hasOwn(runtimeDescriptorV1, 'buildOpenCodeAgentRuntimeDescriptorV1')).toBe(false);
    expect(Object.hasOwn(runtimeDescriptorV1, 'buildOpenCodeRuntimeIdentityDescriptorV1')).toBe(false);
    expect(Object.hasOwn(runtimeDescriptorV1, 'readCanonicalOpenCodeAgentRuntimeDescriptorV1')).toBe(false);
  });

  it('keeps generated plugin protocol codecs independent from the protocol package root', () => {
    const pluginProtocolSources = [
      '../../../../../packages/plugins/codex/src/protocol/runtimeDescriptorV1.ts',
      '../../../../../packages/plugins/opencode/src/protocol/runtimeDescriptorV1.ts',
      '../../../../../packages/plugins/pi/src/protocol/runtimeDescriptorV1.ts',
    ];

    for (const sourcePath of pluginProtocolSources) {
      const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
      expect(source).not.toContain("from '@happier-dev/protocol'");
      expect(source).not.toContain('from "@happier-dev/protocol"');
    }
  });

  it('parses runtime descriptors through canonical runtime naming', () => {
    const built = {
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_1',
      },
    };

    const parsed = RuntimeDescriptorV1Schema.parse({
      ...built,
      futureRuntimeDescriptorFlag: 'keep-me',
    });

    expect(parsed).toMatchObject({
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_1',
      },
    });
    expect(parsed).toHaveProperty('futureRuntimeDescriptorFlag', 'keep-me');
  });

  it('reads agent-scoped runtime descriptor envelopes without owning agent-specific helpers', () => {
    const built = {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'sess_1',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      },
    };

    expect(readRuntimeDescriptorV1ForAgent(built, 'opencode')).toMatchObject({
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'sess_1',
      },
    });
  });

  it('reads canonical runtime descriptor facts through canonical runtime naming', () => {
    expect(readCanonicalRuntimeDescriptorV1ForAgent({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_1',
      },
    }, 'codex')).toEqual({
      agentId: 'codex',
      backendMode: 'appServer',
      providerSessionId: 'thread_1',
      home: null,
      connectedServiceId: null,
      connectedServiceProfileId: null,
      connectedServiceGroupId: null,
      homePath: null,
    });
  });

  it('clears OpenCode explicit server URL state when generated protocol dispatch rejects the URL', () => {
    expect(readCanonicalRuntimeDescriptorV1ForAgent({
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'opencode-session-1',
        serverBaseUrl: 'http://example.com:4096',
        serverBaseUrlExplicit: true,
      },
    }, 'opencode')).toEqual({
      agentId: 'opencode',
      backendMode: 'server',
      providerSessionId: 'opencode-session-1',
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    });
  });

  it('accepts legacy vendorSessionId runtime descriptor input as read-only compatibility', () => {
    expect(readCanonicalRuntimeDescriptorV1ForAgent({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        vendorSessionId: 'legacy-thread',
      },
    }, 'codex')).toEqual({
      agentId: 'codex',
      backendMode: 'appServer',
      providerSessionId: 'legacy-thread',
      home: null,
      connectedServiceId: null,
      connectedServiceProfileId: null,
      connectedServiceGroupId: null,
      homePath: null,
    });
  });

  it('keeps Codex connected-service group affinity in canonical runtime descriptors', () => {
    const built = {
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_1',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'team',
        homePath: '/tmp/connected/__groups/team/codex/codex-home',
      },
    };

    expect(readCanonicalRuntimeDescriptorV1ForAgent(built, 'codex')).toMatchObject({
      agentId: 'codex',
      backendMode: 'appServer',
      providerSessionId: 'thread_1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: null,
      connectedServiceGroupId: 'team',
      homePath: '/tmp/connected/__groups/team/codex/codex-home',
    });
  });

  it('ignores unowned Codex agent-extra overrides in generated protocol dispatch', () => {
    expect(readCanonicalRuntimeDescriptorV1ForAgent({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'canonical-thread',
        agentExtra: {
          owner: 'other-provider',
          schemaId: 'other-provider.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            backendMode: 'acp',
            providerSessionId: 'forged-thread',
          },
        },
      },
    }, 'codex')).toMatchObject({
      agentId: 'codex',
      backendMode: 'appServer',
      providerSessionId: 'canonical-thread',
    });
  });
});
