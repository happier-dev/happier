import { mergeConfig } from 'vitest/config';
import sdkSourceConfig from '../plugin-sdk/vitest.source.config.ts';

// Accounting integrations must read the moving public SDK, not bundled copies.
export default mergeConfig(sdkSourceConfig, {
  test: { include: [
    'packages/plugins/{claude,codex,opencode}/src/agent/usage/*.test.ts',
    'packages/plugins/pi/src/agent/externalSessions/accounting.test.ts',
    'packages/plugins/pi/src/agent/runtime/rpc/usage.test.ts',
    'packages/plugins/opencode/src/agent/runtime/server/runtimeController.nativeInteractions.test.ts',
    'packages/plugins/claude/src/agent/runtime/nativeRuntime.test.ts',
    'packages/plugins/claude/src/agent/runtime/remote/sdk/session.test.ts',
    'packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations.test.ts',
    'packages/plugin-sdk/src/sessions/fileStores/accountingJsonl.test.ts',
    'packages/protocol/src/runtime/agentSessionV1.test.ts',
  ] },
});
