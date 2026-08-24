import { connect, type HappierTranscriptItem } from '@happier-dev/sdk';

const endpoint = process.env.HAPPIER_API_ENDPOINT;
const token = process.env.HAPPIER_TOKEN;
if (!endpoint || !token) {
  throw new Error('Set HAPPIER_API_ENDPOINT and HAPPIER_TOKEN.');
}

const account = connect({ endpoint, token });
const endpointMode = process.env.HAPPIER_ENDPOINT_MODE?.trim();
if (endpointMode !== 'daemon' && endpointMode !== 'server') {
  throw new Error('Set HAPPIER_ENDPOINT_MODE to daemon or server.');
}

const agentId = process.env.HAPPIER_AGENT_ID?.trim() || 'codex';
const workspacePath = process.env.HAPPIER_WORKSPACE_PATH?.trim() || process.cwd();

const happier = endpointMode === 'daemon'
  ? account
  : account.machine(process.env.HAPPIER_MACHINE_ID?.trim() || await (async () => {
    const machines = await account.machines.list();
    const selected = machines.find((machine) => (
      machine.active && machine.revokedAt === null && machine.replacedByMachineId === null
    ));
    if (!selected) throw new Error('No active machine is available.');
    return selected.id;
  })());
try {
  const session = await happier.sessions.spawn({
    directory: workspacePath,
    agent: agentId,
    initialMessage: 'Say hello, then wait.',
  });
  try {
    await session.waitForIdle({ timeoutSeconds: 300 });

    const followedTranscript: HappierTranscriptItem[] = [];
    for await (const item of session.followTranscript({ cursor: '0', maxItems: 10 })) {
      followedTranscript.push(item);
      break;
    }

    await session.send('Please confirm that you are finished.');
    await session.waitForIdle({ timeoutSeconds: 300 });
    console.log(JSON.stringify({
      sessionId: session.id,
      followedTranscript,
      transcript: await session.history({ limit: 10 }),
    }));
  } finally {
    await session.stop();
  }
} finally {
  account.close();
}
