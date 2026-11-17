import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect as uiExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestPublicSettlementSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationOwnStatusV1Schema } from '@happier-dev/protocol/machines/agentIsolationV1';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agentInstallJobs';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { buildMemberAgentExecutionPath } from '../../../../apps/cli/src/capabilities/installJobs/memberInstallEnvironment';
import { createRunDirs } from '../../src/testkit/runDir';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createIsolatedFakeClaudeControlShim, fakeClaudeEchoResponseText, fakeClaudeFixturePath, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { waitFor } from '../../src/testkit/timing';

// This variant changes real OS accounts and sudoers through Machine Setup. It
// belongs on a disposable host with an installed Happier payload, never on an
// ordinary developer or CI host. No same-UID fallback can prove this contract.
const realUid = process.env.HAPPIER_RUN_REAL_UID_INTEGRATION === '1';

it.skipIf(!realUid)('MACH-J3 separate users: member install and Git cross the real worker UID/environment boundary', async () => {
  const startedAt = performance.now();
  expect(process.platform).toBe('linux');
  const binary = process.env.HAPPIER_TEST_MEMBER_CLI_BINARY;
  if (!binary) throw new Error('Supply HAPPIER_TEST_MEMBER_CLI_BINARY: the installed current-source Happier executable on a disposable host');
  const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
  if (!databaseUrl) throw new Error('Supply the canonical disposable PostgreSQL harness URL');
  const run = createRunDirs({ runLabel: 'core' });
  const testDir = run.testDir(`member-journey-${randomUUID()}`);
  const fixture = await startTeamSetupFFixture({ testDir, serverEnv: { DATABASE_URL: databaseUrl } });
  let browser: Browser | undefined;
  let ui: StartedUiWeb | undefined;
  let member: Awaited<ReturnType<typeof fixture.createAccount>> | undefined;
  let sessionId: string | undefined;
  let repo: string | undefined;
  let workspaceGit: string | undefined;
  let memberIdentity: { uid: number; gid: number } | undefined;
  let ownershipChanged = false;
  let vendorDir: string | undefined;
  let primaryFailure: { error: unknown } | undefined;
  try {
    // Only the external Agent is a fixture. Its small copied closure lets the
    // real member process run without traversing the host's private checkout.
    vendorDir = await mkdtemp(join(tmpdir(), 'happier-member-agent-'));
    const invocationId = randomUUID();
    const vendor = await createIsolatedFakeClaudeControlShim({ testDir: vendorDir, invocationId,
      captureEnvironmentKeys: [], logFullStdin: true });
    const fixtureDir = dirname(fakeClaudeFixturePath());
    await mkdir(join(vendorDir, 'fixtures'));
    await mkdir(join(vendorDir, 'testkit'));
    for (const name of ['fake-claude-code-cli.cjs', 'fake-claude-code-cli.helpers.cjs']) {
      await copyFile(join(fixtureDir, name), join(vendorDir, 'fixtures', name));
    }
    await copyFile(join(fixtureDir, '../testkit/claudeProjectId.cjs'), join(vendorDir, 'testkit/claudeProjectId.cjs'));
    const shim = await readFile(vendor.executablePath, 'utf8');
    await writeFile(vendor.executablePath, shim.replace(pathToFileURL(fakeClaudeFixturePath()).href,
      pathToFileURL(join(vendorDir, 'fixtures/fake-claude-code-cli.cjs')).href));
    await chmod(vendorDir, 0o755);
    await chmod(vendor.executablePath, 0o644);
    await writeFile(vendor.logPath, '', { mode: 0o644 });
    const owner = await fixture.createAccount('member-journey-owner');
    member = await fixture.createAccount('member-journey-member');
    await fixture.claimHomeOwner(owner);
    const machine = await fixture.enrollDaemon(owner, { cliLaunchSpec: { command: binary, args: [] },
      env: { HAPPIER_CLAUDE_PATH: vendor.executablePath } });
    workspaceGit = join(machine.workspaceDir, '.git');
    const target = { externalActionTarget: { kind: 'machine' as const, ...machine.target } };
    async function action(actor: typeof owner, id: ActionId, input: unknown,
      context: Partial<ActionExecutorContext> = target) {
      const spec = getActionSpec(id);
      const response = spec.surfaces.ui ? await actor.executeAsPerson(id, input, context)
        : await actor.execute(id, input, context);
      expect(response, `${id}: ${JSON.stringify(response)}`).toMatchObject({ ok: true });
      if (!response.ok) throw new Error(`${id}: ${response.errorCode}`);
      let result = response.result;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result);
      if (approval.success) {
        // The person approves through the real UI Action ingress; read the
        // public settlement rather than replaying an in-process dispatcher.
        expect(await actor.executeAsPerson('approval.request.decide', {
          artifactId: approval.data.artifactId, decision: 'approve',
        })).toMatchObject({ ok: true });
        const read = await actor.executeAsPerson('approval.request.get', { artifactId: approval.data.artifactId });
        expect(read).toMatchObject({ ok: true });
        if (!read.ok) throw new Error(`Approval read failed: ${read.errorCode}`);
        const outputSchema = getActionSpec('approval.request.get').outputSchema;
        if (!outputSchema) throw new Error('Approval read has no canonical output schema');
        const stored = outputSchema.parse(read.result);
        if (!stored || typeof stored !== 'object' || !('request' in stored)) throw new Error('Approval settlement missing');
        const execution = ApprovalRequestPublicSettlementSchema.parse(stored.request).execution;
        expect(execution).toMatchObject({ ok: true });
        if (!execution.ok) throw new Error(`${id}: ${execution.errorCode}`);
        result = execution.result;
      }
      // The real declaration, not a hand-built result fixture, owns the shape.
      const schema = spec.outputSchema;
      return schema ? schema.parse(result) : result;
    }
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await action(owner, 'machines.agentIsolation.preview', {
      ...machine.target, enabled: true, memberProvisioning: 'linuxUsersV1',
    }));
    expect(preview).toMatchObject({ kind: 'ready' });
    if (preview.kind !== 'ready') throw new Error('Separate-user setup did not produce its review');
    expect(await action(owner, 'machines.agentIsolation.set', { ...machine.target, enabled: true,
      memberProvisioning: 'linuxUsersV1', expectedPolicy: preview.policy,
      expectedMetadataVersion: preview.metadataVersion, expectedPlanDigest: preview.plan.planDigest,
    })).toMatchObject({ kind: expect.stringMatching(/^(accepted|unchanged)$/) });

    const team = TeamSummaryV1Schema.parse(await action(owner, 'teams.create', { v: 1, name: 'Separate users journey',
      initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token), requestKey: randomUUID() }));
    await action(owner, 'teams.members.add', { v: 1, teamId: team.id,
      accountId: readAccountIdFromToken(member.credentials.token), role: 'member', historyAccess: 'all_existing' });
    await action(owner, 'machines.access.grant.set', { ...machine.target,
      principal: { kind: 'team', teamId: team.id }, level: 'view' });
    expect(await action(owner, 'machines.access.prepareKeys', machine.target)).toMatchObject({ kind: 'prepared' });
    expect(await action(member, 'machines.access.grants.list', machine.target)).toMatchObject({ access: { accessState: 'ready' } });

    const installed = DaemonAgentInstallStartResponseSchema.parse(await action(member, 'machines.agents.install', {
      machineId: machine.target.machineId, agentId: 'opencode', intent: 'install', waitForTerminal: true,
    }));
    expect(installed).toMatchObject({ ok: true, executionScope: 'member' });
    if (!installed.ok) throw new Error(`Member install failed: ${installed.errorCode}`);
    expect(await action(member, 'machines.agents.install.status', {
      machineId: machine.target.machineId, jobId: installed.jobId, cursor: 0, waitForTerminal: true,
    })).toMatchObject({ ok: true, done: true, outcome: { kind: 'succeeded' } });
    const protection = MachineAgentIsolationOwnStatusV1Schema.parse(await action(member, 'machines.agentIsolation.status', machine.target));
    expect(protection).toMatchObject({ protection: 'member_separated', status: { kind: 'effective' } });
    if (protection.protection !== 'member_separated' || !protection.directories) throw new Error('Member directories not published');
    const directories = protection.directories;
    const { uid, gid } = await stat(directories.workspace);
    memberIdentity = { uid, gid };
    expect(uid).not.toBe(process.getuid!());
    execFileSync('sudo', ['-n', 'chown', '-R', `${uid}:${gid}`, vendorDir]);
    repo = join(directories.workspace, `journey-${randomUUID()}`);
    // Fixture data only. The product has already provisioned the real member.
    // All operations under test below enter through Actions and the daemon.
    execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', '/usr/bin/env', '-i',
      `HOME=${directories.home}`, 'PATH=/usr/local/bin:/usr/bin:/bin', '/bin/sh', '-eu', '-c',
      'mkdir "$1"; cd "$1"; git init -q; git config user.name Journey; git config user.email journey@example.invalid; printf "before\\n" > tracked.txt; git add tracked.txt; git commit -qm baseline; printf "after\\n" > tracked.txt; printf \'#!/bin/sh\\nprintf "%%s\\n" "$(id -u)" "$HOME" "$PATH" > .git/journey-identity\\n\' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit',
      'fixture', repo]);

    // Native Git's fsmonitor records the actual read process independently for
    // status and diff, and reports every path dirty so it cannot hide changes.
    const readWitness = join(repo, '.git/journey-read-identity');
    const monitor = join(repo, '.git/hooks/journey-fsmonitor');
    execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'tee', monitor], { input:
      '#!/bin/sh\nprintf \'%s\\n\' "$(id -u)" "$HOME" "$PATH" > .git/journey-read-identity\nprintf \'journey-token\\000/\\000\'\n' });
    execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'chmod', '+x', monitor]);
    execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'git', '-C', repo, 'config', 'core.fsmonitor', monitor]);
    execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'git', '-C', repo, 'config', 'core.fsmonitorHookVersion', '2']);
    const assertMemberEnvironment = (path: string) => {
      const witness = execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'cat', path], { encoding: 'utf8' }).trim().split('\n');
      expect(witness[0]).toBe(String(uid));
      expect(witness[1]).toBe(directories.home);
      expect(witness[2]?.split(delimiter)).toEqual(expect.arrayContaining(
        buildMemberAgentExecutionPath({ ...process.env, HOME: directories.home }).split(delimiter)));
    };
    expect(await action(member, 'scm.status.snapshot', { cwd: repo }))
      .toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    assertMemberEnvironment(readWitness);
    execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'rm', '--', readWitness]);
    expect(await action(member, 'scm.diff.file', { cwd: repo, path: 'tracked.txt', area: 'pending' }))
      .toMatchObject({ success: true, diff: expect.stringContaining('+after') });
    assertMemberEnvironment(readWitness);
    // Writes need Manage; the owner still acts as the folder's OS member.
    expect(await action(owner, 'scm.commit.create', { cwd: repo, message: 'member journey commit', scope: { kind: 'all-pending' } }))
      .toMatchObject({ success: true });
    const witness = execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'cat', join(repo, '.git/journey-identity')], { encoding: 'utf8' }).trim().split('\n');
    expect(witness[0]).toBe(String(uid));
    expect(witness[1]).toBe(directories.home);
    expect(witness[2]?.split(delimiter)).toEqual(expect.arrayContaining(
      buildMemberAgentExecutionPath({ ...process.env, HOME: directories.home }).split(delimiter)));
    expect(execFileSync('sudo', ['-n', '-u', `#${uid}`, '--', 'git', '-C', repo, 'show', 'HEAD:tracked.txt'], { encoding: 'utf8' })).toBe('after\n');

    execFileSync('git', ['init', '-q', machine.workspaceDir]);
    expect(await action(owner, 'scm.status.snapshot', { cwd: machine.workspaceDir }))
      .toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    expect(await action(member, 'scm.status.snapshot', { cwd: machine.workspaceDir }))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    const session = await fixture.assertKnownGoodSessionControl(member, { ...machine, workspaceDir: repo });
    sessionId = session.sessionId;
    const prompt = `Member native Git journey ${invocationId}`;
    expect(await member.executeAsPerson('session.message.send', { sessionId, message: prompt })).toMatchObject({ ok: true });
    await waitForFakeClaudeUserText(vendor.logPath, text => text.includes(prompt), { invocationId });
    const sessionMember = member;
    await waitFor(async () => {
      expect(await action(sessionMember, 'session.events.get', { sessionId }, {})).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({ text: fakeClaudeEchoResponseText(prompt) })]),
      });
      return true;
    }, { context: 'The real member Session completes an Agent turn before the Git refusal' });

    // Deliberately foreign-owned fixture data: the same member worker now meets
    // Git's real ownership check. No global safe.directory or fake UID is used.
    ownershipChanged = true;
    execFileSync('sudo', ['-n', 'chown', `${process.getuid!()}:${process.getgid!()}`, repo, join(repo, '.git')]);
    expect(await action(member, 'scm.status.snapshot', { cwd: repo }))
      .toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE', error: expect.stringContaining('git_dubious_ownership') });

    const storageScope = `member-git-${randomUUID()}`;
    ui = await startUiWeb({ testDir: join(testDir, 'ui'), env: { ...process.env,
      EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_HAPPY_SERVER_URL: fixture.server.baseUrl,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope, HAPPIER_E2E_UI_WEB_MODE: 'metro', HAPPIER_E2E_UI_WEB_NO_DEV: '0' } });
    browser = await chromium.launch();
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Accept-Encoding': 'identity' } });
    const page = await browserContext.newPage();
    await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
      serverUrl: fixture.server.baseUrl, serverIdentityId: fixture.serverId,
      auth: member.auth, mode: 'dataKey', storageScope,
    }));
    // BRIEFS RELOAD164 grants eight minutes for cold Metro first paint on this
    // one navigation; preserve the loaded page while the source bundle compiles.
    await page.goto(`${ui.baseUrl}/session/${sessionId}?right=git&happier_hmr=0`, { waitUntil: 'domcontentloaded', timeout: 480_000 });
    await uiExpect(page.getByTestId('session-rightpanel-git-unavailable')).toBeVisible({ timeout: 480_000 });
    const details = page.getByTestId('session-rightpanel-git-unavailable-details-code');
    await uiExpect(details).not.toBeVisible();
    await page.getByTestId('session-rightpanel-git-unavailable-details-toggle').click();
    await uiExpect(details).toContainText('BACKEND_UNAVAILABLE');
    await uiExpect(details).toContainText('git_dubious_ownership');
    console.info(JSON.stringify({ journey: 'MACH-J3 separate users', runtimeMs: Math.round(performance.now() - startedAt) }));
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => { await browser?.close(); },
      async () => { await ui?.stop(); },
      async () => {
        if (ownershipChanged && repo && memberIdentity) {
          execFileSync('sudo', ['-n', 'chown', `${memberIdentity.uid}:${memberIdentity.gid}`, repo, join(repo, '.git')]);
        }
      },
      async () => {
        if (member && sessionId) {
          expect(await member.executeAsPerson('session.stop', { sessionId })).toMatchObject({ ok: true });
        }
      },
      async () => {
        if (member && sessionId) {
          expect(await member.executeAsPerson('session.archive', { sessionId })).toMatchObject({ ok: true });
        }
      },
      async () => {
        if (memberIdentity) {
          // Remove only journey-owned files as the real member, retaining the
          // product's provisioned user, member root and sudoers policy.
          const paths = [repo, vendorDir].filter((path): path is string => Boolean(path));
          execFileSync('sudo', ['-n', '-u', `#${memberIdentity.uid}`, '--', 'rm', '-rf', '--', ...paths]);
        } else if (vendorDir) await rm(vendorDir, { recursive: true, force: true });
      },
      async () => { if (workspaceGit) await rm(workspaceGit, { recursive: true, force: true }); },
      async () => { await fixture.stop(); },
    ]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(
      primaryFailure ? [primaryFailure.error, ...cleanupErrors] : cleanupErrors,
      primaryFailure ? 'Member journey failed; fixture cleanup also failed' : 'Member journey fixture cleanup failed');
  }
}, 0);
