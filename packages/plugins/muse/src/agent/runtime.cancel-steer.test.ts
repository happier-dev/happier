import { expect, it } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.js';
import { readMuseRecord } from './events.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

it.each(['steer', 'cancel'] as const)('routes %s to the actual owning native turn without a second final', async control => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-control-'));
  const nativeNotificationPath = join(scratch, 'native-notification.json');
  const recordingPath = fileURLToPath(new URL('./testkit/fixtures/advanced.json', import.meta.url));
  const capture = readMuseRecord(JSON.parse(await readFile(recordingPath, 'utf8')));
  if (!Array.isArray(capture.rows)) throw new Error('Expected captured native rows');
  const rows = capture.rows;
  const rowMessage = (index: number) => readMuseRecord(readMuseRecord(rows[index]).message);
  const capturedOwningTurn = readMuseRecord(rowMessage(81).params).turnId;
  const capturedSteerCommand = readMuseRecord(rowMessage(97).params).commandId;
  const nativeParts = readMuseRecord(rowMessage(97).params).input;
  if (!Array.isArray(nativeParts)) throw new Error('Expected captured native steer input');
  const steerText = nativeParts.map(part => readMuseRecord(part).text).filter((text): text is string => typeof text === 'string').join('');
  const events = createAgentSessionRuntimeHarness();
  let fixture: Awaited<ReturnType<typeof createAdmittedMuseSessionFixture>> | undefined;
  let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | undefined;
  try {
    fixture = await createAdmittedMuseSessionFixture({ native: { recordingPath, nativeNotificationPath, playbackSteps: [
      { requestRow: 6, receiveUntilRow: 11 },
      // Captured owning start prefix before its approval request; the control
      // windows below are an explicit schema-derived composition of this capture.
      { requestRow: 78, receiveUntilRow: 84 },
      ...(control === 'steer' ? [{ requestRow: 97, receiveUntilRow: 99 }] : [{ requestRow: 104, receiveUntilRow: 113 }]),
    ] } });
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    const capabilities = readAgentSessionCapabilities(PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse'));
    if (!capabilities) throw new Error('Expected admitted Muse capability facts');
    session.watch(events.recordRuntimeEvent);
    operations = createNativeAgentSessionInteractionOperations({ session, sessionId: 'host-admitted-muse',
      cwd: process.cwd(), context: fixture.context, capabilities, publications: fixture.publications });
    await fixture.run(() => operations!.sendTurnPrompt('Run the captured shell task.', { localId: 'owning-input', turnId: 'owning-turn' }));
    const started = await events.until('turn-start', { signal: fixture.context.signal });
    const nativeTurnId = started.agentTurnId;
    if (typeof nativeTurnId !== 'string') throw new Error('Expected accepted native owning turn');
    if (control === 'steer') {
      await fixture.run(() => operations!.steerInFlightTurn(steerText, { localId: 'steer-input' }));
    } else {
      await fixture.run(() => operations!.cancelTurn());
    }
    const auditBeforeTerminal = await fixture.readAudit();
    const steerCommand = auditBeforeTerminal.commandTargets.find(target => target.method === 'turn/steer')?.commandId;
    // A captured eventual external terminal makes the missing-cancel RED finite.
    // When native cancel already released this terminal, replay must stay one final.
    const notifications = control === 'steer'
      ? rows.slice(106, 113).map(row => readMuseRecord(row).message)
      : [rowMessage(110), rowMessage(112)];
    const remapped = JSON.parse(JSON.stringify(notifications), (_key, value) =>
      value === capturedOwningTurn ? nativeTurnId
        : steerCommand && value === capturedSteerCommand ? steerCommand : value);
    await writeFile(`${nativeNotificationPath}.complete`, JSON.stringify(remapped));
    await rename(`${nativeNotificationPath}.complete`, nativeNotificationPath);
    await events.until('turn-cancelled', { signal: fixture.context.signal });
    await operations.resetOrDisposeRuntime('session_closed'); operations = undefined;
    const audit = await fixture.readAudit();
    const nativeControl = audit.commandTargets.filter(target => target.method === `turn/${control === 'steer' ? 'steer' : 'interrupt'}`);
    expect(nativeControl).toHaveLength(1);
    expect(nativeControl[0]).toMatchObject(control === 'steer' ? { expectedTurnId: nativeTurnId } : { turnId: nativeTurnId });
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/unqueue')).toEqual([]);
    events.expectExactlyOneTerminalEvent({ turnId: 'owning-turn' });
    expect(events.canonicalEvents().filter(event => event.kind === 'turn-rollback-boundary')).toEqual([]);
    events.expectAllEventsValidated();
    expect(events.canonicalEvents().filter(event => event.kind === 'turn-start')).toHaveLength(1);
    expect(events.canonicalEvents().filter(event => event.kind === 'transcript-message-committed' && event.role === 'user'))
      .toHaveLength(0);
    expect(events.canonicalEvents().filter(event => event.kind === 'input-accepted')).toHaveLength(control === 'steer' ? 2 : 1);
  } finally {
    await operations?.resetOrDisposeRuntime('session_closed');
    events.dispose();
    await fixture?.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('reports a native queued race as accepted without withdrawing or interrupting it', async () => {
  const recordingPath = fileURLToPath(new URL('./testkit/fixtures/advanced.json', import.meta.url));
  const events = createAgentSessionRuntimeHarness();
  const fixture = await createAdmittedMuseSessionFixture({ native: { recordingPath, playbackSteps: [
    { requestRow: 6, receiveUntilRow: 11 },
    // Observed queued acknowledgement, composed after an idle startup: native
    // background work can win the accepted race after host readiness admission.
    { requestRow: 92, receiveUntilRow: 94 },
  ] } });
  let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | undefined;
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    session.watch(events.recordRuntimeEvent);
    const capabilities = readAgentSessionCapabilities(PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse'));
    if (!capabilities) throw new Error('Expected admitted Muse capability facts');
    operations = createNativeAgentSessionInteractionOperations({ session, sessionId: 'host-admitted-muse',
      cwd: process.cwd(), context: fixture.context, capabilities, publications: fixture.publications });
    await fixture.run(() => operations!.sendTurnPrompt('QUEUED_SECOND_TURN', { localId: 'queued-race-input', turnId: 'queued-race-turn' }));
    expect(events.canonicalEvents().filter(event => event.kind === 'input-accepted'))
      .toMatchObject([{ inputIds: ['queued-race-input'], delivery: { kind: 'newTurn', turnId: 'queued-race-turn' } }]);
    expect(events.canonicalEvents().filter(event => event.kind === 'turn-start' || event.kind === 'turn-complete'
      || event.kind === 'turn-cancelled' || event.kind === 'input-rejected' || event.kind === 'input-custody-unknown')).toEqual([]);
    events.expectAllEventsValidated();
    await operations.resetOrDisposeRuntime('session_closed'); operations = undefined;
    const audit = await fixture.readAudit();
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/unqueue' || method === 'turn/interrupt')).toEqual([]);
  } finally { await operations?.resetOrDisposeRuntime('session_closed'); events.dispose(); await fixture.dispose(); }
});
