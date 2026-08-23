import { connect } from '@happier-dev/sdk';

const endpoint = process.env.HAPPIER_API_ENDPOINT;
const token = process.env.HAPPIER_TOKEN;
if (!endpoint || !token) {
  throw new Error('Set HAPPIER_API_ENDPOINT and HAPPIER_TOKEN.');
}

const account = connect({ endpoint, token });
const configuredMachineId = process.env.HAPPIER_MACHINE_ID?.trim();
const agentId = process.env.HAPPIER_AGENT_ID?.trim() || 'codex';
const workspacePath = process.env.HAPPIER_WORKSPACE_PATH?.trim() || process.cwd();

const machineId = configuredMachineId || await (async () => {
  const machines = await account.machines.list();
  const selected = machines.find((machine) => (
    machine.active && machine.revokedAt === null && machine.replacedByMachineId === null
  ));
  if (!selected) throw new Error('No active machine is available.');
  return selected.id;
})();
const happier = account.machine(machineId);
try {
  const session = await happier.sessions.spawn({
    directory: workspacePath,
    agent: agentId,
    initialMessage: 'Say hello, then wait.',
  });
  try {
    await session.waitForIdle({ timeoutSeconds: 300 });
    await session.send('Please confirm that you are finished.');
    await session.waitForIdle({ timeoutSeconds: 300 });
    console.log(JSON.stringify({
      sessionId: session.id,
      transcript: await session.history({ limit: 10 }),
    }));
  } finally {
    await session.stop();
  }
} finally {
  account.close();
}
