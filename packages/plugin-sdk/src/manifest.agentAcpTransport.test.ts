import { describe, expectTypeOf, it } from 'vitest';

import type { AgentAcpRuntimeOptions } from './agent-runtime.js';
import type { ManagedExecutableRef } from './runtime/index.js';
// @ts-expect-error -- ACP transport is consumed through AgentAcpRuntimeOptions, not duplicated on /manifest.
import type { PluginAgentAcpTransport } from './manifest.js';
// @ts-expect-error -- executable launch references are owned by `/runtime`, not `/manifest`.
import type { ManagedExecutableRef as ManifestManagedExecutableRef } from './manifest.js';

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
