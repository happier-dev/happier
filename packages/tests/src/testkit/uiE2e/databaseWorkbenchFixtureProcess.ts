import { once } from 'node:events';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

import { startDatabaseWorkbenchInsightsFixture } from '../databaseWorkbench';

type Fixture = Awaited<ReturnType<typeof startDatabaseWorkbenchInsightsFixture>>;
type CompleteTerminalConnect = NonNullable<Parameters<typeof startDatabaseWorkbenchInsightsFixture>[0]['completeTerminalConnect']>;

export type WorkbenchFixtureRequest =
  | { kind: 'start'; testDir: string }
  | { kind: 'approved' }
  | { kind: 'connect'; label: string }
  | { kind: 'sql'; database: string; input: string };

export type WorkbenchFixtureReply =
  | { kind: 'pair'; options: Omit<Parameters<CompleteTerminalConnect>[0], 'waitForSuccess'> }
  | { kind: 'ready'; scope: Fixture['scope']; runtime: Fixture['runtime'] }
  | { kind: 'connected' }
  | { kind: 'sql'; output: string }
  | { kind: 'failed'; error: string };

export async function serveDatabaseWorkbenchFixture(path: string) {
  const socket = createConnection({ path });
  await once(socket, 'connect');
  const messages = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const send = (reply: WorkbenchFixtureReply) => {
    if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
  };
  const receive = async (): Promise<WorkbenchFixtureRequest | undefined> => {
    const message = await messages.next();
    return message.done ? undefined : JSON.parse(message.value);
  };

  let fixture: Fixture | undefined;
  try {
    const start = await receive();
    if (start?.kind !== 'start') return;
    fixture = await startDatabaseWorkbenchInsightsFixture({
      testDir: start.testDir,
      async completeTerminalConnect({ waitForSuccess, ...options }) {
        send({ kind: 'pair', options });
        if ((await receive())?.kind !== 'approved') throw new Error('Browser closed during Terminal Connect');
        await waitForSuccess();
      },
    });
    send({ kind: 'ready', scope: fixture.scope, runtime: fixture.runtime });
    for (let request = await receive(); request; request = await receive()) {
      if (request.kind === 'connect') {
        await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, request.label);
        send({ kind: 'connected' });
      } else if (request.kind === 'sql') {
        send({ kind: 'sql', output: await fixture.postgres.sql(request.database, request.input) });
      }
    }
  } catch (error) {
    send({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
  } finally {
    try {
      await fixture?.stop();
    } finally {
      await messages.return?.();
      socket.end();
    }
  }
}
