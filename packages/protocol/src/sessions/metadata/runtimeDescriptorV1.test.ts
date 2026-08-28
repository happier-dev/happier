import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as runtimeDescriptorV1 from './runtimeDescriptorV1.js';
import {
  RuntimeDescriptorV1Schema,
  readRuntimeDescriptorV1ForAgent,
  writeRuntimeDescriptorV1ForPersistence,
} from './runtimeDescriptorV1.js';

describe('runtimeDescriptorV1 aliases', () => {
  it('keeps canonical descriptor custody generic instead of dispatching bundled readers', () => {
    const source = readFileSync(new URL('./runtimeDescriptorV1.ts', import.meta.url), 'utf8');
    const indexSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const obsoleteProviderDescriptorImport = (providerId: string) => `./${providerId}/runtimeDescriptorV1.js`;

    expect(source).not.toContain('runtimeDescriptorContributionsV1');
    expect(source).not.toContain('getGeneratedRuntimeDescriptorContributionV1');
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

  it('reads legacy flat Oh My Pi runtime identity and persists only the structured contribution identity', () => {
    const runtimeDescriptor = RuntimeDescriptorV1Schema.parse({
      v: 1,
      agentId: 'ohMyPi',
      agent: {
        backendMode: 'acp',
        providerSessionId: 'omp-session-1',
      },
    });

    const persisted = writeRuntimeDescriptorV1ForPersistence(runtimeDescriptor);
    expect(persisted).toEqual({
      v: 1,
      agentIdentity: {
        pluginId: 'happier.agent.ohmypi',
        localId: 'ohmypi',
      },
      agent: {
        backendMode: 'acp',
        providerSessionId: 'omp-session-1',
      },
    });
    expect(RuntimeDescriptorV1Schema.parse(persisted)).toEqual(runtimeDescriptor);
    expect(persisted).not.toHaveProperty('agentId');
  });
});
