import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { SharedSavedSecretMutationOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealSavedSecretResourceStoredContentV1, sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { MachineFinitePolicyGetResultV1Schema } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectOrganizationUpdateOutputV1Schema } from '@happier-dev/protocol/projects/projectOrganizationV1';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { ProjectManifestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { fetchJson } from '../../src/testkit/http';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { waitFor } from '../../src/testkit/timing';

let fixture: ProjectDaemonFixture | undefined;
afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

it('L12.Scripts: a person reads finite output, stops work, and re-runs a queued native task only after reviewing its changed executable', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'l12-scripts-journey-'));
  fixture = await startProjectDaemonFixture({ testDir });
  const account = await fixture.createAccount('scripts-owner');
  const machine = await fixture.enrollDaemon(account);
  const root = machine.workspaceDir;
  await mkdir(join(root, '.happier'));
  await mkdir(join(root, 'work space'));
  const manifest = ProjectManifestV1Schema.parse({ version: 1,
    environmentVariables: [{ name: 'SCRIPT_ENV', kind: 'config', required: true },
      { name: 'SCRIPT_SECRET', kind: 'secret', required: true }],
    scripts: {
      tuple: { source: { kind: 'command', cwd: 'work space', command: "sh ../tuple.sh 'one argument' '世界🚀'" } },
      hold: { source: { kind: 'command', command: 'sh ./hold.sh' } },
      native: { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } },
    },
  });
  await Promise.all([
    writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest)),
    writeFile(join(root, '.env'), 'SCRIPT_ENV=finite-config\n'),
    writeFile(join(root, 'tuple.sh'), 'printf "argv:<%s><%s>\\ncwd:<%s>\\nenv:<%s>\\n" "$1" "$2" "$PWD" "$SCRIPT_ENV"\nprintf "%s" "$SCRIPT_SECRET" | sha256sum\nexit 23\n'),
    writeFile(join(root, 'hold.sh'), 'printf "BEGIN\\n"\nwhile ! test -f allow-finish; do sleep 0.1; done\nprintf "DONE\\n"\n'),
    writeFile(join(root, 'Makefile'), 'check:\n\t@sh ./task.sh\n'),
    writeFile(join(root, 'task.sh'), 'printf "reviewed\\n" >> effects\nprintf "NATIVE_REVIEWED\\n"\n'),
  ]);
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
  try {
    const execute = (actionId: ActionId, input: unknown, actionRequestId = randomUUID()) => ui.executeConfirmed(actionId, input, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: ui.serverId, serverIdentityId: fixture!.serverId, actionRequestId,
    });
    const action = async (actionId: ActionId, input: unknown) => {
      const result = await execute(actionId, input);
      if (!result.ok) throw new Error(`${actionId} refused (${result.errorCode})`);
      return result.result;
    };
    const opened = OpenProjectResultV1Schema.parse(await action('projects.open', { ...machine.target,
      source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }));
    if (opened.kind !== 'opened' || !opened.facts?.projectKey) throw new Error(`Project did not open (${opened.kind})`);
    const resourceId = randomUUID();
    const secretValue = randomBytes(24).toString('hex');
    const resourceDataKey = Uint8Array.from(randomBytes(32));
    const secret = SharedSavedSecretMutationOutputV1Schema.parse(await action('secrets.shared.create', {
      resourceId, displayName: 'Finite Script input', kind: 'token', encryptionMode: 'e2ee',
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
        content: { v: 1, name: 'Finite Script input', kind: 'token', value: secretValue }, randomBytes }),
      keyEnvelopes: [{ recipientAccountId: readAccountIdFromToken(account.auth.token),
        ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
          recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(account.auth.accountMachineKey).publicKey, randomBytes }) }],
    }));
    const reference = { ref: formatSharedSavedSecretRefV1(resourceId), revision: secret.revision };
    const projectRef = { serverId: fixture.serverId, projectKey: opened.facts.projectKey };
    const organizationKey = { kind: 'project-organization', ...projectRef } as const;
    const currentOrganization = await fetchJson<unknown>(new URL(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, fixture.server.baseUrl).href, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ProjectAccountRowReadRequestV1Schema.parse({ key: organizationKey })),
    });
    expect(currentOrganization.status).toBe(200);
    const organization = ProjectAccountRowReadResponseV1Schema.parse(currentOrganization.data);
    if (organization.status !== 'present') throw new Error(`Opened Project organization is ${organization.status}`);
    expect(organization.row.key).toEqual(organizationKey);
    const binding = ProjectOrganizationUpdateOutputV1Schema.parse(await action('projects.organization.update', {
      projectRef, expectedRevision: organization.row.revision,
      environmentBinding: { name: 'SCRIPT_SECRET', reference },
    }));
    if (!binding.ok) throw new Error(`Project Secret binding refused (${binding.errorCode})`);
    expect(binding).toMatchObject({ ok: true, row: { environmentBindings: { v: 1, bindings: { SCRIPT_SECRET: reference } } } });
    expect(JSON.stringify(binding)).not.toContain(secretValue);
    const policy = async (accepting: boolean) => {
      const current = MachineFinitePolicyGetResultV1Schema.parse(await action('machines.worker.policy.get', machine.target));
      if (current.status !== 'ready') throw new Error(`Machine policy unavailable (${current.status})`);
      expect(await action('machines.worker.policy.set', { ...machine.target,
        expectedMetadataVersion: current.metadataVersion, expectedPolicy: current.policy,
        policy: { accepting, runAtMost: 1 } })).toMatchObject({ status: 'applied' });
    };
    await policy(true);
    const run = async (name: string) => ProjectCommandActionOutputV1Schema.parse(await action('projects.script.run', {
      workspace: opened.workspace, selection: { kind: 'named', name },
    })).operation.operationId;
    const observe = async (operationId: string, waitForTerminal = false) => {
      const found = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', {
        ...machine.target, operationId, ...(waitForTerminal ? { waitForTerminal: true } : {}),
      }));
      if (found.kind !== 'found') throw new Error(`Operation ${operationId} disappeared`);
      return found.operation;
    };
    const output = async (operationId: string) => {
      const read = TerminalStreamReadResponseSchema.parse(await action('projects.execution.output.read', {
        ...machine.target, operationId, byteOffset: 0,
      }));
      if (!read.ok) throw new Error(`Output unavailable (${read.code})`);
      return { text: Buffer.concat(read.frames.flatMap(frame => frame.t === 'bytes'
        ? [decodeTerminalStreamBytesFrame(frame)] : [])).toString('utf8'), done: read.done };
    };
    const tuple = await run('tuple');
    expect(await observe(tuple, true)).toMatchObject({ state: 'failed', domainRef: { exitCode: 23 } });
    const tupleOutput = await output(tuple);
    expect(tupleOutput.done).toBe(true);
    expect(tupleOutput.text).toContain('argv:<one argument><世界🚀>');
    expect(tupleOutput.text).toContain(`cwd:<${join(root, 'work space')}>`);
    expect(tupleOutput.text).toContain('env:<finite-config>');
    expect(tupleOutput.text).toContain(createHash('sha256').update(secretValue).digest('hex'));
    expect(tupleOutput.text).not.toContain(secretValue);

    // Establish the exact native path before treating a refusal as evidence.
    const nativeSelection = { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } as const;
    const control = ProjectCommandActionOutputV1Schema.parse(await action('projects.script.run', {
      workspace: opened.workspace, selection: nativeSelection,
    })).operation.operationId;
    expect(await observe(control, true)).toMatchObject({ state: 'succeeded', domainRef: { exitCode: 0 } });
    expect(await output(control)).toMatchObject({ done: true, text: expect.stringContaining('NATIVE_REVIEWED') });
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('reviewed\n');

    const hold = await run('hold');
    await waitFor(async () => (await output(hold)).text.includes('BEGIN'), { context: 'running Script output' });
    const queued = await run('native');
    await waitFor(async () => {
      const operation = await observe(queued);
      return operation.progress?.kind === 'phase' && operation.progress.phase === 'queued';
    }, { context: 'native Script queued behind running Script' });
    const listed = ActionOperationListV1ResponseSchema.parse(await action('action.operations.list', machine.target));
    expect(listed.items.map(item => item.operationId)).toEqual(expect.arrayContaining([tuple, hold, queued]));
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('reviewed\n');
    // The native declaration and Makefile stay identical. The selected recipe's
    // executed file changes while accepted work waits for its finite slot.
    await writeFile(join(root, 'task.sh'), 'printf "changed\\n" >> effects\nprintf "NATIVE_CHANGED\\n"\n');
    await action('action.operations.cancel', { ...machine.target, operationId: hold });
    expect(await observe(hold, true)).toMatchObject({ state: 'cancelled' });
    expect(await output(hold)).toMatchObject({ done: true, text: expect.stringContaining('BEGIN') });
    expect((await output(hold)).text).not.toContain('DONE');
    expect(await observe(queued, true)).toMatchObject({ state: 'failed', error: { errorCode: 'project_script_effect_changed' } });
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('reviewed\n');

    // A fresh deliberate Run accepts the current executable and reaches output.
    const retried = await run('native');
    expect(await observe(retried, true)).toMatchObject({ state: 'succeeded', domainRef: { exitCode: 0 } });
    expect(await output(retried)).toMatchObject({ done: true, text: expect.stringContaining('NATIVE_CHANGED') });
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('reviewed\nchanged\n');

    const admitted = await run('hold');
    await waitFor(async () => (await output(admitted)).text.includes('BEGIN'), { context: 'admitted Script before withdrawal' });
    await policy(false);
    const refusedRequestId = randomUUID();
    expect(await execute('projects.script.run', { workspace: opened.workspace, selection: nativeSelection }, refusedRequestId))
      .toMatchObject({ ok: false, errorCode: 'not_accepting' });
    const refusedList = ActionOperationListV1ResponseSchema.parse(await action('action.operations.list', machine.target));
    const refused = refusedList.items.find(item => item.actionId === 'projects.script.run' && item.requestId === refusedRequestId);
    expect(refused).toMatchObject({ state: 'failed', error: { errorCode: 'not_accepting' } });
    await writeFile(join(root, 'allow-finish'), 'finish admitted work');
    expect(await observe(admitted, true)).toMatchObject({ state: 'succeeded', domainRef: { exitCode: 0 } });
    expect(await output(admitted)).toMatchObject({ done: true, text: expect.stringContaining('DONE') });
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('reviewed\nchanged\n');
  } finally { await ui.close(); }
}, 0);
