import { connect } from '@happier-dev/sdk';

const endpoint = process.env.HAPPIER_API_ENDPOINT;
const token = process.env.HAPPIER_TOKEN;
if (!endpoint) throw new Error('Set HAPPIER_API_ENDPOINT to the daemon HTTP origin.');
if (!token) throw new Error('Create an API Token in Settings and set HAPPIER_TOKEN.');

const happier = connect({ endpoint, token });
const agentId = process.env.HAPPIER_AGENT_ID?.trim() || 'codex';
try {
  const session = await happier.sessions.spawn({ directory: process.cwd(), agent: agentId });
  try {
    await session.sendAndWait('Say hello, then wait.', { timeoutSeconds: 300 });
    // Acquire and release one live transcript-follow lease; history is the finite result read.
    for await (const _item of session.followTranscript({ cursor: '0', maxItems: 1 })) break;
    const history = await session.history({ limit: 1, roles: ['assistant'], maxCharsPerMessage: 2_000 });
    if (!history.ok) throw new Error('Transcript history failed.');
    console.log(history.items.at(-1)?.text ?? '[assistant response]');
  } finally {
    await session.stop();
  }
} finally {
  await happier.close();
}
