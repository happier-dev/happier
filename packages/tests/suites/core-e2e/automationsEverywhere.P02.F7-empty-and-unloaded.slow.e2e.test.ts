import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionAutomationNoticeV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRecordListProperty } from '@happier-dev/protocol/inputs/inputRecords';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { connectStdioMcp, parseToolJson } from '../../src/testkit/externalMcp';
import { repoRootDir } from '../../src/testkit/paths';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy } from '../../src/testkit/httpRequestRecordingProxy';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

describe('Action automation admission with empty and unloaded keys', () => {
  let fixture: TeamSetupFFixture | undefined;
  const proxies: HttpRequestRecordingProxy[] = [];
  const releaseHeldResponses: (() => void)[] = [];
  afterEach(async () => {
    for (const release of releaseHeldResponses.splice(0)) release();
    await Promise.all(proxies.splice(0).map(proxy => proxy.stop()));
    await fixture?.stop();
    fixture = undefined;
  }, 0);

  it('AE.P02.F7-empty-and-unloaded waits visibly for one seed, then empty buckets do no automation work', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-empty-'));
    fixture = await startTeamSetupFFixture({ testDir });
    const account = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(account);
    let releaseSeed!: () => void;
    const seedHeld = new Promise<void>(resolve => { releaseSeed = resolve; });
    releaseHeldResponses.push(releaseSeed);
    let enteredSeed!: () => void;
    const seedEntered = new Promise<void>(resolve => { enteredSeed = resolve; });
    const proxy = await startHttpRequestRecordingProxy({ targetBaseUrl: fixture.server.baseUrl,
      beforeForwardResponse: async request => {
        if (request.path === '/v1/automations/actions/index') { enteredSeed(); await seedHeld; }
      } });
    proxies.push(proxy);
    const executor = createCliActionExecutorFromCredentials({ credentials: account.credentials,
      readCredentials: async () => account.credentials, serverId: fixture.serverId,
      serverIdentityId: fixture.serverId, serverApiUrl: proxy.baseUrl });
    const progress: string[] = [];
    let settled = false;
    // Use a declared safe personal preference: this effect has no ordinary
    // human-approval Artifact that could be mistaken for automation overhead.
    const preference = { anchor: 'spaces.enabled', value: true };
    const first = executor.execute('settings.set', preference, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'empty-first',
      serverId: fixture.serverId, serverIdentityId: fixture.serverId,
      operationProgress: { update: value => { if (value.label) progress.push(value.label); } },
    }).then(result => { settled = true; return result; });
    // A real HTTP boundary holds only the structural seed; the original Action
    // must remain pending and expose the existing operation's cancellation UI.
    await Promise.race([seedEntered, first.then(() => { throw new Error('Action settled without structural automation admission'); })]);
    expect(settled).toBe(false);
    expect(progress).toContain('Checking automations…');
    releaseSeed();
    expect(await first).toMatchObject({ ok: true, result: preference });
    expect(proxy.entries().filter(request => request.path === '/v1/automations/actions/index').map(request => request.statusCode))
      .toEqual([200]);
    proxy.clear();
    expect(await executor.execute('settings.set', preference, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'empty-second',
      serverId: fixture.serverId, serverIdentityId: fixture.serverId,
    })).toMatchObject({ ok: true, result: preference });
    expect(proxy.count(request => request.path.startsWith('/v1/automations/'))).toBe(0);
    expect(proxy.count(request => request.method === 'POST' && request.path.startsWith('/v1/artifacts'))).toBe(0);

    const failingProxy = await startHttpRequestRecordingProxy({ targetBaseUrl: fixture.server.baseUrl,
      onRequestStart: request => {
        if (request.path === '/v1/automations/actions/index') throw new Error('forced seed transport failure');
      } });
    proxies.push(failingProxy);
    const failedSeedExecutor = createCliActionExecutorFromCredentials({ credentials: account.credentials,
      readCredentials: async () => account.credentials, serverId: fixture.serverId,
      serverIdentityId: fixture.serverId, serverApiUrl: failingProxy.baseUrl });
    expect(await failedSeedExecutor.execute('settings.set', preference, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      actionRequestId: 'failed-seed', serverId: fixture.serverId, serverIdentityId: fixture.serverId,
    })).toMatchObject({ ok: true, result: preference, automationNotices: [{ code: 'action_automations_not_checked' }] });

    // Standalone MCP supports Account Actions without a bound Session. Keep
    // the enrolled Home as credential authority; only HTTP transport uses the
    // failing proxy, through the CLI's existing local Home URL override.
    failingProxy.clear();
    const mcp = await connectStdioMcp({ command: process.execPath,
      args: [resolve(repoRootDir(), 'apps/cli/src/index.ts'), '--server-url', fixture.server.baseUrl,
        '--local-server-url', failingProxy.baseUrl, 'mcp', 'serve'],
      env: { ...process.env, CI: '1', HAPPIER_HOME_DIR: machine.homeDir,
        NODE_OPTIONS: fixture.sourceOptions, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' } });
    try {
      const result = await mcp.client.callTool({ name: 'action_execute', arguments: {
        actionId: 'settings.set', input: preference,
      } });
      expect(result.isError).not.toBe(true);
      expect(parseToolJson(result)).toEqual(preference);
      const notices = result.content?.flatMap(block => block.type === 'text'
        ? readRecordListProperty(JSON.parse(block.text), 'automationNotices') : [])
        .map(notice => ActionAutomationNoticeV1Schema.parse(notice));
      expect(notices).toMatchObject([{ code: 'action_automations_not_checked' }]);
      expect(failingProxy.entries().filter(request => request.path === '/v1/automations/actions/index')).toHaveLength(1);
    } finally {
      await mcp.client.close();
      await mcp.transport.close();
    }

    failingProxy.clear();
    const cli = await runCliJson({ testDir, cliHomeDir: machine.homeDir,
      serverUrl: fixture.server.baseUrl, webappUrl: fixture.server.baseUrl,
      label: 'failed-seed-notice',
      env: { ...process.env, NODE_OPTIONS: fixture.sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' },
      launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
      args: ['--server-url', fixture.server.baseUrl, '--local-server-url', failingProxy.baseUrl,
        'actions', 'invoke', 'settings.set', '--input-json', JSON.stringify(preference), '--json'],
    });
    expect(cli).toMatchObject({ ok: true, kind: 'actions_invoke', data: preference });
    const cliNotices = readRecordListProperty(cli, 'automationNotices')
      .map(notice => ActionAutomationNoticeV1Schema.parse(notice));
    expect(cliNotices).toMatchObject([{ code: 'action_automations_not_checked' }]);
    expect(failingProxy.entries().filter(request => request.path === '/v1/automations/actions/index')).toHaveLength(1);

    let releaseCancelledSeed!: () => void;
    const cancelledSeedHeld = new Promise<void>(resolve => { releaseCancelledSeed = resolve; });
    releaseHeldResponses.push(releaseCancelledSeed);
    let enteredCancelledSeed!: () => void;
    const cancelledSeedEntered = new Promise<void>(resolve => { enteredCancelledSeed = resolve; });
    const cancellingProxy = await startHttpRequestRecordingProxy({ targetBaseUrl: fixture.server.baseUrl,
      beforeForwardResponse: async request => {
        if (request.path === '/v1/automations/actions/index') { enteredCancelledSeed(); await cancelledSeedHeld; }
      } });
    proxies.push(cancellingProxy);
    const cancelledSeedExecutor = createCliActionExecutorFromCredentials({ credentials: account.credentials,
      readCredentials: async () => account.credentials, serverId: fixture.serverId,
      serverIdentityId: fixture.serverId, serverApiUrl: cancellingProxy.baseUrl });
    const cancellation = new AbortController();
    const cancelled = cancelledSeedExecutor.execute('settings.set', preference, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      actionRequestId: 'cancelled-seed', serverId: fixture.serverId, serverIdentityId: fixture.serverId,
      signal: cancellation.signal });
    await Promise.race([cancelledSeedEntered, cancelled.then(() => { throw new Error('Action bypassed the pending seed'); })]);
    cancellation.abort();
    expect(await cancelled).toMatchObject({ ok: false, errorCode: 'cancelled' });
    releaseCancelledSeed();
    expect(cancellingProxy.count(request => request.method === 'POST')).toBe(0);
  }, 0);
});
