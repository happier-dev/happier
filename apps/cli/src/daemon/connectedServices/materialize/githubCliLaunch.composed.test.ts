import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountPortableReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { materializeGithubCredential } from '../../../../../../packages/plugins/scm-github/src/auth/credentialMaterialization';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeQualifiedConnectedAccountLaunchUses } from './materializeQualifiedConnectedAccountLaunchUses';
import { stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';

const execute = promisify(execFile);
const service = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const serviceKey = `${service.pluginId}/${service.localId}`;
const contributions = {
  agentDefinitionsById: new Map([['agent', { identity: { pluginId: 'acme.agent', localId: 'agent' },
    richDefinition: { definition: { connectedAccounts: [] } }, catalogEntry: {} }]]),
  systemTools: [{ pluginId: service.pluginId, definition: { id: 'gh', title: 'GitHub CLI', executableNames: ['gh'],
    connectedAccountLaunch: { purpose: 'github.cli', service: 'github-account', environmentKey: 'GH_TOKEN',
      unsetEnvironmentKeys: ['GITHUB_TOKEN', 'GH_HOST'], brokeredUnavailableCode: 'github_cli_team_brokered_unavailable',
      gitCredentialHelper: { host: 'github.com', args: ['auth', 'git-credential'] } } } }],
};

describe('GitHub CLI bound process launch', () => {
  it('uses one selected acquisition, real gh helper, and process-only config through switch and removal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-github-cli-'));
    const globalConfig = join(home, 'gitconfig');
    const originalGlobalConfig = `[credential]\n\thelper = store --file=${join(home, 'ambient-credentials')}\n[credential "https://github.com"]\n\thelper = !exit 73\n[credential "https://example.test"]\n\thelper = unrelated\n`;
    await writeFile(globalConfig, originalGlobalConfig);
    const inherited = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, GH_CONFIG_DIR: join(home, 'gh'),
      GH_TOKEN: 'ghp_native-fixture', GITHUB_TOKEN: 'ghp_alternate-fixture', GH_HOST: 'enterprise.example.test',
      GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Existing identity' };
    let acquisitions = 0;
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: async () => { throw new Error('No settings writes'); },
        subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('No fallback selection'); },
      resolveTarget: async target => target.kind === 'account' ? { displayName: target.account.accountId, account: target.account } : null,
      materializeAccount: async ({ account, request }) => materializeGithubCredential(request, {
        credentials: { get: async () => { acquisitions += 1; return `ghp_fixture-${account.accountId}`; } },
      } as unknown as ConnectedAccountPortableReadContext),
      projectTargetAccounts: async () => { throw new Error('No inventory'); },
      assertTargetAccountMaterializable: async () => { throw new Error('No inventory'); },
    });
    const launch = async (accountId: string | null) => {
      const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'agent', contributions,
        bindings: { v: 2, bindingsByServiceId: { [serviceKey]: accountId
          ? { source: 'connected', selection: 'profile', profileId: accountId } : { source: 'native' } } } });
      if (!snapshot) throw new Error('Expected launch declaration');
      const lease = owner.activatePurposeBindings({ subject: { kind: 'operation', operationId: `launch-${accountId}`,
        consumer: { pluginId: 'acme.agent', localId: 'agent' }, consumers: snapshot.purposes.map(purpose => purpose.consumer),
        isCurrent: () => true }, purposes: snapshot.purposes,
        bindings: snapshot.bindings });
      try {
        return await materializeQualifiedConnectedAccountLaunchUses({ connectedAccountsOwner: owner, snapshot,
          exactPurposeBindingSubjectId: lease.subjectId, signal: new AbortController().signal,
          processEnvironment: inherited });
      } finally { lease.dispose(); }
    };
    try {
      const first = await launch('first');
      expect(first.env.GH_TOKEN).toBe('ghp_fixture-first');
      expect(first.unsetEnvKeys).toEqual(expect.arrayContaining(['GITHUB_TOKEN', 'GH_HOST']));
      const env = { ...stripUnsetEnvironmentVariables(inherited, first.unsetEnvKeys), ...first.env };
      const credential = await new Promise<string>((resolve, reject) => {
        const child = execFile('git', ['credential', 'fill'], { env }, (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin!.end('protocol=https\nhost=github.com\n\n');
      });
      expect(credential).toContain('password=ghp_fixture-first');
      await new Promise<void>((resolve, reject) => {
        const child = execFile('git', ['credential', 'approve'], { env }, error => error ? reject(error) : resolve());
        child.stdin!.end('protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghp_fixture-first\n\n');
      });
      expect((await execute('git', ['config', 'user.name'], { env })).stdout.trim()).toBe('Existing identity');
      expect((await execute('git', ['config', '--get', 'credential.https://example.test.helper'], { env })).stdout.trim()).toBe('unrelated');
      expect((await launch('second')).env.GH_TOKEN).toBe('ghp_fixture-second');
      const removed = await launch(null);
      expect(removed.env).toEqual({});
      expect(removed.unsetEnvKeys).toEqual([]);
      expect({ ...inherited, ...removed.env }.GH_TOKEN).toBe('ghp_native-fixture');
      expect(acquisitions).toBe(2);
      expect(await readFile(globalConfig, 'utf8')).toBe(originalGlobalConfig);
      expect(await readdir(home)).not.toContain('gh');
      // A native gh release may write noncredential state under .local. No
      // process token may reach that state or an inherited credential helper.
      for (const name of await readdir(home, { recursive: true })) {
        const path = join(home, name);
        if (!(await stat(path)).isFile()) continue;
        const contents = await readFile(path);
        for (const token of ['ghp_fixture-first', 'ghp_fixture-second', 'ghp_native-fixture', 'ghp_alternate-fixture']) {
          expect(contents.includes(Buffer.from(token))).toBe(false);
        }
      }
      expect(inherited.GH_TOKEN).toBe('ghp_native-fixture');
      expect(inherited.GIT_CONFIG_COUNT).toBe('1');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains the direct Team origin and rejects broker delivery without a native fallback', () => {
    const selected = { source: 'team_resource' as const, resourceId: 'team-github', deliveryMode: 'direct' as const,
      disclosedMember: { service, accountId: 'shared-member' } };
    const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'agent', contributions,
      bindings: { v: 2, bindingsByServiceId: { [serviceKey]: selected } } });
    expect(snapshot?.directMaterialOrigins).toContainEqual(expect.objectContaining({ resourceId: selected.resourceId,
      purpose: { consumer: { pluginId: service.pluginId, localId: 'gh' }, purpose: 'github.cli' },
      disclosedMember: selected.disclosedMember }));
    expect(() => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'agent', contributions,
      bindings: { v: 2, bindingsByServiceId: { [serviceKey]: { source: 'team_resource', resourceId: 'team-broker', deliveryMode: 'brokered' } } } }))
      .toThrow(expect.objectContaining({ code: 'github_cli_team_brokered_unavailable' }));
  });
});
