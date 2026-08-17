import { describe, expectTypeOf, it } from 'vitest';

import type { AgentAcpRuntimeOptions } from './agent-runtime.js';
import type { ManagedExecutableRef } from './runtime/index.js';
/* @sdk-negative-type-case:src-manifest-agentAcpTransport-test-ts-207:LS0gQUNQIHRyYW5zcG9ydCBpcyBjb25zdW1lZCB0aHJvdWdoIEFnZW50QWNwUnVudGltZU9wdGlvbnMsIG5vdCBkdXBsaWNhdGVkIG9uIC9tYW5pZmVzdC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5BZ2VudEFjcFRyYW5zcG9ydCB9IGZyb20gJy4vbWFuaWZlc3QuanMnOw */
type PluginAgentAcpTransport = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-manifest-agentAcpTransport-test-ts-208:LS0gZXhlY3V0YWJsZSBsYXVuY2ggcmVmZXJlbmNlcyBhcmUgb3duZWQgYnkgYC9ydW50aW1lYCwgbm90IGAvbWFuaWZlc3RgLg:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkRXhlY3V0YWJsZVJlZiBhcyBNYW5pZmVzdE1hbmFnZWRFeGVjdXRhYmxlUmVmIH0gZnJvbSAnLi9tYW5pZmVzdC5qcyc7 */
type ManifestManagedExecutableRef = never; /* @sdk-negative-type-case-end */

void (undefined as unknown as PluginAgentAcpTransport);
void (undefined as unknown as ManifestManagedExecutableRef);

describe('ACP transport public types', () => {
  it('consumes the protocol-owned transport through the runtime option without a manifest duplicate', () => {
    const executable = {
      kind: 'systemTool',
      id: 'acme-agent',
    } satisfies ManagedExecutableRef;
    const transport = {
      kind: 'stdio',
      executable,
      args: ['acp'],
      timeouts: { initializeMs: 10_000 },
    } satisfies AgentAcpRuntimeOptions['transport'];

    expectTypeOf<ManagedExecutableRef>().toEqualTypeOf<import('./services/io.js').ManagedExecutableRef>();
    expectTypeOf<AgentAcpRuntimeOptions['transport']>()
      .toEqualTypeOf<import('@happier-dev/protocol').PluginAgentAcpTransport>();
    expectTypeOf(transport).toMatchTypeOf<AgentAcpRuntimeOptions['transport']>();
  });
});
