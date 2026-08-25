import {
  connect,
  HappierSessionInitialInputError,
  type HappierSession,
} from '@happier-dev/sdk';

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
    const eligibleMachines = machines.filter((machine) => (
      machine.active && machine.revokedAt === null && machine.replacedByMachineId === null
    ));
    const [selectedMachine] = eligibleMachines;
    if (!selectedMachine) {
      throw new Error('No eligible active machine is available.');
    }
    if (eligibleMachines.length > 1) {
      const candidateIds = eligibleMachines.map((machine) => machine.id).join(', ');
      throw new Error(
        `Multiple eligible active machines are available (${candidateIds}). Set HAPPIER_MACHINE_ID to the intended machine id.`,
      );
    }
    return selectedMachine.id;
  })());
try {
  let session: HappierSession;
  try {
    session = await happier.sessions.spawn({
      directory: workspacePath,
      agent: agentId,
      initialMessage: 'Say hello, then wait.',
    });
  } catch (error) {
    if (error instanceof HappierSessionInitialInputError) {
      await error.session.stop();
    }
    throw error;
  }

  try {
    await session.waitForIdle({ timeoutSeconds: 300 });

    let followedItemCount = 0;
    for await (const _item of session.followTranscript({ cursor: '0', maxItems: 10 })) {
      followedItemCount += 1;
      break;
    }

    await session.sendAndWait('Please confirm that you are finished.', {
      localId: 'confirm-finished',
      timeoutSeconds: 300,
    });
    const history = await session.history({
      limit: 3,
      roles: ['user', 'assistant'],
      maxCharsPerMessage: 160,
    });
    const historyItems = history.ok && 'diagnostics' in history
      ? history.items.map((item) => ({
          id: item.id,
          role: item.role,
          kind: item.kind,
          text: item.text ?? null,
        }))
      : [];
    console.log(JSON.stringify({
      sessionId: session.id,
      followedItemCount,
      historyOk: history.ok,
      history: historyItems,
    }));
  } finally {
    await session.stop();
  }
} finally {
  account.close();
}
