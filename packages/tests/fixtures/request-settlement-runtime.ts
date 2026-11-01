import { readFile } from 'node:fs/promises';

import type { Session } from '../../../apps/cli/src/api/types';
import { waitFor } from '../src/testkit/timing';

const input = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  phase: 'admit' | 'recover'; credentialMode: 'legacy' | 'tokenOnly';
  token: string; secret: number[]; session: Session; requestId: string;
};
process.stdout.write(`Runtime ${input.phase}: loading current CLI source\n`);
const { writeCredentialsLegacy, writeCredentialsTokenOnly } = await import('../../../apps/cli/src/persistence');
if (input.credentialMode === 'tokenOnly') await writeCredentialsTokenOnly({ token: input.token });
else await writeCredentialsLegacy({ token: input.token, secret: Uint8Array.from(input.secret) });
const { ApiSessionClient } = await import('../../../apps/cli/src/api/session/sessionClient');
const { AgentStateRequestStore } = await import('../../../apps/cli/src/agent/permissions/agentStateRequestStore');
process.stdout.write(`Runtime ${input.phase}: constructing session client\n`);
const client = new ApiSessionClient(input.token, input.session);
if (input.phase === 'admit') {
  const requests = new AgentStateRequestStore({ session: client, logPrefix: '[Settlement recovery test]' });
  // Both an already executed native tool (PostToolUse) and a retired waiter
  // must survive offline delivery independently of a pre-effect approval.
  await requests.completeRequest({
    requestId: input.requestId,
    ...(input.credentialMode === 'tokenOnly'
      ? { status: 'canceled', reason: 'runtime ended' }
      : { status: 'approved', decision: 'approved', observedCompletion: true }),
  });
  // Model the runtime ending immediately after durable admission, without a graceful flush.
  process.exit(0);
}
await waitFor(() => {
  const state = client.getAgentStateSnapshot();
  return state?.completedRequests?.[input.requestId]?.status === (input.credentialMode === 'tokenOnly' ? 'canceled' : 'approved')
    && state.requests?.[input.requestId] === undefined;
}, { timeoutMs: 60_000, context: 'recovered request settlement acknowledgement' });
await client.close();
process.exit(0);
