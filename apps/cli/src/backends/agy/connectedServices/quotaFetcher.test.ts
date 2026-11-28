import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandCaptureResult } from '@happier-dev/cli-common/process';
import { buildConnectedServiceCredentialRecord, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '@/daemon/connectedServices/accountUsage/fromConnectedServiceQuotaObservation';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { buildConnectedServiceAuthGroupSwitchStateFromAccountUsage } from '@/daemon/connectedServices/accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, selectConnectedServiceAuthGroupCandidate } from '@/daemon/connectedServices/accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceQuotaFetchError } from '@/daemon/connectedServices/quotas/types';
import { createAgyQuotaFetcher, type AgyUsageCommandRunner } from './quotaFetcher';

function record(profileId = 'agy-selected') {
  return buildConnectedServiceCredentialRecord({ now: 1000, serviceId: 'antigravity', profileId, kind: 'oauth', expiresAt: 9000,
    oauth: { accessToken: 'agy-selected-token', refreshToken: 'agy-refresh', idToken: null, scope: null, tokenType: null,
      providerAccountId: `${profileId}-google-id`, providerEmail: 'agy@example.com', raw: null } });
}

// Shape of `agy -p /usage --output-format json` observed on agy 1.5.18 (values replaced): no model
// turn, `command.data.groups[].buckets[]`; an unset reset is reported as the Unix epoch.
function usageOutput(geminiWeeklyRemaining: number) {
  return JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    command: { name: 'usage', data: { description: 'Within each group, models share a weekly limit and a 5-hour limit.', groups: [
      { name: 'Gemini Models', description: 'Gemini models', buckets: [
        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: geminiWeeklyRemaining, reset_time: '2026-12-03T09:20:58Z' },
        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', disabled: true, remaining_fraction: 1 },
      ] },
      { name: 'Claude and GPT models', buckets: [
        { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
      ] },
    ] } } });
}

function exited(stdout: string, status = 0): CommandCaptureResult {
  return { kind: 'exited', status, signal: null, stdout, stderr: '' };
}

type Invocation = Readonly<{ args: readonly string[]; env: NodeJS.ProcessEnv; tokenFile: string | null }>;

/** The installed agy process is the system boundary. */
function fakeAgy(usage: () => CommandCaptureResult, version = '1.5.18') {
  const invocations: Invocation[] = [];
  const run: AgyUsageCommandRunner = async ({ args, env }) => {
    // Top-level agy (1.5.18) resolves its profile from the user's home (`~/.gemini`), not GEMINI_HOME.
    const home = env.HOME;
    const tokenFile = home ? await readFile(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8').catch(() => null) : null;
    invocations.push({ args, env, tokenFile });
    return args.includes('--version') ? exited(`${version}\n`) : usage();
  };
  return { run, invocations };
}

function fetcherFor(agy: ReturnType<typeof fakeAgy>) {
  return createAgyQuotaFetcher({ runCommand: agy.run, resolveLaunch: () => ({ command: '/opt/agy/bin/agy', args: [] }) });
}

describe('Antigravity quota from agy /usage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks the installed agy, as the account, and never calls Google directly', async () => {
    const network = vi.fn(async () => { throw new Error('no direct provider request'); });
    vi.stubGlobal('fetch', network);
    const agy = fakeAgy(() => exited(usageOutput(0)));

    const snapshot = await fetcherFor(agy).fetch({ record: record(), now: 2000, signal: new AbortController().signal });

    expect(network).not.toHaveBeenCalled();
    const usageRun = agy.invocations.find(call => call.args.includes('/usage'))!;
    expect(usageRun.args).toEqual(['-p', '/usage', '--output-format', 'json']);
    expect(usageRun.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');
    expect(usageRun.env.USERPROFILE).toBe(usageRun.env.HOME);
    expect(JSON.parse(usageRun.tokenFile!)).toMatchObject({ token: { access_token: 'agy-selected-token', refresh_token: 'agy-refresh' } });
    // The isolated profile holding the account's token does not outlive the read.
    await expect(stat(usageRun.env.HOME!)).rejects.toThrow();

    expect(snapshot).toMatchObject({ serviceId: 'antigravity', profileId: 'agy-selected', fetchedAt: 2000, accountLabel: 'agy@example.com' });
    expect(snapshot!.meters).toEqual([
      expect.objectContaining({ meterId: 'gemini-weekly', label: 'Gemini Models · Weekly Limit Remaining', scope: 'weekly',
        remainingPct: 0, isExhausted: true, resetsAt: Date.parse('2026-12-03T09:20:58Z'), status: 'ok' }),
      expect.objectContaining({ meterId: 'gemini-5h', scope: 'five_hour', isExhausted: false, status: 'unavailable' }),
      expect.objectContaining({ meterId: '3p-weekly', remainingPct: 100, resetsAt: null }),
    ]);
  });

  it('refuses an agy without file token storage, which would read the machine login instead', async () => {
    const agy = fakeAgy(() => exited(usageOutput(1)), '1.5.15');
    await expect(fetcherFor(agy).fetch({ record: record(), now: 2000, signal: new AbortController().signal }))
      .rejects.toMatchObject({ message: 'antigravity_cli_version_unsupported' });
    expect(agy.invocations.some(call => call.args.includes('/usage'))).toBe(false);
  });

  it('reports a failed or unrecognized agy answer as a fetch error, never as fresh empty allowance', async () => {
    for (const result of [exited('not json'), exited(JSON.stringify({ status: 'ERROR' }), 1),
      exited(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'x', buckets: [{ name: 'no id' }] }] } } }))]) {
      const agy = fakeAgy(() => result);
      await expect(fetcherFor(agy).fetch({ record: record(), now: 2000, signal: new AbortController().signal }))
        .rejects.toBeInstanceOf(ConnectedServiceQuotaFetchError);
    }
  });
});

describe('Antigravity pool hard-limit recovery from agy usage', () => {
  const nowMs = 2000;
  function group(): ConnectedServiceAuthGroupV1 {
    const member = (profileId: string, priority: number) => ({ v: 1 as const, serviceId: 'antigravity' as const, groupId: 'agy', profileId,
      enabled: true, priority, createdAt: 1, updatedAt: 1, state: { credentialHealthStatus: 'connected' as const } });
    return { v: 1, serviceId: 'antigravity', groupId: 'agy', displayName: 'agy', activeProfileId: 'exhausted', generation: 3, runtimeStateRevision: 0,
      state: { lastSwitchReason: 'usage_limit', lastSwitchAt: 1 }, createdAt: 1, updatedAt: 1,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
      members: [member('exhausted', 1), member('candidate', 2)] };
  }
  async function select(candidateWeekly: number) {
    const store = createProviderAccountUsageStore();
    const g = group();
    for (const [profileId, weekly] of [['exhausted', 0], ['candidate', candidateWeekly]] as const) {
      const snapshot = await fetcherFor(fakeAgy(() => exited(usageOutput(weekly))))
        .fetch({ record: record(profileId), now: nowMs, signal: new AbortController().signal });
      store.recordSnapshot(buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({ snapshot: snapshot!, sourceProviderAccountId: `${profileId}-google-id` }),
        { sources: [{ serviceId: 'antigravity', profileId, bindingKind: 'group_member', groupId: 'agy', groupGeneration: g.generation }] });
    }
    const { state } = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({ group: g, accountUsageStore: store });
    return selectConnectedServiceAuthGroupCandidate({ ...state, nowMs, quotaFreshnessMs: 300_000, switchReason: 'usage_limit' });
  }
  it('selects a member with headroom while the active member is at its weekly limit', async () => {
    const selection = await select(0.8);
    expect(selection.selected?.profileId).toBe('candidate');
    expect(selection.decisionTrace.candidates).toContainEqual(expect.objectContaining({ profileId: 'exhausted', decision: 'excluded' }));
  });
  it('does not select a member whose weekly limit is also exhausted', async () => {
    expect((await select(0)).selected).toBeNull();
  });
});
