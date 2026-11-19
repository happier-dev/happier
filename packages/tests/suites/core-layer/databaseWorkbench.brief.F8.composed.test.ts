import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ProjectDefinitionInspectInputSchema, ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectRepositoryObservationV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { SessionTranscriptGetResultSchema } from '@happier-dev/protocol/actions/specs/session/transcript';
import { SessionInputHandoffInputV1Schema, SessionInputHandoffResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputHandoffV1';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
  DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1, DATABASE_STATS_READ_ACTION_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import {
    DatabaseFindingBaselineV1Schema,
    DatabaseFindingBriefBuildInputV1Schema,
    DatabaseFindingBriefBuildResultV1Schema,
    DatabaseFindingReadInputV1Schema,
    DatabaseFindingReadResultV1Schema,
    DatabaseFindingsListInputV1Schema,
    DatabaseFindingsListResultV1Schema,
} from '@happier-dev/plugin-sdk/database';
import {
    DatabaseOperationResultV1Schema,
    DatabaseStatsOperationInputV1Schema,
    DatabaseTargetsListInputV1Schema,
    DatabaseTargetsListResultV1Schema,
} from '@happier-dev/plugin-sdk/database';
import { DatabaseStatsReasonV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

// The positive delivery is the G1 control. Setup/registration failures before
// that marker are prerequisites, never evidence for a negative behavior RED.
it('P4-F8-known-good-brief-delivery', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-insights-f8') });
  try {
    const session = await fixture.assertKnownGoodSessionControl(fixture.owner, fixture.machine);
    async function sessionUserMessages() {
      const arrival = await fixture.owner.execute('session.transcript.get', {
        sessionId: session.sessionId, roles: ['user'], includeStructuredPayload: true });
      if (!arrival.ok) throw new Error(`Session transcript refused (${arrival.errorCode})`);
      const transcript = SessionTranscriptGetResultSchema.parse(arrival.result);
      if (!transcript.ok || 'projection' in transcript) throw new Error('Session semantic transcript unavailable');
      return transcript.items;
    }
    const target = (await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'F8 selected')).target;
    const targetScope = fixture.scope;
    const targetsArrival = await fixture.executeDatabase(DATABASE_TARGETS_LIST_ACTION_ID_V1,
      DatabaseTargetsListInputV1Schema.parse({ scope: targetScope }));
    expect(targetsArrival.ok, JSON.stringify(targetsArrival)).toBe(true);
    if (!targetsArrival.ok) throw new Error(`F8 plugin target-list prerequisite refused (${targetsArrival.errorCode})`);
    expect(DatabaseTargetsListResultV1Schema.parse(targetsArrival.result).completeness.complete).toBe(true);
    console.info('P4-F8-Session-and-plugin-entry prerequisites passed', fixture.runtime);
    // Reuse the real Account-bound UI authoring recipe. Navigation is the
    // platform boundary; draft admission, persistence and editing stay real.
    const [{ connectUiActionClient }, { getActiveServerAccountScope }, { createFrontDoorActionExecute },
      { readNewSessionDraftProjectionFromRepository }, { createNewSessionComposerDocumentOwner },
      { composerAttachmentDraftToView }, { loadDaemonMergedProjectionCacheEntry },
      { createExistingSessionComposerDocumentOwner }, { projectComposerDocumentSnapshot },
      { registerSessionComposerPresentationTarget }] = await Promise.all([
      import('@happier-tests/ui-action-client'),
      import('../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope'),
      import('../../../../apps/ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor'),
      import('../../../../apps/ui/sources/components/sessions/composer/newSessionDraftRepositoryAdapter'),
      import('../../../../apps/ui/sources/components/sessions/composer/newSessionComposerDocumentOwner'),
      import('../../../../apps/ui/sources/components/sessions/composer/composerScopeAdapters'),
      import('../../../../apps/ui/sources/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
      import('../../../../apps/ui/sources/components/sessions/composer/existingSessionComposerDocumentOwner'),
      import('../../../../apps/ui/sources/components/sessions/composer/composerSnapshotProjection'),
      import('../../../../apps/ui/sources/components/sessions/presentation/sessionComposerPresentationTargets'),
    ]);
    const ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: fixture.owner.uiCredentials });
    try {
      await waitFor(() => ui.isAccountReady(), { context: 'F8 UI Account is ready' });
      const scope = getActiveServerAccountScope();
      if (!scope) throw new Error('F8 UI Account scope unavailable');
      let navigatedDraftId: string | undefined;
      const execute = createFrontDoorActionExecute(undefined, { sessionAuthoringPresentation: {
        navigateToNewSession: destination => { navigatedDraftId = destination.draftId; },
      } });
      const context = { surface: 'ui', authority: 'present_user', serverId: ui.serverId,
        expectedAccountId: scope.accountId, actionCaller: { kind: 'host' } } as const;
      const placement = { kind: 'exactTarget', serverId: ui.serverId,
        machineId: fixture.machine.target.machineId, directory: fixture.machine.workspaceDir } as const;
      const control = await execute('session.authoring.open', { seed: { prompt: 'F8 ordinary editable authoring control', placement } }, context);
      expect(control).toMatchObject({ ok: true, result: { kind: 'opened', destination: 'newSession' } });
      if (!navigatedDraftId) throw new Error('F8 ordinary authoring control did not navigate');
      expect(readNewSessionDraftProjectionFromRepository({ scope, draftId: navigatedDraftId })?.draft.input)
        .toBe('F8 ordinary editable authoring control');
      expect(createNewSessionComposerDocumentOwner({ scope,
        ref: { kind: 'newSession', instanceId: navigatedDraftId } }).read().document.text)
        .toBe('F8 ordinary editable authoring control');
      const projection = await loadDaemonMergedProjectionCacheEntry({
        machineId: fixture.machine.target.machineId, serverId: ui.serverId, sections: ['composerAttachments'] });
      if (projection?.kind !== 'ready') throw new Error(`F8 fixture daemon attachment projection unavailable (${projection?.kind ?? 'absent'})`);
      const catalog = projection.inputs.pluginUiProjection.composerAttachmentsById;
      let sessionsBefore = await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"');
      let deliveredBefore = await sessionUserMessages();
      async function authorTask(taskInput: unknown, idempotencyKey: string) {
        const arrival = await fixture.executeDatabase(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
          { task: taskInput });
        expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
        if (!arrival.ok) throw new Error(`Task brief build refused (${arrival.errorCode})`);
        const task = DatabaseFindingBriefBuildResultV1Schema.parse(arrival.result);
        if (!task.ok) throw new Error(`Task brief unavailable (${task.code})`);
        const authored = await execute(ActionIdSchema.parse('session.input.handoff'), SessionInputHandoffInputV1Schema.parse({
          v: 1, sessionChoice: { kind: 'new' }, delivery: 'compose', newSession: { kind: 'new', seed: { placement } },
          input: { text: task.brief.text, forgeEvidence: task.brief.evidence }, idempotencyKey,
        }), context);
        if (!authored.ok) throw new Error(`Task authoring refused (${authored.errorCode})`);
        const opened = SessionInputHandoffResultV1Schema.parse(authored.result);
        expect(opened, JSON.stringify(opened)).toMatchObject({ kind: 'authoringResult', result: { kind: 'opened', destination: 'newSession' } });
        if (opened.kind !== 'authoringResult' || opened.result.kind !== 'opened') throw new Error('Task did not open an editable New draft');
        const taskComposer = createNewSessionComposerDocumentOwner({ scope,
          ref: { kind: 'newSession', instanceId: opened.result.draftId } });
        const beforeEdit = taskComposer.read();
        expect(beforeEdit.document.text).toBe(task.brief.text);
        const taskDraft = readNewSessionDraftProjectionFromRepository({ scope, draftId: opened.result.draftId })?.draft;
        for (const evidence of task.brief.evidence.items) {
          expect(JSON.stringify(taskDraft?.composerAttachmentSeeds ?? [])).toContain(JSON.stringify(evidence.text).slice(1, -1));
        }
        taskComposer.apply(beforeEdit.revision, { text: `${beforeEdit.document.text}\nF8_TASK_PERSON_REVIEW`, references: [],
          attachments: beforeEdit.document.composerAttachments.map(attachment =>
            composerAttachmentDraftToView(attachment, { entriesById: catalog })) });
        expect(createNewSessionComposerDocumentOwner({ scope,
          ref: { kind: 'newSession', instanceId: opened.result.draftId } }).read().document.text).toContain('F8_TASK_PERSON_REVIEW');
        expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"')).toBe(sessionsBefore);
        expect(await sessionUserMessages()).toEqual(deliveredBefore);
        return task;
      }

      // Detect the fixture's real declarations through the public Project owner;
      // telemetry setup is scoped to the worktree and requires no database target.
      await writeFile(join(fixture.machine.workspaceDir, 'package.json'), JSON.stringify({
        name: 'dbw-f8-telemetry-app', engines: { node: '>=22' },
        dependencies: { next: '*' }, scripts: { start: 'next start --port 3000' },
      }));
      const inspectedArrival = await fixture.owner.execute('projects.inspect', ProjectDefinitionInspectInputSchema.parse({
        workspace: target.workspace, read: { kind: 'applications' },
      }), { presentUserConfirmation: { actionId: 'projects.inspect' } });
      if (!inspectedArrival.ok) throw new Error(`Telemetry stack inspection refused (${inspectedArrival.errorCode})`);
      const detection = ProjectDefinitionInspectOutputSchema.parse(inspectedArrival.result).detection;
      expect(detection.applications).toEqual(expect.arrayContaining([expect.objectContaining({
        framework: 'next', runtime: { name: 'node', version: '>=22' },
      })]));
      const repositoryObservation = ProjectRepositoryObservationV1Schema.parse({ observedAtMs: detection.observedAtMs,
        coverage: detection.coverage, rootFiles: detection.rootFiles,
        applications: detection.applications?.map(({ file, framework, runtime }) => ({ file, framework, runtime })),
      });
      const telemetry = await authorTask({ kind: 'add_telemetry', scope: targetScope,
        sourceScope: fixture.machine.target, repositoryObservation }, 'dbw-f8-add-telemetry-review');
      const telemetryTasks = telemetry.brief.evidence.items
        .filter(item => item.source.kind === 'databaseFinding')
        .map(item => JSON.parse(item.text).task);
      expect(telemetryTasks).toContainEqual({ kind: 'add_telemetry', scope: targetScope,
        sourceScope: fixture.machine.target, repositoryObservation });
      expect(JSON.stringify(telemetry.brief).includes(fixture.postgres.selectedDatabaseUrl)).toBe(false);
      const secret = 'F8_PRIVATE_LITERAL_MUST_NOT_REACH_SESSION';
      await fixture.postgres.sql('dbw_selected', `CREATE TABLE dbw_f8_workload (id integer, private_value text);
        INSERT INTO dbw_f8_workload VALUES (1, '${secret}');
        SELECT sum(id) FROM dbw_f8_workload WHERE private_value = '${secret}';`);
      const request = { kind: 'stats.read', group: 'statements',
        selection: { page: { rows: 80 }, order: 'totalTime' } } as const;
      const statsArrival = await fixture.executeDatabase(DATABASE_STATS_READ_ACTION_ID_V1,
        DatabaseStatsOperationInputV1Schema.parse({ operation: 'stats.read', target, request }));
      expect(statsArrival.ok, JSON.stringify(statsArrival)).toBe(true);
      if (!statsArrival.ok) throw new Error(`F8 native stats prerequisite refused (${statsArrival.errorCode})`);
      const stats = DatabaseOperationResultV1Schema.parse(statsArrival.result);
      expect(stats).toMatchObject({ ok: true, operation: 'stats.read',
        observation: { status: 'available', group: 'statements', scope: { database: 'dbw_selected' } } });
      if (!stats.ok || stats.operation !== 'stats.read' || stats.observation.status !== 'available'
        || stats.observation.group !== 'statements') throw new Error('F8 native stats prerequisite unavailable');
      expect(stats.observation.data.some(row => row.shape?.includes('dbw_f8_workload') && /sum/iu.test(row.shape))).toBe(true);
      // This diagnoses native setup before the positive finding/delivery path;
      // the full F8 G1 still requires actual brief delivery and verification.
      console.info('P4-F8-native-stats prerequisite passed', fixture.runtime);
      const listedArrival = await fixture.executeDatabase(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
        DatabaseFindingsListInputV1Schema.parse({ target, request }));
      expect(listedArrival.ok, JSON.stringify(listedArrival)).toBe(true);
      if (!listedArrival.ok) throw new Error(`Finding list refused (${listedArrival.errorCode})`);
      const listed = DatabaseFindingsListResultV1Schema.parse(listedArrival.result);
      if (!listed.ok) throw new Error(`Finding list unavailable (${listed.code})`);
      expect(listed.findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(listed)).not.toContain(secret);

      // Select the real workload through source-owned detail, not a synthetic
      // finding or a direct call to the brief builder.
      let selected: { input: ReturnType<typeof DatabaseFindingReadInputV1Schema.parse>;
        baseline: ReturnType<typeof DatabaseFindingBaselineV1Schema.parse> } | undefined;
      for (const entry of listed.findings) {
        const input = DatabaseFindingReadInputV1Schema.parse({ target, request, recordKey: entry.recordKey });
        const arrival = await fixture.executeDatabase(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1, input);
        if (!arrival.ok) throw new Error(`Finding detail refused (${arrival.errorCode})`);
        const detail = DatabaseFindingReadResultV1Schema.parse(arrival.result);
        if (!detail.ok) throw new Error(`Finding detail unavailable (${detail.code})`);
        expect(JSON.stringify(detail)).not.toContain(secret);
        if (!detail.finding.normalizedShape?.includes('dbw_f8_workload') || !/sum/iu.test(detail.finding.normalizedShape)) continue;
        selected = { input, baseline: DatabaseFindingBaselineV1Schema.parse({ ...listed.observation,
          summary: entry.summary, basis: detail.finding.verification.basis }) };
        break;
      }
      expect(selected, 'The live workload must produce a selectable finding').toBeDefined();
      if (!selected) throw new Error('Live workload finding missing');
      const builtArrival = await fixture.executeDatabase(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
        DatabaseFindingBriefBuildInputV1Schema.parse({ ...selected.input, baseline: selected.baseline }));
      if (!builtArrival.ok) throw new Error(`Brief build refused (${builtArrival.errorCode})`);
      const built = DatabaseFindingBriefBuildResultV1Schema.parse(builtArrival.result);
      if (!built.ok) throw new Error(`Brief build unavailable (${built.code})`);
      expect(built.brief.text.length).toBeGreaterThan(0);
      expect(JSON.stringify(built.brief)).not.toContain(secret);
      expect(JSON.stringify(built.brief).includes(fixture.postgres.selectedDatabaseUrl), 'The brief must omit the target URL').toBe(false);
      expect(JSON.stringify(built.brief.evidence)).toContain(selected.baseline.evidenceIdentity);
      expect(built.brief.evidence.items.map(item => item.text).join('\n')).toContain(JSON.stringify(selected.baseline.summary));

      const editedText = `${built.brief.text}\n\nF8_EDITED_REQUEST: explain the measured cause before changing anything.`;
      const input = SessionInputHandoffInputV1Schema.parse({ v: 1,
        sessionChoice: { kind: 'existing', session: session.sessionId }, delivery: 'send',
        input: { text: editedText, forgeEvidence: built.brief.evidence }, idempotencyKey: 'dbw-f8-one-brief' });
      async function send() {
        const arrival = await fixture.owner.execute(ActionIdSchema.parse('session.input.handoff'), input);
        if (!arrival.ok) throw new Error(`Shared handoff refused (${arrival.errorCode})`);
        return SessionInputHandoffResultV1Schema.parse(arrival.result);
      }
      const delivered = await send();
      expect(delivered).toMatchObject({ kind: 'sendResult', session: { serverId: fixture.serverId, sessionId: session.sessionId },
        result: { status: 'accepted' } });

      async function deliveredMessages() {
        return (await sessionUserMessages()).filter(item => item.text?.includes('F8_EDITED_REQUEST'));
      }
      await waitFor(async () => (await deliveredMessages()).length === 1,
        { context: 'The shared host delivers the edited live brief to the selected Session' });
      async function verifyTarget() {
        const verified = await fixture.executeDatabase(DATABASE_STATS_READ_ACTION_ID_V1,
          DatabaseStatsOperationInputV1Schema.parse({ operation: 'stats.read', target, request }));
        if (!verified.ok) throw new Error(`Verification refused (${verified.errorCode})`);
        expect(DatabaseOperationResultV1Schema.parse(verified.result)).toMatchObject({ ok: true, operation: 'stats.read',
          observation: { status: 'available', scope: { database: 'dbw_selected' } } });
      }
      await verifyTarget();
      console.info('P4-F8-known-good-brief-delivery passed', fixture.runtime);

      // A configured Start has one content owner. Reject a second authored
      // initial input before native creation can start either copy.
      const updatedAtMs = Date.now();
      const spawn = SessionSpawnNewActionInputV2Schema.parse({ executionTarget: fixture.machine.target,
        directory: { kind: 'path', path: fixture.machine.workspaceDir },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionMode: 'read-only', approvalProfileId: null,
        configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
          permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
        connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
      });
      const configured = { v: 1, sessionChoice: { kind: 'configured' }, delivery: 'configured',
        defaults: { destination: { kind: 'new', seed: {}, spawn }, delivery: 'send' },
        input: { text: 'F8_CONFIGURED_SINGLE_INPUT', forgeEvidence: built.brief.evidence },
        idempotencyKey: 'dbw-f8-configured-once' } as const;
      const sessionsBeforeInvalid = await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"');
      // Deliberately cross the real Action input boundary without local parse:
      // the executor must reject this second content field, not strip it here.
      const duplicateInput = await fixture.owner.execute(ActionIdSchema.parse('session.input.handoff'), {
        ...configured, defaults: { ...configured.defaults, destination: { ...configured.defaults.destination,
          spawn: { ...spawn, initialInput: { text: 'F8_DUPLICATE_MUST_NOT_START' } } } },
      });
      expect(duplicateInput).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"')).toBe(sessionsBeforeInvalid);
      const configuredArrival = await fixture.owner.execute(ActionIdSchema.parse('session.input.handoff'),
        SessionInputHandoffInputV1Schema.parse(configured));
      if (!configuredArrival.ok) throw new Error(`Configured New refused (${configuredArrival.errorCode})`);
      const configuredResult = SessionInputHandoffResultV1Schema.parse(configuredArrival.result);
      expect(configuredResult).toMatchObject({ kind: 'sendResult', result: { status: 'accepted' } });
      if (configuredResult.kind !== 'sendResult') throw new Error('Configured Start did not return native send settlement');
      expect(await fixture.owner.readSessionMetadata(configuredResult.session.sessionId))
        .toMatchObject({ machineId: fixture.machine.target.machineId, path: fixture.machine.workspaceDir });
      await waitFor(async () => {
        const arrival = await fixture.owner.execute('session.transcript.get', {
          sessionId: configuredResult.session.sessionId, roles: ['user'] });
        if (!arrival.ok) throw new Error(`Configured Session transcript refused (${arrival.errorCode})`);
        const transcript = SessionTranscriptGetResultSchema.parse(arrival.result);
        if (!transcript.ok || 'projection' in transcript) throw new Error('Configured Session semantic transcript unavailable');
        const inputs = transcript.items.filter(item => item.text?.includes('F8_CONFIGURED_SINGLE_INPUT'));
        expect(transcript.items.some(item => item.text?.includes('F8_DUPLICATE_MUST_NOT_START'))).toBe(false);
        return inputs.length === 1;
      }, { context: 'Configured Start delivers exactly the one handoff input' });

      // Configured Start above creates a Session deliberately. Subsequent
      // preview assertions compare with that current baseline.
      sessionsBefore = await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"');
      deliveredBefore = await sessionUserMessages();
      navigatedDraftId = undefined;
      const previewText = `${built.brief.text}\n\nF8_NEW_PREVIEW_ONLY`;
      const preview = await execute(ActionIdSchema.parse('session.input.handoff'), SessionInputHandoffInputV1Schema.parse({
        v: 1, sessionChoice: { kind: 'new' }, delivery: 'send',
        newSession: { kind: 'new', seed: { placement } },
        input: { text: previewText, forgeEvidence: built.brief.evidence }, idempotencyKey: 'dbw-f8-preview-only',
      }), context);
      expect(preview.ok, JSON.stringify(preview)).toBe(true);
      if (!preview.ok) throw new Error(`New brief authoring refused (${preview.errorCode})`);
      const openedPreview = SessionInputHandoffResultV1Schema.parse(preview.result);
      expect(openedPreview).toMatchObject({ kind: 'authoringResult', result: { kind: 'opened', destination: 'newSession' } });
      if (openedPreview.kind !== 'authoringResult' || openedPreview.result.kind !== 'opened') {
        throw new Error('Explicit New did not open the ordinary editable draft');
      }
      expect(navigatedDraftId).toBe(openedPreview.result.draftId);
      const composer = createNewSessionComposerDocumentOwner({ scope,
        ref: { kind: 'newSession', instanceId: openedPreview.result.draftId } });
      const snapshot = composer.read();
      expect(snapshot.document.text).toBe(previewText);
      const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: openedPreview.result.draftId })?.draft;
      expect(JSON.stringify(draft?.composerAttachmentSeeds ?? []), 'The ordinary draft must retain the descriptive brief seed')
        .toContain(selected.baseline.evidenceIdentity);
      expect(JSON.stringify(snapshot.document)).not.toContain(secret);
      composer.apply(snapshot.revision, { text: `${previewText}\nF8_PERSON_EDIT`, references: [],
        attachments: snapshot.document.composerAttachments.map(attachment =>
          composerAttachmentDraftToView(attachment, { entriesById: catalog })) });
      const persisted = createNewSessionComposerDocumentOwner({ scope,
        ref: { kind: 'newSession', instanceId: openedPreview.result.draftId } }).read().document;
      expect(persisted.text).toContain('F8_PERSON_EDIT');
      expect(JSON.stringify(readNewSessionDraftProjectionFromRepository({ scope,
        draftId: openedPreview.result.draftId })?.draft.composerAttachmentSeeds ?? [])).toContain(selected.baseline.evidenceIdentity);
      expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"')).toBe(sessionsBefore);
      expect(await sessionUserMessages()).toEqual(deliveredBefore);

      // Mount the real document and actual daemon attachment catalog. Only
      // native editor focus is a platform boundary; no internal editor/Action
      // orchestration or attachment admission is replaced.
      const ref = { kind: 'session', sessionId: session.sessionId } as const;
      const existingComposer = createExistingSessionComposerDocumentOwner({ scope, ref });
      let focused = false;
      const unmount = registerSessionComposerPresentationTarget({ serverId: ui.serverId, sessionId: session.sessionId }, {
        readScope: () => scope,
        readAttachmentComposition: () => ({ composerAttachmentsById: catalog }),
        readRevision: () => existingComposer.read().revision,
        replace: text => existingComposer.replaceDocument({ ...existingComposer.read().document, text }),
        readSnapshot: () => projectComposerDocumentSnapshot({ owner: existingComposer,
          attachmentCatalog: { entriesById: catalog }, presentation: { layout: 'wrap', focused,
            editable: true, submittable: true, submitting: false, running: false } }),
        commitDocument: ({ expectedRevision, mutation }) => existingComposer.apply(expectedRevision, mutation),
        commitDocumentEmitsChange: true,
        focusComposer: () => { focused = true; return true; },
      });
      try {
        const composerControl = await execute('composer.transaction.apply', { scope, ref,
          transaction: { expectedRevision: existingComposer.read().revision,
            operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'F8_COMPOSE_CONTROL\n' }] } }, context);
        expect(composerControl).toMatchObject({ ok: true, result: { status: 'applied' } });
        expect(existingComposer.read().document.text).toContain('F8_COMPOSE_CONTROL');
        const composed = await execute(ActionIdSchema.parse('session.input.handoff'), SessionInputHandoffInputV1Schema.parse({
          v: 1, sessionChoice: { kind: 'existing', session: session.sessionId }, delivery: 'compose',
          input: { text: 'F8_EXISTING_PREVIEW_ONLY', forgeEvidence: built.brief.evidence },
          idempotencyKey: 'dbw-f8-existing-compose',
        }), context);
        expect(composed.ok, JSON.stringify(composed)).toBe(true);
        if (!composed.ok) throw new Error(`Mounted brief compose refused (${composed.errorCode})`);
        expect(SessionInputHandoffResultV1Schema.parse(composed.result)).toMatchObject({
          kind: 'composed', destination: { kind: 'existing', session: { sessionId: session.sessionId } } });
        expect(existingComposer.read().document.text).toContain('F8_COMPOSE_CONTROL');
        expect(existingComposer.read().document.text).toContain('F8_EXISTING_PREVIEW_ONLY');
        expect(JSON.stringify(existingComposer.read().document.composerAttachments)).toContain(selected.baseline.evidenceIdentity);
        expect(focused).toBe(true);
        expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"')).toBe(sessionsBefore);
        expect(await sessionUserMessages()).toEqual(deliveredBefore);

        // A local target without setup support uses the same editable task
        // path. Preparing it must leave native configuration and the running
        // server untouched; the typed diagnosis comes from the real read.
        const setupTarget = (await fixture.connectDatabase(fixture.postgres.noExtensionDatabaseUrl, 'F8 setup')).target;
        const setupDiagnostics = `SELECT
          pg_postmaster_start_time()::text, current_setting('shared_preload_libraries'),
          (SELECT coalesce(json_agg(setting ORDER BY seqno)::text, '[]') FROM pg_file_settings
            WHERE name = 'shared_preload_libraries'),
          (SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements')`;
        const setupBefore = await fixture.postgres.sql('dbw_no_extension', setupDiagnostics);
        const missingArrival = await fixture.executeDatabase(DATABASE_STATS_READ_ACTION_ID_V1,
          DatabaseStatsOperationInputV1Schema.parse({ operation: 'stats.read', target: setupTarget, request }));
        if (!missingArrival.ok) throw new Error(`Setup diagnosis refused (${missingArrival.errorCode})`);
        const missing = DatabaseOperationResultV1Schema.parse(missingArrival.result);
        if (!missing.ok || missing.operation !== 'stats.read' || missing.observation.status !== 'unavailable') {
          throw new Error('The prerequisite-negative target must supply its typed setup diagnosis');
        }
        expect(missing.observation).toMatchObject({ group: 'statements',
          reason: DatabaseStatsReasonV1Schema.parse('extension_missing') });
        const task = await authorTask({ kind: 'enable_pg_stat_statements', target: setupTarget,
          sourceScope: fixture.machine.target, engineId: missing.observation.engineId,
          stats: { request, reason: missing.observation.reason } }, 'dbw-f8-pgss-new-review');
        expect(JSON.stringify(task.brief.evidence)).toContain(missing.observation.reason);
        expect(task.brief.evidence.items.map(item => item.text).join('\n')).toContain(JSON.stringify(setupTarget));
        expect(task.brief.text).toMatch(/review/iu);
        expect(task.brief.text).toMatch(/restart/iu);
        expect(JSON.stringify(task.brief).includes(fixture.postgres.noExtensionDatabaseUrl),
          'Setup guidance must preserve a structural target without its credential URL').toBe(false);
        const taskText = `${task.brief.text}\n\nF8_SETUP_REVIEW_ONLY`;
        const setupPreview = await execute(ActionIdSchema.parse('session.input.handoff'), SessionInputHandoffInputV1Schema.parse({
          v: 1, sessionChoice: { kind: 'existing', session: session.sessionId }, delivery: 'compose',
          input: { text: taskText, forgeEvidence: task.brief.evidence }, idempotencyKey: 'dbw-f8-setup-review',
        }), context);
        expect(setupPreview.ok, JSON.stringify(setupPreview)).toBe(true);
        if (!setupPreview.ok) throw new Error(`Setup task preview refused (${setupPreview.errorCode})`);
        expect(SessionInputHandoffResultV1Schema.parse(setupPreview.result)).toMatchObject({ kind: 'composed' });
        const taskSnapshot = existingComposer.read();
        expect(taskSnapshot.document.text).toContain(taskText);
        expect(JSON.stringify(taskSnapshot.document.composerAttachments)).toContain(missing.observation.reason);
        existingComposer.apply(taskSnapshot.revision, {
          text: `${taskSnapshot.document.text}\nF8_SETUP_PERSON_EDIT`, references: [],
          attachments: taskSnapshot.document.composerAttachments.map(attachment =>
            composerAttachmentDraftToView(attachment, { entriesById: catalog })),
        });
        expect(existingComposer.read().document.text).toContain('F8_SETUP_PERSON_EDIT');
        expect(await fixture.postgres.sql('dbw_no_extension', setupDiagnostics)).toBe(setupBefore);
        expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Session"')).toBe(sessionsBefore);
        expect(await sessionUserMessages()).toEqual(deliveredBefore);
      } finally {
        unmount();
      }
      // Current verification is allowed to advance. The selected before numbers
      // must remain the inline baseline supplied by this person intent.
      await fixture.postgres.sql('dbw_selected',
        `SELECT sum(id) FROM dbw_f8_workload WHERE private_value = '${secret}';`);
      const rebuiltArrival = await fixture.executeDatabase(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
        DatabaseFindingBriefBuildInputV1Schema.parse({ ...selected.input, baseline: selected.baseline }));
      if (!rebuiltArrival.ok) throw new Error(`Brief rebuild refused (${rebuiltArrival.errorCode})`);
      const rebuilt = DatabaseFindingBriefBuildResultV1Schema.parse(rebuiltArrival.result);
      if (!rebuilt.ok) throw new Error(`Brief rebuild unavailable (${rebuilt.code})`);
      expect(rebuilt.brief.evidence.items.map(item => item.text).join('\n')).toContain(JSON.stringify(selected.baseline.summary));

      // Only after the positive control: repeat the same person intent through
      // Pending and confirm one actual user input, not merely an accepted flag.
      expect(await send()).toMatchObject({ kind: 'sendResult', result: { status: 'alreadyAccepted' } });
      const messages = await deliveredMessages();
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain(secret);
      expect(JSON.stringify(messages).includes(fixture.postgres.selectedDatabaseUrl), 'The Session must omit the target URL').toBe(false);

      // Verification reaches the same engine after delivery, with the safe inline
      // baseline still held by the caller rather than a daemon sample registry.
      await verifyTarget();
    } finally {
      await ui.close();
    }
  } finally {
    await fixture.stop();
  }
}, 0);
