import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmCommitCreateResponseSchema, ScmBackendDescribeResponseSchema } from '@happier-dev/protocol/scm';
import { createGitWorkspace, createTestGitScmBackendRegistry, runGit } from './testRpcHarness';

const person = { name: 'Guest Person', email: 'guest@example.test' };
afterEach(() => { vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests(); });
describe.each(['rpc', 'action'] as const)('SCM requester identity through %s', entry => {
  it.each([
    { worktree: false, label: 'person on own Machine', guest: false, person: true, local: false, expected: 'Guest Person <guest@example.test>' },
    { worktree: false, label: 'explicit repository choice', guest: true, person: true, local: true, expected: 'Test User <test@example.com>' },
    { worktree: true, label: 'worktree-local repository choice', guest: true, person: true, local: true, expected: 'Worktree Person <worktree@example.test>' },
    { worktree: false, label: 'guest on shared host', guest: true, person: true, local: false, expected: 'Guest Person <guest@example.test>' },
    { worktree: false, label: 'guest without repository or person identity describes none despite owner global identity', guest: true, person: false, local: false, expected: null },
    { external: true, worktree: false, label: 'external custodian native fallback', guest: false, person: false, local: false, expected: 'Host Person <host@example.test>' },
    { use: true, external: true, worktree: false, label: 'external guest Use without identity', guest: true, person: false, local: false, expected: null },
    { external: true, worktree: false, label: 'external guest Manage without identity', guest: true, person: false, local: false, expected: null },
    { worktree: false, label: 'custodian native fallback', guest: false, person: false, local: false, expected: 'Host Person <host@example.test>' },
    { worktree: false, label: 'amend preserves the original author', guest: true, person: true, local: false, amend: true, expected: 'Guest Person <guest@example.test>' },
  ])('$label', async test => {
    const cwd = createGitWorkspace();
    const global = join(cwd, 'global.gitconfig');
    writeFileSync(global, '[user]\nname = Host Person\nemail = host@example.test\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) vi.stubEnv(key, undefined);
    if ('amend' in test && test.amend) {
      writeFileSync(join(cwd, 'original.txt'), 'original\n');
      runGit(cwd, ['add', 'original.txt']);
      runGit(cwd, ['commit', '-m', 'original']);
    }
    if (!test.local) {
      runGit(cwd, ['config', '--unset', 'user.name']);
      runGit(cwd, ['config', '--unset', 'user.email']);
    }
    if (test.guest && !test.person && !test.local) {
      expect(runGit(cwd, ['var', 'GIT_COMMITTER_IDENT'])).toMatch(/^Host Person <host@example\.test> /);
    }
    if (test.worktree) {
      runGit(cwd, ['config', 'extensions.worktreeConfig', 'true']);
      runGit(cwd, ['config', '--worktree', 'user.name', 'Worktree Person']);
      runGit(cwd, ['config', '--worktree', 'user.email', 'worktree@example.test']);
    }
    writeFileSync(join(cwd, 'change.txt'), 'change\n');
    setActiveAccountSettingsSnapshot({ source: 'network', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: accountSettingsParse({ scmGitIdentity: test.guest ? { name: 'Host Settings', email: 'host-settings@example.test' } : test.person ? person : null }) });
    const registry = createTestGitScmBackendRegistry();
    const handlers = new Map<string, RpcHandler>();
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, cwd, { registry });
    const request = { cwd: '.', message: 'identity', scope: { kind: 'all-pending' }, outcomeVersion: 1,
      ...('amend' in test && test.amend ? { mode: 'amend' } : {}),
      ...(test.person && test.guest ? { gitIdentity: person } : {}) };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
      accountId: test.guest ? 'guest' : 'host', custodianAccountId: 'host', serverIdentityId: 'server',
      machineId: 'machine-test', installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 1 },
      actionId: 'scm.commit.create', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine-test' }, admittedMachineRole: 'use' in test ? 'use' : 'manage',
    } });
    const raw = entry === 'rpc' ? await handlers.get(RPC_METHODS.SCM_COMMIT_CREATE)!(request,
      { signal: new AbortController().signal, machineAdmission: { actorAccountId: test.guest ? 'guest' : 'host', custodianAccountId: 'host',
        machineId: 'machine-test', installationId: 'installation', role: 'use' in test ? 'use' : 'manage', encryptionMode: 'plain' } })
      : await executeScmActionOperation({ actionId: 'scm.commit.create', input: request, workingDirectory: cwd, registry,
        actionContext: { ...('external' in test ? { authority: 'present_user' as const,
          externalActionExecutionAuthorization: authorization, verifiedExternalActionRequester: { authorization, isCurrent: async () => true },
          verifyMachineAdmissionCurrent: async () => true } : {}), runtimeAccountId: test.guest ? 'guest' : 'host', ...(test.guest || 'external' in test ? {} : {
          authenticatedLocalRootCustody: { serverIdentityId: 'server', accountId: 'host', machineId: 'machine-test', installationId: 'installation' },
        }) } });
    expect(raw).toMatchObject({ success: expect.any(Boolean) });
    const result = ScmCommitCreateResponseSchema.parse(raw);
    if (test.expected === null) {
      expect(result.outcome).toMatchObject({ message: expect.stringMatching(/empty ident|identity unknown/i) });
      expect(result).toMatchObject({ success: false, errorCode: 'COMMIT_IDENTITY_REQUIRED', publication: { state: 'not_published' } });
    } else {
      expect(result.success, JSON.stringify(result)).toBe(true);
      const author = 'amend' in test && test.amend ? 'Test User <test@example.com>' : test.expected;
      expect(runGit(cwd, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD'])).toBe(`${author}|${test.expected}`);
    }
    const described = await handlers.get(RPC_METHODS.SCM_BACKEND_DESCRIBE)!({ cwd: '.', ...(test.guest && test.person ? { gitIdentity: person } : {}) },
      { signal: new AbortController().signal, machineAdmission: { actorAccountId: test.guest ? 'guest' : 'host', custodianAccountId: 'host',
        machineId: 'machine-test', installationId: 'installation', role: 'use' in test ? 'use' : 'manage', encryptionMode: 'plain' } });
    const expectedIdentity = test.expected === null ? null : /^(.+) <(.+)>$/.exec(test.expected);
    expect(described).toMatchObject({ success: true, gitIdentity: expectedIdentity ? { name: expectedIdentity[1], email: expectedIdentity[2] } : null });
    expect(ScmBackendDescribeResponseSchema.parse(described)).toMatchObject({ gitIdentityResolution: {
      source: test.local ? 'repository' : test.person ? 'person' : test.guest ? 'none' : 'native',
      identity: expectedIdentity ? { name: expectedIdentity[1], email: expectedIdentity[2] } : null,
    } });
  });
});

// One custody decision at the SCM ingress: an Action root that arrives without a raw Machine
// admission receipt (an approval replay's retained ingress) decides Git identity and credentials alike.
describe('SCM requester identity from the Action root carrier alone', () => {
  it.each([
    { label: 'custodian on callerInputAuthorization keeps native identity', guest: false, carrier: 'rpc' },
    { label: 'custodian on the local Action context keeps native identity', guest: false, carrier: 'local' },
    { label: 'guest on callerInputAuthorization never borrows native identity', guest: true, carrier: 'rpc' },
    { label: 'guest on the local Action context never borrows native identity', guest: true, carrier: 'local' },
  ] as const)('$label', async test => {
    const cwd = createGitWorkspace();
    const global = join(cwd, 'global.gitconfig');
    writeFileSync(global, '[user]\nname = Host Person\nemail = host@example.test\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) vi.stubEnv(key, undefined);
    runGit(cwd, ['config', '--unset', 'user.name']);
    runGit(cwd, ['config', '--unset', 'user.email']);
    writeFileSync(join(cwd, 'change.txt'), 'change\n');
    setActiveAccountSettingsSnapshot({ source: 'network', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: accountSettingsParse({ scmGitIdentity: null }) });
    const registry = createTestGitScmBackendRegistry();
    const handlers = new Map<string, RpcHandler>();
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, cwd, { registry });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
      accountId: test.guest ? 'guest' : 'host', custodianAccountId: 'host', serverIdentityId: 'server',
      machineId: 'machine-test', installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 1 },
      actionId: 'scm.commit.create', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine-test' }, admittedMachineRole: 'manage',
    } });
    const context = test.carrier === 'rpc'
      ? { signal: new AbortController().signal, callerInputAuthorization: authorization }
      : { signal: new AbortController().signal, localActionContext: { externalActionExecutionAuthorization: authorization } };
    const result = ScmCommitCreateResponseSchema.parse(await handlers.get(RPC_METHODS.SCM_COMMIT_CREATE)!(
      { cwd: '.', message: 'identity', scope: { kind: 'all-pending' }, outcomeVersion: 1 }, context));
    if (test.guest) {
      expect(result).toMatchObject({ success: false, errorCode: 'COMMIT_IDENTITY_REQUIRED' });
    } else {
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(runGit(cwd, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD']))
        .toBe('Host Person <host@example.test>|Host Person <host@example.test>');
    }
  });
});

// Process counts are the operation cost contract, measured at the selected process port.
describe('Git identity process budget', () => {
  it.each([false, true])('reads cost zero identity probes and a commit resolves once; custodian=%s', async isCustodian => {
    const { runWithGitIdentity } = await import('@/scm/gitIdentity');
    const { runWithScmCommandRunner, runScmCommand } = await import('@/scm/runtime');
    const commands: string[][] = [];
    const run = async (input: import('@/scm/runtime').ScmCommandInput) => {
      commands.push(input.args);
      return { success: true, exitCode: 0, stderr: '', stdout: input.args[0] === 'var'
        ? 'Native Person <native@example.test> 1 +0000' : '' };
    };
    await runWithScmCommandRunner(run, () => runWithGitIdentity({ person: null, isCustodian }, async () => {
      expect(commands).toHaveLength(0); // admitted work with no process costs zero
      await runScmCommand({ bin: 'other-scm', cwd: '/one', args: ['status'] });
      expect(commands).toHaveLength(1); // non-Git command has no resolver
      commands.length = 0;
      for (const cwd of ['/one', '/one', '/two']) await runScmCommand({ bin: 'git', cwd, args: ['status'] });
    }));
    expect(commands.filter(args => args[0] !== 'status')).toHaveLength(0);
    expect(commands.filter(args => args[0] === 'status')).toHaveLength(3);
    commands.length = 0;
    await runWithScmCommandRunner(run, () => runWithGitIdentity({ person: null, isCustodian }, async () => {
      await runScmCommand({ bin: 'git', cwd: '/one', args: ['commit', '-m', 'first'] });
      await runScmCommand({ bin: 'git', cwd: '/one', args: ['commit', '--amend', '--no-edit'] });
    }));
    expect(commands.filter(args => args[0] !== 'commit')).toHaveLength(1);
  });
});
