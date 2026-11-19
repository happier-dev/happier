import githubPackage from '../../../plugins/scm-github/package.json';
// U-CORPUS-CONFIGURATION: public source lifecycle, with durable user state.
// Source plugin uninstall/reinstall awaits lifecycle-contract adjudication.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourceAdministrationActionResultV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import {
  GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE,
} from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { PLUGIN_MANIFEST as githubManifest } from '../../../plugins/scm-github/src/manifest';
import { activate as activateGithub } from '../../../plugins/scm-github/src/accountRuntime';
import {
  encodeGithubTriageConfiguration, GITHUB_TRIAGE_ACCOUNT_SCOPE_V1,
  GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1, GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
} from '../../../plugins/scm-github/src/triage/configuration';
import {
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1, TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageSetEntryPinnedResultV1Schema, TriageListPinnedEntriesResultV1Schema,
} from '../../../plugins/triage/src/actions/userMarksProtocol';
import {
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, TriageLinkEntryToSessionActionResultV1Schema,
} from '../../../plugins/triage/src/actions/sessionLinksProtocol';
import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema,
} from '../../../plugins/triage/src/actions/entryDetailProtocol';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-source-configuration' });
const testDir = run.testDir(randomUUID());
const source = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let accountSecret: Uint8Array;
let linkedSessionId: string;
let daemonParams: Parameters<typeof startTestDaemon>[0];

beforeAll(async () => {
  github = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com'],
    // Configuration must not read a provider; any attempted HTTP read is recorded.
    responseForRequest: () => ({ statusCode: 503, body: { message: 'Unexpected configuration provider read' } }),
  });
  const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  server = await startServerLight({ testDir, extraEnv: { NODE_OPTIONS: sourceOptions,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
  const auth = await createTestAuth(server.baseUrl);
  accountSecret = auth.accountSigningSeed;
  linkedSessionId = (await createSession(server.baseUrl, auth.token)).sessionId;
  const homeDir = join(testDir, 'daemon-home');
  await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
  daemonParams = { testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
    ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    NODE_OPTIONS: `${sourceOptions} --import ${pathToFileURL(join(repoRootDir(), 'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`,
    HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath,
    // Saving source metadata does not require native credentials. Isolate this
    // fixture from the runner's login so discovery cannot read a real provider.
    GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: '', GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
    HTTPS_PROXY: github.url, https_proxy: github.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    SSL_CERT_FILE: github.caCertPath,
  } };
}, 0);

beforeAll(async () => {
  daemon = await startTestDaemon(daemonParams);
}, 0);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => client?.close(), () => daemon?.stop(), () => server?.stop(), () => github?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Source configuration cleanup failed');
});

async function reconnect(restart = false) {
  await client?.close();
  client = undefined;
  if (restart) {
    await daemon?.stop();
    daemon = await startTestDaemon(daemonParams);
  }
  if (!server) throw new Error('Configuration server unavailable');
  client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret,
    additionalPlugins: [{ packageName: githubPackage.name, manifest: githubManifest, activate: activateGithub }] });
  await waitFor(() => client!.isAccountReady(), { context: 'source configuration Account readiness' });
}

async function invoke(localId: string, input: unknown, mutation = false) {
  if (!client) throw new Error('Configuration Account client unavailable');
  const context = { surface: 'ui' as const, authority: 'present_user' as const,
    actionCaller: { kind: 'host' as const }, serverId: client.serverId };
  const args = { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId }, input };
  const result = mutation ? await client.executeConfirmed('action.invoke', args, context)
    : await client.execute('action.invoke', args, context);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`Source configuration ${localId} refused (${result.errorCode})`);
  return result.result;
}

it('adds, edits, removes and restores a source without provider reads or losing pins and Session links through restart', async () => {
  // The shared UI setup resets persisted profiles in beforeEach. Mount this
  // reader afterwards so its selected Account and Home context remain active.
  await reconnect();
  const read = async () => {
    const result = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await invoke(
      TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1, source }));
    expect(result).toMatchObject({ kind: 'read', status: 'complete' });
    if (result.kind !== 'read') throw new Error(`Configured source read refused (${result.kind})`);
    return result.instances;
  };
  const write = async (input: unknown) => TriageSourceAdministrationActionResultV1Schema.parse(
    await invoke(TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, input, true));
  const token = encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1);
  if (token === null) throw new Error('GitHub configuration fixture could not be encoded');
  const draft: TriageSourceInstanceDraftV1 = { v: 1,
    binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
    localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1, keyStability: GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
    configuration: { v: 1, token }, locator: { v: 1, displayLabel: 'Configuration fixture' } };
  // Discovery candidates are not saved source rows. This source-scoped read
  // starts empty even though the daemon has admitted the GitHub contribution.
  expect(await read()).toEqual([]);
  const providerReadsBefore = github!.entries().length;
  const created = await write({ v: 1, kind: 'create', source, draft });
  expect(created).toMatchObject({ kind: 'active', sourceInstanceId: expect.any(String) });
  if (created.kind !== 'active') throw new Error(`Source create refused (${created.kind})`);
  const sourceInstanceId = created.sourceInstanceId;
  expect(await write({ v: 1, kind: 'create', source, draft })).toEqual({ kind: 'reused', sourceInstanceId });
  const entryRef = { source, kindId: 'issue', collisionScope: 'github:source-configuration', entryId: '25' };
  const sessionId = linkedSessionId;
  const displayAtMark = { title: 'Retained source pin', scopeLabel: 'configuration/repository' };
  const expectRetainedPin = async () => {
    const pins = TriageListPinnedEntriesResultV1Schema.parse(await invoke(
      TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 20 }));
    expect(pins.pins).toEqual(expect.arrayContaining([expect.objectContaining({ entryRef, displayAtMark })]));
  };
  expect(TriageSetEntryPinnedResultV1Schema.parse(await invoke(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    { v: 1, pinned: true, entryRef, displayAtMark }, true))).toMatchObject({ status: 'pinned' });
  // The declared Collection relation requires an existing same-Account Session.
  expect(TriageLinkEntryToSessionActionResultV1Schema.parse(await invoke(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
    { v: 1, entryRef, sourceInstanceId, sessionId,
      display: { locator: { v: 1, displayPath: 'configuration/repository#25' }, scopeLabel: displayAtMark.scopeLabel } }, true)))
    .toMatchObject({ status: 'linked' });
  const editedToken = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: ['configuration/repository'] } });
  if (editedToken === null) throw new Error('Edited GitHub configuration fixture could not be encoded');
  const edited = { ...draft, configuration: { v: 1 as const, token: editedToken },
    locator: { v: 1 as const, displayLabel: 'Edited configuration fixture' } };
  // keyStability describes a candidate's key; the configured row persists only
  // the source identity, binding, key, configuration and locator.
  const expectedConfigured = { v: 1, instance: { source, sourceInstanceId }, binding: edited.binding,
    localInstanceKey: edited.localInstanceKey, configuration: edited.configuration, locator: edited.locator };
  expect(await write({ v: 1, kind: 'reconfigure', sourceInstanceId, draft: edited }))
    .toEqual({ kind: 'reconfigured', sourceInstanceId });
  expect(await read()).toMatchObject([{ lifecycle: 'active', configured: expectedConfigured }]);
  expect(await write({ v: 1, kind: 'remove', sourceInstanceId })).toEqual({ kind: 'removed', sourceInstanceId });
  expect(await read()).toMatchObject([{ lifecycle: 'retired', configured: expectedConfigured }]);
  expect(await write({ v: 1, kind: 'create', source, draft: edited })).toEqual({ kind: 'conflict' });
  await reconnect(true);
  expect(await read()).toMatchObject([{ lifecycle: 'retired', configured: expectedConfigured }]);
  await expectRetainedPin();
  // Retirement prevents authoritative detail reads while preserving the pin
  // and the Session relation for explicit reactivation of this same instance.
  expect(TriageReadEntryDetailResultV1Schema.parse(await invoke(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
    { v: 1, entryRef, sourceInstanceId }))).toEqual({ kind: 'unavailable' });
  expect(await write({ v: 1, kind: 'reactivate', sourceInstanceId, draft: edited }))
    .toEqual({ kind: 'reactivated', sourceInstanceId });
  await reconnect(true);
  expect(await read()).toMatchObject([{ lifecycle: 'active', configured: expectedConfigured }]);
  await expectRetainedPin();
  const detail = TriageReadEntryDetailResultV1Schema.parse(await invoke(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
    { v: 1, entryRef, sourceInstanceId }));
  expect(detail).toMatchObject({ kind: 'read', linkedSessions: [{ sessionId }] });
  expect(github!.entries().length, 'Source metadata lifecycle must not read GitHub').toBe(providerReadsBefore);
}, 0);
