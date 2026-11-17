import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountCredentialMutationV4';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { ConnectedServiceBindingSelectionV2 } from '@happier-dev/protocol/connect/connectedServiceBindings';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamCredentialSourceCandidateListOutputV1Schema } from '@happier-dev/protocol/teams/credentials/sourceCandidatesV1';
import { TeamCredentialResourceEntitledPageV1Schema, TeamCredentialResourceSummaryV1Schema,
  teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { startGithubCliBoundary } from '../../src/testkit/githubCliBoundary';
import { createRunDirs } from '../../src/testkit/runDir';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { waitFor } from '../../src/testkit/timing';
import { fetchAccountId } from '../../src/testkit/socialFriends';
import { fetchJson } from '../../src/testkit/http';
import { DaemonTerminalEnsureResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { connectSessionMcpClient, readSessionMcpContextFromEnvironment } from '../../../../apps/cli/src/mcp/runtime/sessionMcpLocalClient';

const run = createRunDirs({ runLabel: 'core' });
const service = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const serviceKey = `${service.pluginId}/${service.localId}`;
const fingerprint = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function isolatedNativeEnvironment(directory: string, github: Awaited<ReturnType<typeof startGithubCliBoundary>>) {
  const home = join(directory, 'os-home');
  const config = join(home, '.gitconfig');
  const systemConfig = join(home, 'empty-system-gitconfig');
  const ambientStore = join(home, 'ambient-credentials');
  const ghConfig = join(home, 'gh');
  await mkdir(ghConfig, { recursive: true });
  // The ambient helper must be reset by the admitted process's host-scoped
  // configuration. Appending gh alone succeeds but silently stores its token.
  const configBaseline = `[credential]\n\thelper = store --file=${ambientStore}\n`;
  await writeFile(config, configBaseline);
  await writeFile(systemConfig, '');
  return { home, config, configBaseline, ambientStore, ghConfig, env: {
    HOME: home, USERPROFILE: home, GH_CONFIG_DIR: ghConfig, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_NOSYSTEM: '1', GH_TOKEN: '', GITHUB_TOKEN: '', GH_HOST: '',
    ...github.env, GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  } };
}

async function native(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

it('TS.E.githubCredential characterizes installed real gh against the external HTTPS boundary', async () => {
  const directory = run.testDir(`github-native-${randomUUID()}`);
  const github = await startGithubCliBoundary();
  try {
    const isolated = await isolatedNativeEnvironment(directory, github);
    const token = `github_pat_TEST_ONLY_${randomUUID()}`;
    const version = await native('gh', ['--version'], isolated.env);
    expect(version.code).toBe(0);
    expect(version.output).toMatch(/^gh version /);
    const status = await native('gh', ['auth', 'status', '--hostname', 'github.com'], { ...isolated.env, GH_TOKEN: token });
    // Preserve the native response before interpreting a downstream failure;
    // constructed tokens are still redacted from this diagnostic artifact.
    await writeFile(join(directory, 'native-gh-status.txt'), status.output.replaceAll(token, '[REDACTED]'));
    expect(status.code, status.output.replaceAll(token, '[REDACTED]')).toBe(0);
    // gh 2.102.0 sends GitHub's `token` authorization scheme. The shared
    // recorder strips Bearer only, so this fingerprints the full token header.
    expect(github.entries().some(request => request.authorizationFingerprint === fingerprint(`token ${token}`))).toBe(true);
    expect(await readdir(isolated.ghConfig)).toEqual([]);
    expect(await readFile(isolated.config, 'utf8')).toBe(isolated.configBaseline);
  } finally { await github.stop(); }
}, 0);

describe('Team setup E: GitHub credential process admission', () => {
  const directory = run.testDir(`github-composed-${randomUUID()}`);
  let fixture: TeamSetupFFixture | undefined;
  let github: Awaited<ReturnType<typeof startGithubCliBoundary>> | undefined;
  let account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
  const extraUis: Array<Awaited<ReturnType<typeof connectUiActionClient>>> = [];
  let isolated: Awaited<ReturnType<typeof isolatedNativeEnvironment>>;
  const attestationPath = join(directory, 'native-attestations.jsonl');

  beforeAll(async () => {
    github = await startGithubCliBoundary();
    isolated = await isolatedNativeEnvironment(directory, github);
    const provider = join(directory, 'claude-with-native-github.mjs');
    // This substitutes only the third-party Agent executable. gh and Git are
    // real child processes with the environment admitted by the real daemon.
    // Attest hashes/status, never credential-helper stdout or raw environment.
    await writeFile(provider, `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--output-format')) {
  const token = process.env.GH_TOKEN || '';
  const redact = value => String(value || '').split(token || '\\u0000').join('[REDACTED]');
  // Substitute external HTTPS at the real native child boundary. This overlay
  // contains no GH_TOKEN or GIT_CONFIG keys; their admitted values stay intact.
  const nativeEnvironment = { ...process.env, ...${JSON.stringify(github.env)} };
  const gh = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { env: nativeEnvironment, encoding: 'utf8' });
  const git = spawnSync('git', ['ls-remote', 'https://github.com/team-setup/fixture.git'], { env: nativeEnvironment, encoding: 'utf8' });
  appendFileSync(${JSON.stringify(attestationPath)}, JSON.stringify({
    sessionMcpContextFile: process.env.HAPPIER_SESSION_MCP_CONTEXT_FILE,
    tokenFingerprint: token ? 'sha256:' + createHash('sha256').update(token).digest('hex') : null,
    gh: { code: gh.status, output: redact(gh.stdout) + redact(gh.stderr) },
    git: { code: git.status, output: redact(git.stdout) + redact(git.stderr) },
  }) + '\\n');
}
await import(${JSON.stringify(pathToFileURL(fakeClaudeFixturePath()).href)});
`, { mode: 0o700 });
    fixture = await startTeamSetupFFixture({ testDir: directory });
    account = await fixture.createAccount('github-owner');
    await fixture.claimHomeOwner(account);
    machine = await fixture.enrollDaemon(account, { env: { ...isolated.env, NODE_OPTIONS: `${fixture.sourceOptions} ${github.env.NODE_OPTIONS}`, HAPPIER_CLAUDE_PATH: provider } });
    // P04: refusal and missing-feature outcomes count only after this actual
    // Action → PostgreSQL → daemon → Session admitted control succeeds.
    await fixture.assertKnownGoodSessionControl(account, machine);
  }, 0);

  // Each test connects after the shared UI device reset has run.
  beforeEach(async () => {
    ui = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials: account.uiCredentials });
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId), { timeoutMs: 60_000 });
  }, 0);

  afterEach(async () => {
    try { for (const client of extraUis.splice(0)) await client.close(); } finally {
      await ui?.close(); ui = undefined;
    }
  }, 0);

  afterAll(async () => {
    try { await fixture?.stop(); } finally { await github?.stop(); }
  }, 0);

  async function importToken(token: string) {
    const ref = { service, accountId: randomUUID() };
    const metadata = { displayName: 'Constructed imported GitHub account', scopes: ['repo'],
      providerIdentity: { accountId: ref.accountId } };
    // The credential owner API imports constructed material without asking the
    // authentication UI to validate this deliberately non-real token upstream.
    const payload = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref,
      authenticationModeId: 'fine-grained-pat', payload: { v: 1, values: { token } }, metadata, now: Date.now() });
    const content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
      material: { type: 'dataKey', machineKey: account.credentials.encryption.machineKey }, payload, randomBytes });
    const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse({ ref,
      authenticationModeId: 'fine-grained-pat', content, metadata, expectedCredentialRevision: null,
      directExportContract: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 });
    const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v4/connect/qualified/credential`, {
      method: 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(mutation), timeoutMs: 20_000,
    });
    expect(response.status).toBe(200);
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(response.data);
    // The authenticated health request must reach the constructed HTTPS peer
    // before a bound launch can be evidence about credential materialization.
    await waitFor(() => github!.entries().some(request => request.path === '/user'
      && request.authorizationFingerprint === fingerprint(token)), { timeoutMs: 60_000 });
    return ref;
  }

  type Account = Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  type Machine = Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  type Ui = Awaited<ReturnType<typeof connectUiActionClient>>;
  function spawnInput(selection?: ConnectedServiceBindingSelectionV2, targetMachine: Machine = machine) {
    return {
      executionTarget: targetMachine.target, directory: { kind: 'path' as const, path: targetMachine.workspaceDir },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      connectedServices: { v: 2 as const, bindingsByServiceId: selection ? { [serviceKey]: selection } : {} },
      terminal: { mode: 'plain' as const },
    };
  }
  async function admit(selection?: ConnectedServiceBindingSelectionV2, scope: { account: Account; machine: Machine; ui: Ui } = {
    account, machine, ui: ui!,
  }) {
    const before = await readFile(attestationPath, 'utf8').catch(() => '');
    const result = await scope.account.execute('session.spawn_new', spawnInput(selection, scope.machine));
    if (!result.ok) throw new Error(`Bound GitHub Session refused (${result.errorCode})`);
    const created = SessionSpawnNewActionResultV1Schema.parse(result.result);
    expect(created.type).toBe('success');
    if (created.type !== 'success') throw new Error(`Bound GitHub Session unsettled (${created.type})`);
    const sent = await scope.ui.execute('session.message.send', { sessionId: created.sessionId, message: 'Verify the admitted GitHub process.' },
      { surface: 'ui', authority: 'present_user', serverId: scope.ui.serverId, actionCaller: { kind: 'host' }, defaultSessionId: created.sessionId });
    expect(sent.ok).toBe(true);
    let contents = '';
    await waitFor(async () => { contents = await readFile(attestationPath, 'utf8').catch(() => '');
      return contents.length > before.length; }, { timeoutMs: 60_000 });
    const rows = contents.slice(before.length).trim().split('\n');
    const observed = JSON.parse(rows[0]!) as {
      sessionMcpContextFile?: string; tokenFingerprint: string | null;
      gh: { code: number | null; output: string }; git: { code: number | null; output: string };
    };
    return { sessionId: created.sessionId, observed, metadata: await scope.account.readSessionMetadata(created.sessionId) };
  }

  async function readTranscript(sessionId: string, client = ui!) {
    const transcript = await client.executeConfirmed('session.transcript.get', { sessionId,
      includeTools: true, includeEvents: true, includeMeta: true, includeRaw: true, maxCharsPerMessage: null },
    { surface: 'ui', authority: 'present_user', serverId: client.serverId, actionCaller: { kind: 'host' }, defaultSessionId: sessionId });
    expect(transcript.ok).toBe(true);
    expect(JSON.stringify(transcript)).toContain('Verify the admitted GitHub process.');
    return transcript;
  }

  async function assertSessionSetup(sessionMcpContextFile: string | undefined, token: string,
    scope: { machine: Machine; ui: Ui } = { machine, ui: ui! }) {
    const { machine, ui } = scope;
    const requestOffset = github!.entries().length;
    if (!sessionMcpContextFile) throw new Error('Admitted provider did not receive Session Action transport custody');
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      serverId: ui!.serverId, actionCaller: { kind: 'host' as const } };
    const git = await native('git', ['init', '--quiet', machine.workspaceDir], isolated.env);
    expect(git.code).toBe(0);
    await mkdir(join(machine.workspaceDir, '.happier'), { recursive: true });
    await writeFile(join(machine.workspaceDir, '.happier/project.json'), JSON.stringify({ version: 1,
      workspace: { setup: [{ kind: 'command',
        command: 'gh auth status --hostname github.com && git ls-remote https://github.com/team-setup/fixture.git && printf TEAM_GH_SETUP_OK > github-setup-result',
      }] } }));
    const openedResult = await ui!.executeConfirmed('projects.open', { ...machine.target,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } }, context);
    if (!openedResult.ok) throw new Error(`GitHub setup Project open refused (${openedResult.errorCode})`);
    const opened = OpenProjectResultV1Schema.parse(openedResult.result);
    if (opened.kind !== 'opened') throw new Error(`GitHub setup Project not opened (${opened.kind})`);
    const mcp = await connectSessionMcpClient(await readSessionMcpContextFromEnvironment({
      HAPPIER_SESSION_MCP_CONTEXT_FILE: sessionMcpContextFile,
    }));
    try {
      // The original Session's actual native Action executor supplies origin;
      // there is no synthetic sessionActionOrigin or credential selection here.
      const response = await mcp.client.callTool({ name: 'action_execute', arguments: {
        actionId: 'projects.prepare', input: { workspace: opened.workspace, phase: 'setup' },
      } });
      if (!Array.isArray(response.content) || response.content[0]?.type !== 'text') throw new Error('GitHub setup Action response missing');
      expect(response.isError).not.toBe(true);
      const accepted = ProjectCommandActionOutputV1Schema.parse(JSON.parse(response.content[0].text)).operation;
      let snapshot: ActionOperationSnapshotV1 | undefined;
      const observe = async () => {
        const result = await ui!.execute('action.operations.get', { ...machine.target,
          operationId: accepted.operationId }, context);
        if (!result.ok) throw new Error(`GitHub setup observation refused (${result.errorCode})`);
        const found = ActionOperationGetV1ResponseSchema.parse(result.result);
        if (found.kind !== 'found') throw new Error('GitHub setup admitted operation not found');
        snapshot = found.operation;
      };
      await waitFor(async () => { await observe(); return Boolean(snapshot!.setupReview); }, { timeoutMs: 60_000 });
      const approved = await ui!.executeConfirmed('projects.prepare', { workspace: opened.workspace, phase: 'setup',
        heldOperationId: accepted.operationId, expectedEffectDigest: snapshot!.setupReview!.reviewedEffectDigest,
        consentScope: 'untilChanged' }, context);
      expect(approved.ok).toBe(true);
      await waitFor(async () => { await observe(); return ['succeeded', 'failed', 'cancelled'].includes(snapshot!.state); }, { timeoutMs: 60_000 });
      expect(snapshot).toMatchObject({ state: 'succeeded' });
      expect(JSON.stringify(snapshot)).not.toContain(token);
      expect(await readFile(join(machine.workspaceDir, 'github-setup-result'), 'utf8')).toBe('TEAM_GH_SETUP_OK');
      expect(github!.entries().slice(requestOffset).some(request => request.authorizationFingerprint
        === fingerprint(`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`))).toBe(true);
    } finally { await mcp.close(); }
  }

  async function assertAssociatedTerminal(sessionId: string, token: string,
    scope: { machine: Machine; ui: Ui } = { machine, ui: ui! }) {
    const { machine, ui } = scope;
    const requestOffset = github!.entries().length;
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      serverId: ui!.serverId, actionCaller: { kind: 'host' as const } };
    const opened = await ui!.executeConfirmed('machines.terminal.open', { ...machine.target, sessionId,
      cwd: machine.workspaceDir, terminalKey: `github-bound-${randomUUID()}`,
      launch: { kind: 'shell_command', command: 'gh auth status --hostname github.com && git ls-remote https://github.com/team-setup/fixture.git && printf "TEAM_GH_TERMINAL_OK\\n"; exit $?' },
    }, context);
    if (!opened.ok) throw new Error(`Associated GitHub terminal refused (${opened.errorCode})`);
    const terminal = DaemonTerminalEnsureResponseSchema.parse(opened.result);
    if (!terminal.ok) throw new Error(`Associated GitHub terminal unavailable (${terminal.errorCode})`);
    let byteOffset = 0;
    let controlCursor: number | undefined;
    let output = '';
    let exitCode: number | null | undefined;
    await waitFor(async () => {
      const read = await ui!.execute('machines.terminal.read', { ...machine.target,
        terminalId: terminal.terminalId, byteOffset, controlCursor, holdForOutput: true }, context);
      if (!read.ok) throw new Error(`Associated GitHub terminal read refused (${read.errorCode})`);
      const stream = TerminalStreamReadResponseSchema.parse(read.result);
      if (!stream.ok) throw new Error(`Associated GitHub terminal stream refused (${stream.code})`);
      for (const frame of stream.frames) {
        if (frame.t === 'bytes') output += Buffer.from(decodeTerminalStreamBytesFrame(frame)).toString('utf8');
        if (frame.t === 'exit') exitCode = frame.exitCode;
      }
      byteOffset = stream.nextByteOffset;
      controlCursor = stream.nextControlCursor;
      return stream.done;
    }, { timeoutMs: 60_000 });
    await writeFile(join(directory, 'associated-terminal-native.txt'), output.replaceAll(token, '[REDACTED]'));
    expect(exitCode, output.replaceAll(token, '[REDACTED]')).toBe(0);
    expect(output).toContain('TEAM_GH_TERMINAL_OK');
    expect(output).not.toContain(token);
    expect(github!.entries().slice(requestOffset).some(request => request.authorizationFingerprint
      === fingerprint(`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`))).toBe(true);
  }

  it('TS.E.githubCredential uses a personal binding, switches at the next admission and leaves unbound/native isolated', async () => {
    const firstToken = `github_pat_TEST_ONLY_FIRST_${randomUUID()}`;
    const secondToken = `github_pat_TEST_ONLY_SECOND_${randomUUID()}`;
    const firstAccount = await importToken(firstToken);
    const first = await admit({ source: 'connected', selection: 'profile', profileId: firstAccount.accountId });
    expect(first.observed.tokenFingerprint).toBe(fingerprint(firstToken));
    expect(first.observed.gh, first.observed.gh.output).toMatchObject({ code: 0 });
    expect(first.observed.gh.output).toContain('team-setup-fixture');
    expect(first.observed.git, first.observed.git.output).toMatchObject({ code: 0 });
    expect(github!.entries().some(request => request.path.startsWith('/team-setup/fixture.git/info/refs')
      && request.authorizationFingerprint === fingerprint(`Basic ${Buffer.from(`x-access-token:${firstToken}`).toString('base64')}`))).toBe(true);
    await assertAssociatedTerminal(first.sessionId, firstToken);
    await assertSessionSetup(first.observed.sessionMcpContextFile, firstToken);
    const secondAccount = await importToken(secondToken);
    const second = await admit({ source: 'connected', selection: 'profile', profileId: secondAccount.accountId });
    expect(second.observed).toMatchObject({ tokenFingerprint: fingerprint(secondToken), gh: { code: 0 }, git: { code: 0 } });
    // A new Session admission cannot replace an existing Session's associated
    // process selection. Both native gh and Git still use the first binding.
    await assertAssociatedTerminal(first.sessionId, firstToken);
    const unbound = await admit();
    expect(unbound.observed.tokenFingerprint).toBeNull();
    expect(unbound.observed.gh.code).not.toBe(0);
    expect(await readdir(isolated.ghConfig)).toEqual([]);
    expect(await readFile(isolated.config, 'utf8')).toBe(isolated.configBaseline);
    expect(await readFile(isolated.ambientStore, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    })).toBeNull();
    const shared = JSON.stringify([first.metadata, second.metadata, unbound.metadata,
      await readTranscript(first.sessionId), await readTranscript(second.sessionId), await readTranscript(unbound.sessionId)]);
    const logs = (await Promise.all([machine.daemon.proc.stdoutPath, machine.daemon.proc.stderrPath,
      ...(machine.daemon.state.daemonLogPath ? [machine.daemon.state.daemonLogPath] : []),
    ].map(path => readFile(path, 'utf8')))).join('\n');
    for (const token of [firstToken, secondToken]) {
      expect(shared).not.toContain(token);
      expect(logs).not.toContain(token);
      expect(await readFile(attestationPath, 'utf8')).not.toContain(token);
      expect(await readFile(isolated.config, 'utf8')).not.toContain(token);
    }
  }, 0);

  it('TS.E.githubCredential uses admitted direct Team material for another Account and refuses broker delivery without native fallback', async () => {
    const token = `github_pat_TEST_ONLY_TEAM_${randomUUID()}`;
    const connected = await importToken(token);
    const personal = await admit({ source: 'connected', selection: 'profile', profileId: connected.accountId });
    expect(personal.observed, JSON.stringify({ gh: personal.observed.gh, git: personal.observed.git }))
      .toMatchObject({ tokenFingerprint: fingerprint(token), gh: { code: 0 }, git: { code: 0 } });
    expect(personal.observed.gh.output).toContain('team-setup-fixture');
    const createdTeam = await account.execute('teams.create', { v: 1, name: 'GitHub CLI acceptance', requestKey: randomUUID() });
    if (!createdTeam.ok) throw new Error(`GitHub Team creation refused (${createdTeam.errorCode})`);
    const teamId = TeamSummaryV1Schema.parse(createdTeam.result).id;
    const member = await fixture!.createAccount('github-member');
    const ownerId = await fetchAccountId(fixture!.server.baseUrl, account.credentials.token);
    const memberId = await fetchAccountId(fixture!.server.baseUrl, member.credentials.token);
    const joined = await account.execute('teams.members.add', { v: 1, teamId, accountId: memberId,
      role: 'member', historyAccess: 'all_existing' });
    expect(joined.ok).toBe(true);
    const recipientMachine = await fixture!.enrollDaemon(member, { env: { ...isolated.env, NODE_OPTIONS: `${fixture!.sourceOptions} ${github!.env.NODE_OPTIONS}`,
      HAPPIER_CLAUDE_PATH: join(directory, 'claude-with-native-github.mjs') } });
    await fixture!.assertKnownGoodSessionControl(member, recipientMachine);
    const recipientUi = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials: member.uiCredentials });
    extraUis.push(recipientUi);
    await waitFor(() => recipientUi.isAccountReady() && recipientUi.isMachineActive(recipientMachine.target.machineId), { timeoutMs: 60_000 });
    const sources = await account.execute('teams.credentials.sources.list', { teamId });
    if (!sources.ok) throw new Error(`GitHub source discovery refused (${sources.errorCode})`);
    const candidate = TeamCredentialSourceCandidateListOutputV1Schema.parse(sources.result).candidates.find(row =>
      row.source.kind === 'connected_account' && row.source.target.account.accountId === connected.accountId);
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('Imported GitHub account absent from source owner projection');
    const resourceId = randomUUID();
    const labelKey = Uint8Array.from(randomBytes(32));
    const displayName = sealPrivateLabelV1({ mode: 'e2ee', binding: teamCredentialDisplayNamePrivateLabelBindingV1(resourceId),
      value: 'Team GitHub CLI fixture', dataKey: labelKey, randomBytes, recipients: [
        { accountId: ownerId, envelope: sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: labelKey,
          recipientContentPublicKey: account.credentials.encryption.publicKey, randomBytes }) },
        { accountId: memberId, envelope: sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: labelKey,
          recipientContentPublicKey: member.credentials.encryption.publicKey, randomBytes }) },
      ] });
    const shared = await ui!.executeConfirmed('teams.credentials.create', { teamId, resourceId, displayName,
      source: candidate.source, deliveryPolicy: { preferredAllowedModes: ['direct', 'brokered'] },
      sessionUsePolicy: 'personal_allowed', brokerPlacement: { kind: 'machine', machineId: machine.target.machineId },
      requestPolicy: null, allMembersAllowedRoutes: ['direct', 'brokered'], groupGrants: [], memberGrants: [], usageLimits: [],
    }, { surface: 'ui', authority: 'present_user', serverId: ui!.serverId, actionCaller: { kind: 'host' } });
    expect(shared.ok).toBe(true);
    if (!shared.ok) throw new Error(`GitHub Team share refused (${shared.errorCode})`);
    TeamCredentialResourceSummaryV1Schema.parse(shared.result);
    let selection: ConnectedServiceBindingSelectionV2 | undefined;
    await waitFor(async () => {
      const listed = await member.execute('teams.credentials.entitled.list', { teamId, resourceId,
        executionMachineId: recipientMachine.target.machineId });
      if (!listed.ok) throw new Error(`Team GitHub material discovery refused (${listed.errorCode})`);
      const row = TeamCredentialResourceEntitledPageV1Schema.parse(listed.result).resources.find(resource => resource.id === resourceId);
      selection = row?.connectedServiceSelections.find(value => value.deliveryMode === 'direct');
      return row?.directMaterialState === 'current' && selection !== undefined;
    }, { timeoutMs: 60_000 });
    if (!selection) throw new Error('Direct GitHub selection was not produced');
    const direct = await admit(selection, { account: member, machine: recipientMachine, ui: recipientUi });
    await assertAssociatedTerminal(direct.sessionId, token, { machine: recipientMachine, ui: recipientUi });
    await assertSessionSetup(direct.observed.sessionMcpContextFile, token, { machine: recipientMachine, ui: recipientUi });
    expect(direct.observed).toMatchObject({ tokenFingerprint: fingerprint(token), gh: { code: 0 }, git: { code: 0 } });
    const before = await readFile(attestationPath, 'utf8');
    const brokered = await member.execute('session.spawn_new', spawnInput({ source: 'team_resource', resourceId,
      deliveryMode: 'brokered' }, recipientMachine));
    expect(brokered).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed',
      launchError: { kind: 'launch_error', code: 'github_cli_team_brokered_unavailable' } } });
    expect(await readFile(attestationPath, 'utf8')).toBe(before);
    expect(JSON.stringify([sources, shared, brokered, direct.metadata,
      await readTranscript(direct.sessionId, recipientUi)])).not.toContain(token);
    expect(await readdir(isolated.ghConfig)).toEqual([]);
    expect(await readFile(isolated.config, 'utf8')).toBe(isolated.configBaseline);
    expect(await readFile(isolated.ambientStore, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    })).toBeNull();
    for (const path of [recipientMachine.daemon.proc.stdoutPath, recipientMachine.daemon.proc.stderrPath,
      ...(recipientMachine.daemon.state.daemonLogPath ? [recipientMachine.daemon.state.daemonLogPath] : [])]) {
      expect(await readFile(path, 'utf8')).not.toContain(token);
    }
  }, 0);
});
