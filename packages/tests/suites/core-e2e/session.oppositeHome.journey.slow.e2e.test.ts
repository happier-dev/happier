import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema, PromptDocReadResultV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { AccountSelfProfileV1Schema } from '@happier-dev/protocol/account/profile';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';

import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';

// MATRIX-1110 rows 46/78: the qualified Session owns its instructions and
// continuation even while a different, reachable Home and Account are focused.
// Native Search/Previous and phone geometry remain separate UI journeys.
it('L12.oppositeHome keeps qualified instructions and resumed turns on their owning Home', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'l12-opposite-home-'));
  const agent = await createIsolatedFakeClaudeControlShim({ testDir, invocationId: 'opposite-home',
    captureEnvironmentKeys: [], logFullStdin: true, captureStartupInstructions: true });
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let stopHome: (() => Promise<void>) | undefined;
  let other: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  try {
    // Distinct databases make these independent Homes, even under a runner that
    // supplies one ambient DATABASE_URL for its entire suite.
    await postgres.sql('happier', 'CREATE DATABASE opposite_home;');
    const otherDatabaseUrl = new URL(postgres.homeDatabaseUrl);
    otherDatabaseUrl.pathname = '/opposite_home';
    const home = await startProjectDaemonFixture({ testDir: join(testDir, 'session-home'),
      serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
    stopHome = () => home.stop();
    other = await startProjectDaemonFixture({ testDir: join(testDir, 'focused-home'),
      serverEnv: { DATABASE_URL: otherDatabaseUrl.href } });
    expect(other.serverId).not.toBe(home.serverId);
    const owner = await home.createAccount('session-owner');
    const focused = await other.createAccount('focused-person');
    const ownerId = readAccountIdFromToken(owner.auth.token);
    const focusedId = readAccountIdFromToken(focused.auth.token);
    if (!ownerId || !focusedId) throw new Error('Cross-Home fixture Account identities unavailable');
    expect(focusedId).not.toBe(ownerId);
    const machine = await home.enrollDaemon(owner, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
    const session = await home.assertKnownGoodSessionControl(owner, machine);
    const artifactId = randomUUID();
    const bronze = `BRONZE_${randomUUID()}`;
    const copper = `COPPER_${randomUUID()}`;
    const silver = `SILVER_${randomUUID()}`;
    for (const [account, marker] of [[owner, bronze], [focused, silver]] as const) {
      const created = await account.execute('artifact.create', { artifactId,
        header: PromptDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_doc.v2', title: 'Session instructions' }),
        body: JSON.stringify(PromptDocBodyV1Schema.parse({ v: 1, markdown: marker, createdAtMs: 1, updatedAtMs: 1 })),
      }, { presentUserConfirmation: { actionId: 'artifact.create' } });
      if (!created.ok) throw new Error(`Instructions creation refused: ${created.errorCode}`);
      expect(ArtifactActionOutputSchemasV1['artifact.create'].parse(created.result).artifactId).toBe(artifactId);
    }

    // Authenticate both real Homes through the person's UI flow. Closing A's
    // active connection retains its credentials, as switching Home does.
    ui = await connectUiPersonActionClient({ serverUrl: home.actionServerApiUrl, accountSecret: owner.auth.accountSigningSeed });
    await waitFor(() => ui!.isAccountReady());
    const sessionHomeId = ui.serverId;
    await ui.close();
    ui = await connectUiPersonActionClient({ serverUrl: other.actionServerApiUrl, accountSecret: focused.auth.accountSigningSeed });
    await waitFor(() => ui!.isAccountReady());
    expect(ui.serverId).not.toBe(sessionHomeId);
    const assertFocusedPerson = async () => {
      // An unqualified Action follows current focus, just as the person's next
      // Home action does. Observe its actual Account rather than seed UI state.
      const profile = await ui!.executeConfirmed('account.profile.get', {});
      if (!profile.ok) throw new Error(`Focused Account unavailable: ${profile.errorCode}`);
      expect(AccountSelfProfileV1Schema.parse(profile.result).id).toBe(focusedId);
    };
    await assertFocusedPerson();
    // A real read proves B is reachable, rather than a saved placeholder URL.
    const otherDoc = await ui.execute('prompt_doc.get', { artifactId });
    if (!otherDoc.ok) throw new Error(`Focused Home unavailable: ${otherDoc.errorCode}`);
    expect(PromptDocReadResultV1Schema.parse(otherDoc.result).markdown).toBe(silver);

    const revision = (await fetchSessionV2(home.server.baseUrl, owner.auth.token, session.sessionId)).metadataVersion;
    const context = { serverId: sessionHomeId, expectedAccountId: ownerId };
    const attached = await ui.execute('session.instructions.set', { serverId: sessionHomeId,
      sessionId: session.sessionId, expectedMetadataRevision: revision, ref: { kind: 'doc', artifactId } }, context);
    expect(attached).toMatchObject({ ok: true });
    await assertFocusedPerson();
    const original = await ui.execute('prompt_doc.get', { artifactId }, context);
    if (!original.ok) throw new Error(`Session Home document unavailable: ${original.errorCode}`);
    const originalDoc = PromptDocReadResultV1Schema.parse(original.result);
    expect(originalDoc.markdown).toBe(bronze);
    expect(await ui.executeConfirmed('prompt_doc.update', { artifactId, title: originalDoc.title,
      markdown: copper, expectedRevision: originalDoc.revision }, context)).toMatchObject({ ok: true });
    await assertFocusedPerson();
    const selected = await owner.readSessionMetadata(session.sessionId);
    expect(selected).toMatchObject({ machineId: machine.target.machineId, path: machine.workspaceDir,
      work: { promptStack: [expect.objectContaining({ id: 'session.instructions', ref: { kind: 'doc', artifactId } })] } });

    const send = async (phase: string) => {
      const message = `${phase}_${randomUUID()}`;
      const sent = await ui!.execute('session.message.send', { sessionId: session.sessionId, message, reply: 'wait' }, context);
      if (!sent.ok) throw new Error(`${phase} refused: ${sent.errorCode}`);
      const reply = SessionMessageSendResultV1Schema.parse(sent.result);
      expect(reply).toMatchObject({ status: 'replied', sessionId: session.sessionId,
        outcome: { kind: 'answer', text: expect.stringContaining('FAKE_CLAUDE_OK_') } });
      expect(await waitForFakeClaudeUserText(agent.logPath, text => text.includes(message))).toContain(message);
      await assertFocusedPerson();
    };
    await send('qualified-first-turn');
    expect(await ui.execute('session.stop', { sessionId: session.sessionId }, context)).toMatchObject({ ok: true });
    await waitFor(async () => !(await fetchSessionV2(home.server.baseUrl, owner.auth.token, session.sessionId)).active,
      { context: 'qualified Stop settles on Session Home' });
    expect(await ui.execute('session.open', { serverId: sessionHomeId, sessionId: session.sessionId, intent: 'resume' }, context))
      .toMatchObject({ ok: true });
    await send('qualified-resumed-turn');
    expect(await readFile(agent.logPath, 'utf8')).toContain(copper);
    expect(await readFile(agent.logPath, 'utf8')).not.toContain(bronze);
    expect(await readFile(agent.logPath, 'utf8')).not.toContain(silver);
    const unchanged = await ui.execute('prompt_doc.get', { artifactId });
    if (!unchanged.ok) throw new Error(`Focused instructions disappeared: ${unchanged.errorCode}`);
    expect(PromptDocReadResultV1Schema.parse(unchanged.result).markdown).toBe(silver);
    expect(await owner.readSessionMetadata(session.sessionId)).toMatchObject({ machineId: machine.target.machineId, path: machine.workspaceDir });
    await assertFocusedPerson();
  } finally {
    try { await ui?.close(); }
    finally {
      try { await other?.stop(); }
      finally {
        try { await stopHome?.(); }
        finally { await postgres.stop(); }
      }
    }
  }
}, 0);
