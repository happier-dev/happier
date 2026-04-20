import { runHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

import { createCodexSessionRuntime } from '../runtime/session/createSessionRuntime';

export { createCodexSessionRuntime } from '../runtime/session/createSessionRuntime';

export async function runCodex(opts: Parameters<typeof createCodexSessionRuntime>[0]): Promise<void> {
    await runHostSessionRuntimePlan(createCodexSessionRuntime(opts));
}
