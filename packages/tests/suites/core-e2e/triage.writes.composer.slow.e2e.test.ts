// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectUiTriageActionClient, mountUiTriageComposerAttachmentJourney } from '@happier-tests/ui-action-client';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { TriageCreateTaskActionResultV1Schema, TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1 } from '../../../plugins/triage/src/actions/tasksProtocol';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../../plugins/triage/src/internalTasks/configuration';
import { PLUGIN_MANIFEST } from '../../../plugins/triage/src/manifest';
import { TriageComposerEntryAttachmentValueV1Schema } from '../../../plugins/triage/src/composer/attachmentValue';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { waitFor } from '../../src/testkit/timing';
// Select the web renderer in this test file before importing the semantic picker.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

// QB-37/38: real picker -> Account Action -> encrypted Account data, and real
// Composer Host API -> repository document. The SDK semantic adapter replaces
// the physical renderer transport; PluginSurfaceHost/catalog admission is not
// claimed by this journey.
const run = createRunDirs({ runLabel: 'triage-writes-composer' });

describe('Triage writes: addressed Composer document', () => {
  let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  let accountSecret: Uint8Array;
  let machineId: string;
  let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
  let journey: Awaited<ReturnType<typeof mountUiTriageComposerAttachmentJourney>> | undefined;

  beforeAll(async () => {
    const testDir = run.testDir(`composer-${randomUUID()}`);
    const homeDir = join(testDir, 'daemon-home');
    const sourceRuntime = pathToFileURL(join(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href;
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', sourceRuntime].filter(Boolean).join(' ');
    server = await startServerLight({ testDir, extraEnv: {
      NODE_OPTIONS: sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    const auth = await createTestAuth(server.baseUrl);
    accountSecret = auth.accountSigningSeed;
    machineId = (await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' })).machineId;
    daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
      ...sanitizeCliTestEnv(process.env), CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
      NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    } });
  }, 0);

  // UI setup resets profiles/credentials in beforeEach; connect afterwards.
  beforeEach(async () => {
    if (!server) throw new Error('Composer server not started');
    client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret });
    await waitFor(() => client?.isAccountReady() === true && client.isMachineControlReady(machineId));
  });
  afterEach(async () => {
    await journey?.close(); journey = undefined;
    await client?.close(); client = undefined;
  });
  afterAll(async () => { try { await daemon?.stop(); } finally { await server?.stop(); } });

  it('attaches and removes only the addressed attachment without changing Unicode, selection, references or the other live draft', async () => {
    if (!client) throw new Error('Composer client not connected');
    const connected = client;
    const configured = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured;
    const title = `Composer entry ${randomUUID()}`;
    const created = await connected.executeConfirmed('action.invoke', {
      action: { pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1 },
      input: { v: 1, source: configured.instance.source, sourceInstanceId: configured.instance.sourceInstanceId,
        kindId: 'task', fields: { title } },
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: connected.serverId });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(`Task creation refused: ${created.errorCode}`);
    const task = TriageCreateTaskActionResultV1Schema.parse(created.result);
    expect(task.kind).toBe('applied');

    const reference = 'partner:existing';
    const token = formatInlineReferenceTokenV1({ label: '@existing', ref: reference });
    const text = `🧑🏽‍💻 e\u0301 العربية\n漢字 ${token}\r\n\t👩‍👩‍👧‍👦`;
    const tokenStart = text.indexOf(token);
    journey = await mountUiTriageComposerAttachmentJourney({
      machineId, text, selection: { start: text.indexOf('العربية'), end: tokenStart + 3 },
      mention: { kind: 'partner.reference', ref: reference, tokenText: token,
        start: tokenStart, end: tokenStart + token.length },
      unrelatedAttachment: { v: 1, instanceId: 'unrelated-existing', key: 'existing-note',
        attachment: { pluginId: 'acme.other', localId: 'note' },
        value: { note: 'Preserve me' }, presentation: { typeLabel: 'Note', label: 'Preserve me' } },
      executeAction: async (action, input) => {
        const result = await connected.executeConfirmed('action.invoke', { action, input },
          { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: connected.serverId });
        if (!result.ok) throw new Error(`Picker Action refused: ${result.errorCode}`);
        return result.result;
      },
    });
    const { before, beforeDocument, otherBefore, transactions, reads, composerRef } = journey;
    await journey.pressAttach(title);
    const attached = journey.readSnapshot();
    expect(attached.text).toBe(before.text);
    expect(attached.selection).toEqual(before.selection);
    expect(attached.references).toEqual(before.references);
    expect(attached.attachments[0]).toEqual(before.attachments[0]);
    expect(attached.attachments).toHaveLength(before.attachments.length + 1);
    const entry = attached.attachments.find(attachment => attachment.attachment.pluginId === PLUGIN_MANIFEST.id);
    const value = TriageComposerEntryAttachmentValueV1Schema.parse(entry?.value);
    if (!('entryRef' in value)) throw new Error('Expected the whole-entry attachment');
    expect(value).toMatchObject({ sourceInstance: configured.instance });
    expect(journey.readOtherSnapshot()).toEqual(otherBefore);
    expect(transactions).toEqual([{ ref: composerRef, transaction: { expectedRevision: before.revision,
      operations: [expect.objectContaining({ kind: 'attachment.add' })] } }]);
    expect(reads).toContainEqual(composerRef);
    expect(reads.every(ref => JSON.stringify(ref) === JSON.stringify(composerRef))).toBe(true);
    await journey.pressRemove(title);
    expect(journey.readSnapshot()).toEqual({ ...before, revision: journey.readDocument().revision });
    expect(journey.readOtherSnapshot()).toEqual(otherBefore);

    // Advance the real repository revision at the transport boundary before
    // the pending transaction reaches the production Composer host handler.
    const concurrentText = `${journey.readDocument().text}\nPerson’s new text`;
    const conflict = await journey.conflictAttach({ entryRef: value.entryRef,
      sourceInstance: configured.instance, presentation: { label: title }, concurrentText });
    expect(conflict).toEqual({ outcome: { kind: 'refused', refusal: { code: 'conflict' } }, reads: 1, applies: 1 });
    expect(journey.readDocument().text).toBe(concurrentText);
    expect(journey.readDocument().composerAttachments).toEqual(beforeDocument.composerAttachments);
    expect(journey.readOtherSnapshot()).toEqual(otherBefore);

    // A new person press, after the refusal settled, chooses a fresh attempt.
    await journey.pressAttach(title);
    const freshAttempt = journey.readSnapshot();
    expect(freshAttempt.text).toBe(concurrentText);
    expect(freshAttempt.selection).toEqual(before.selection);
    expect(freshAttempt.references).toEqual(before.references);
    expect(freshAttempt.attachments).toHaveLength(before.attachments.length + 1);
    expect(freshAttempt.attachments[0]).toEqual(before.attachments[0]);
    expect(journey.readOtherSnapshot()).toEqual(otherBefore);
  });
});
