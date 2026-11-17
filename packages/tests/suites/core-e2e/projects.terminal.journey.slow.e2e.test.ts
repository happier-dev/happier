import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { DaemonTerminalEnsureResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectOrganizationUpdateOutputV1Schema } from '@happier-dev/protocol/projects/projectOrganizationV1';
import { TerminalStreamInputResponseSchema } from '@happier-dev/protocol/terminal/input';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { ProjectManifestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { connectUiPersonActionClient, mountUiRetainedProjectTerminal } from '@happier-tests/ui-action-client';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

// Xterm is the external DOM renderer. Real terminal admission, transport,
// stream decoding, preview retention and Account retirement remain mounted.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', async () => {
  const React = await import('react');
  return { XtermTerminalView: React.forwardRef(function JourneyRenderer(
    props: { onReady(cols: number, rows: number): void }, ref) {
    React.useImperativeHandle(ref, () => ({ write: () => true, writeBytes: () => true, clear() {}, focus() {} }), []);
    React.useEffect(() => { props.onReady(80, 24); }, [props.onReady]);
    return React.createElement('JourneyTerminalRenderer');
  }) };
});

let fixture: ProjectDaemonFixture | undefined;
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
afterAll(async () => {
  try { await fixture?.stop(); }
  finally { await database?.stop(); }
}, 0);

// The fixture's POSIX check command uses the Linux core-e2e host's sha256sum.
it.skipIf(process.platform !== 'linux')('L12 row94: a bound Project terminal receives its saved Secret again after Restart without disclosing its value', async () => {
  database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startProjectDaemonFixture({ testDir: createRunDirs({ runLabel: 'core' }).testDir(`project-terminal-journey-${randomUUID()}`),
    dbProvider: 'postgres', serverEnv: { ...process.env, DATABASE_URL: database.homeDatabaseUrl } });
  const owner = await fixture.createAccount('project-terminal-owner');
  const machine = await fixture.enrollDaemon(owner);
  const secretValue = randomBytes(32).toString('hex');
  const digest = createHash('sha256').update(secretValue).digest('hex');
  await mkdir(join(machine.workspaceDir, '.happier'));
  await Promise.all([
    writeFile(join(machine.workspaceDir, '.happier/project.json'), JSON.stringify(ProjectManifestV1Schema.parse({
      version: 1, environmentVariables: [{ name: 'L12_TERMINAL_SECRET', kind: 'secret', required: true }],
    }))),
    // The shell compares a digest and emits only the outcome. Neither the typed
    // input, terminal echo, nor assertion diagnostics need the saved value.
    writeFile(join(machine.workspaceDir, 'check-secret.sh'),
      `actual=$(printf '%s' "$L12_TERMINAL_SECRET" | sha256sum)\n` +
      `if [ "\${actual%% *}" = '${digest}' ]; then printf 'PROJECT_SECRET_PRESENT:%s\\n' "$1"; exit 0; fi\n` +
      `printf 'PROJECT_SECRET_MISSING\\n'; exit 41\n`),
  ]);
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: owner.auth.accountSigningSeed });
  let retained: Awaited<ReturnType<typeof mountUiRetainedProjectTerminal>> | undefined;
  try {
    const action = async (actionId: ActionId, input: unknown) => {
      const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture!.serverId,
        actionRequestId: randomUUID() });
      if (!result.ok) throw new Error(`${actionId} refused (${result.errorCode})`);
      return result.result;
    };
    const opened = OpenProjectResultV1Schema.parse(await action('projects.open', { ...machine.target,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } }));
    if (opened.kind !== 'opened' || !opened.facts?.projectKey) throw new Error(`Project did not open (${JSON.stringify(opened)})`);
    if (opened.workspace.kind === 'managed') throw new Error('Attached folder must use the enrolled Machine checkout');
    const saved = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(await action('secrets.create', {
      name: 'Project terminal requirement', kind: 'token', value: secretValue,
    }));
    // Select the saved catalog entry as the person would. Shared references
    // carry the catalog revision; creation's acknowledgement contains only IDs.
    const catalog = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.list'].parse(
      await action('secrets.list', { secretId: saved.secretId }));
    const selectedSecret = catalog.secrets.find(secret => secret.secretId === saved.secretId);
    if (!selectedSecret) throw new Error('Created terminal Secret is absent from its catalog');
    expect(selectedSecret.secretRef).toBe(saved.secretRef);
    // Fresh Account; Open accepts the workspace row, leaving organization absent.
    const bound = ProjectOrganizationUpdateOutputV1Schema.parse(await action('projects.organization.update', {
      projectRef: { serverId: fixture.serverId, projectKey: opened.facts.projectKey }, expectedRevision: 'absent',
      environmentBinding: { name: 'L12_TERMINAL_SECRET', reference: { ref: saved.secretRef, revision: selectedSecret.updatedAt } },
    }));
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error(`Project binding refused (${bound.errorCode})`);

    const request = { ...machine.target, workspace: opened.workspace, terminalKey: randomUUID() };
    const initial = DaemonTerminalEnsureResponseSchema.parse(await action('machines.terminal.open', request));
    if (!initial.ok) throw new Error(`Project terminal refused (${initial.errorCode})`);
    const assertSecret = async (terminalId: string, phase: string) => {
      const written = TerminalStreamInputResponseSchema.parse(await action('machines.terminal.write', {
        ...machine.target, terminalId, event: { t: 'text', text: `exec sh ./check-secret.sh ${phase}\r` },
      }));
      if (!written.ok) throw new Error(`${phase} command refused (${written.code})`);
      let byteOffset = 0;
      let controlCursor = 0;
      let output = '';
      let exitCode: number | null | undefined;
      await waitFor(async () => {
        const read = TerminalStreamReadResponseSchema.parse(await action('machines.terminal.read', {
          ...machine.target, terminalId, byteOffset, controlCursor,
        }));
        if (!read.ok) throw new Error(`${phase} output refused (${read.code})`);
        byteOffset = read.nextByteOffset;
        controlCursor = read.nextControlCursor ?? controlCursor;
        for (const frame of read.frames) {
          if (frame.t === 'bytes') output += Buffer.from(decodeTerminalStreamBytesFrame(frame)).toString('utf8');
          if (frame.t === 'exit') exitCode = frame.exitCode;
        }
        return read.done && exitCode !== undefined;
      }, { context: `${phase} Project shell command exits`, failFast: true });
      // Assert booleans for secrecy: a regression must not print the value even
      // through a failing assertion's received-output diagnostic.
      expect(output.includes(secretValue), `${phase} must keep Secret out of output`).toBe(false);
      expect(output.includes(`PROJECT_SECRET_PRESENT:${phase}`), `${phase} receives the bound Secret`).toBe(true);
      expect(exitCode, `${phase} shell command succeeds`).toBe(0);
    };
    await assertSecret(initial.terminalId, 'Open');
    const restarted = DaemonTerminalEnsureResponseSchema.parse(await action('machines.terminal.restart', request));
    if (!restarted.ok) throw new Error(`Project terminal Restart refused (${restarted.errorCode})`);
    await assertSecret(restarted.terminalId, 'Restart');

    // A04: the retained Project host reaches the same real daemon, then keeps
    // its private preview only for the captured Account while hidden.
    retained = await mountUiRetainedProjectTerminal(opened.workspace);
    await waitFor(() => retained!.ready(), { context: 'Project Shell discovery publishes the New control' });
    await retained.open();
    await waitFor(() => Boolean(retained?.read().surface?.terminalId), { context: 'mounted Project terminal acquires its actual PTY' });
    const retainedTerminalId = retained.read().surface!.terminalId!;
    const marker = `A04_PRIVATE_${randomUUID()}`;
    expect(TerminalStreamInputResponseSchema.parse(await action('machines.terminal.write', {
      ...machine.target, terminalId: retainedTerminalId, event: { t: 'text', text: `printf '${marker}\\n'\r` },
    })).ok).toBe(true);
    await waitFor(() => retained!.read().surface?.output.includes(marker) === true,
      { context: 'native Project output reaches the mounted private preview' });
    const originalText = retained.text();
    await retained.setPresented(false);
    const renamed = `A04 renamed ${randomUUID()}`;
    await action('machines.metadata.update', { ...machine.target, patch: { displayName: renamed } });
    await waitFor(() => retained!.machineName() === renamed, { context: 'Machine rename push reaches the hidden Project Account store' });
    // The hidden label holds its last presented value. Reveal joins the real
    // metadata push rather than preserving a permanently stale label.
    expect(retained.text()).toBe(originalText);
    await retained.setPresented(true);
    await waitFor(() => retained!.text().includes(renamed), { context: 'revealed Project terminal shows the pushed Machine name' });
    expect(retained.read().surface?.terminalId).toBe(retainedTerminalId);
    expect(retained.read().surface?.output.includes(marker)).toBe(true);
    await retained.setPresented(false);
    expect(await action('account.signOut', { serverId: ui.serverId, accountId: retained.accountId }))
      .toMatchObject({ status: 'signed_out' });
    await waitFor(() => !retained!.read().current && retained!.read().tabs.length === 0,
      { context: 'Account withdrawal retires the hidden Project workspace' });
    // The native PTY belongs to the Machine and survives this UI Account's
    // retirement. Later native output must not refill the retired preview.
    const afterRetirement = `A04_AFTER_RETIREMENT_${randomUUID()}`;
    const writtenAfterRetirement = await owner.executeReviewed('machines.terminal.write', {
      ...machine.target, terminalId: retainedTerminalId, event: { t: 'text', text: `printf '${afterRetirement}\\n'\r` },
    });
    if (!writtenAfterRetirement.ok) throw new Error(`Native Shell after UI withdrawal refused (${writtenAfterRetirement.errorCode})`);
    expect(TerminalStreamInputResponseSchema.parse(writtenAfterRetirement.result).ok).toBe(true);
    await waitFor(async () => {
      const result = await owner.executeReviewed('machines.terminal.read', { ...machine.target,
        terminalId: retainedTerminalId, byteOffset: 0, controlCursor: 0 });
      if (!result.ok) throw new Error(`Native output after UI withdrawal refused (${result.errorCode})`);
      const read = TerminalStreamReadResponseSchema.parse(result.result);
      return read.ok && read.frames.some(frame => frame.t === 'bytes'
        && Buffer.from(decodeTerminalStreamBytesFrame(frame)).toString('utf8').includes(afterRetirement));
    }, { context: 'Machine Shell produces output after the private UI scope retired', failFast: true });
    expect(retained.read().surface?.output ?? '').toBe('');
    expect(retained.read().summary).toBeNull();
    await retained.setPresented(true);
    expect(retained.text().includes(marker)).toBe(false);
    expect(retained.read().tabs).toEqual([]);
  } finally {
    try { await retained?.close(); }
    finally { await ui.close(); }
  }
}, 0);
