import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema, PromptLibraryRowMutationV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowPayloadV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { Metadata } from '@/api/types';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveProfileCatalog, commitActivePromptLibraryCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountPromptStackSources, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { migrateProjectPromptStackSkillRules, readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { projectAccountRowsReadHttpResponse } from './projectAccountRows.testkit';
import { prepareSessionStackSkillMigration, applyStartupMetadataUpdateToSession } from '@/agent/runtime/startupMetadataUpdate';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { SessionSkillSelectionAuthoringV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { refreshActivePromptLibraryCatalog } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { applyReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { resolveSessionProjectPromptStack } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';
import { resolveRunnerSkills } from '@/prompts/skills/runtime/resolveRunnerSkills';
import { publishRunnerSkillNotice } from '@/prompts/skills/runtime/publishRunnerSkillNotice';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { removeSkillRulesV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { withTempDir } from '@/testkit/fs/tempDir';

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); withdrawActiveProjectAccountRowsSnapshot(); });

for (const failure of ['ready', 'preserved', 'shared', 'first-launch', 'first-shared', 'private-first-launch', 'provided-reach',
  'artifact-unavailable', 'rules-unavailable', 'rules-conflict'] as const) {
  it(`adds personal Project skill rules while retaining context custody (${failure})`, async () => {
    const migrationUnavailable = failure === 'artifact-unavailable' || failure === 'rules-unavailable' || failure === 'rules-conflict';
    const shared = failure === 'shared' || failure === 'first-shared';
    const serverId = failure === 'ready' || failure === 'shared' ? configuration.activeServerId : 'captured-project-home';
    const key = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
    const entry = (id: string, artifactId: string) => ({ id, ref: { kind: 'bundle' as const, artifactId },
      enabled: true, placement: 'system_append' as const });
    let payload = ProjectAccountRowPayloadV1Schema.parse({ key, value: {
      label: 'Retained label', promptStack: shared ? [entry('generic', 'generic')]
        : [entry('old-skill', 'skill'), entry('generic', 'generic')],
    } });
    let projectRevision = 3;
    let ruleRecord = PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: { v: 1, rules: [] } });
    let rulesRevision = 4;
    const effects: string[] = [];
    let consumedArtifactUnavailable = false;
    const storedArtifact = (id: string) => ({ id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: id,
        bundleSchemaId: id === 'generic' ? 'bundle.generic_v1' : 'skills.skill_md_v1' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
        { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${id}\ndescription: Useful\n---\nSkill instructions`).toString('base64') },
      ] }) }) });
    const attachments = [{ purpose: 'context', entry: entry('old-skill', 'skill') }];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      let result: unknown;
      if (url.pathname === '/v1/account/project-rows/list' || url.pathname === '/v1/account/project-rows/read') {
        const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
        result = projectAccountRowsReadHttpResponse([
          { key, revision: projectRevision, content: { t: 'plain', v: payload } },
          { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: {
            id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1,
            ...(shared ? { source: { sourceId: 'shared-source', revision: 1 } } : {}),
          } } } },
        ], url.pathname, raw).data;
      }
      else if (url.pathname === '/v1/projects/sources/shared-source') {
        expect(request.method).toBe('GET');
        result = { ok: true, canManage: false, source: { id: 'shared-source', revision: 1, name: 'Shared',
          createdByAccountId: 'owner', audience: [], attachments,
          repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git', visibility: 'public' }, protocol: 'https' } } };
      }
      else if (url.pathname === '/v1/account/project-rows/mutate') {
        const mutation = ProjectAccountRowMutationRequestV1Schema.parse(raw);
        effects.push('project');
        expect(effects[0]).toBe('rules');
        const content = mutation.mutations[0]!.content;
        if (!content || content.t !== 'plain') throw new Error('Expected plain Project mutation');
        payload = ProjectAccountRowPayloadV1Schema.parse(content.v); projectRevision++;
        result = { status: 'updated', cursor: 1, rows: [{ key, revision: projectRevision, content: { t: 'plain', v: payload } }] };
      } else if (url.pathname === '/v1/account/entity-rows/prompt-library') result = { status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(rowKey => ({ key: rowKey,
          revision: rowKey === 'skill-rules' ? rulesRevision : 1,
          content: { t: 'plain', v: rowKey === 'skill-rules'
            ? failure === 'rules-unavailable' ? { key: 'skill-rules', value: { v: 1, rules: 'unreadable' } } : ruleRecord
            : emptyPromptLibraryRecordV1(rowKey) } })) };
      else if (url.pathname === '/v1/account/entity-rows/prompt-library/skill-rules') {
        const mutation = PromptLibraryRowMutationV1Schema.parse(raw);
        if (!mutation.content || mutation.content.t !== 'plain') throw new Error('Expected plain rules mutation');
        if (failure === 'rules-conflict') result = { status: 'conflict', revision: rulesRevision };
        else {
          effects.push('rules');
          ruleRecord = PromptLibraryRecordV1Schema.parse(mutation.content.v); rulesRevision++;
          result = { status: 'updated', revision: rulesRevision, cursor: 1 };
        }
      } else if (url.pathname === '/v1/artifacts') result = [storedArtifact('skill')];
      else if (url.pathname.startsWith('/v1/artifacts/')) {
        if (failure === 'artifact-unavailable' || consumedArtifactUnavailable && url.pathname.endsWith('/skill')) {
          response.statusCode = 503; result = { error: 'unavailable' };
        }
        else {
          const id = url.pathname.split('/').at(-1)!;
          result = storedArtifact(id);
        }
      } else if (url.pathname === '/v1/account/encryption') result = { mode: 'plain', updatedAt: 1 };
      else if (url.pathname === '/v2/account/settings') result = { content: { t: 'plain', v: {} }, version: 7 };
      else if (url.pathname === '/v2/account/settings/history') result = { snapshots: [] };
      else if (url.pathname === '/v1/account/entity-rows/profiles/transfer') result = { status: 'absent' };
      else result = { mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
      response.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
    const base = `http://127.0.0.1:${address.port}`;
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null,
      requesterSessionCredentialScope: { serverId, serverHttpBaseUrl: base } };
    try {
      await runWithServerHttpBaseUrl(base, async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        if (failure === 'first-launch' || failure === 'first-shared' || failure === 'private-first-launch'
          || failure === 'provided-reach' || failure === 'rules-conflict') {
          await refreshActivePromptLibraryCatalog({ credentials });
          expect(ruleRecord).toMatchObject({ key: 'skill-rules', value: { rules: [] } });
          const snapshot = getActiveAccountSettingsSnapshot();
          if (!snapshot) throw new Error('Missing first-launch Account');
          const operationContext = failure === 'private-first-launch' ? createInvocationSavedSecretOperationContextV1({
            credentials, snapshot, serverHttpBaseUrl: base, isCurrent: async () => true,
          }) : undefined;
          if (operationContext) setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey({ ...credentials,
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'daemon-account' })).toString('base64url')}.signature` }) });
          const result = await withTempDir('project-skill-migration-', async happyHomeDir => {
            const store = createSkillStore({ happyHomeDir });
            try {
              return await resolveRunnerSkills({ ownerKey: 'session', agentId: 'test', machineId: 'machine', directory: '/repo',
                credentials, accountSnapshot: snapshot, operationContext, agentHasActionChannel: true,
                ...(failure === 'provided-reach' ? { reachContext: { machineId: 'machine', machinePlatform: 'posix',
                  directory: '/elsewhere', projectKey: 'other-project', agentId: 'test' } as const } : {}),
                sessionMetadata: Object.assign(createTestMetadata({ path: '/repo', machineId: 'machine' }),
                  { workspaceId: 'checkout', projectId: 'project' }),
                contributes: { catalogEntriesById: { test: { skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' } } } },
              }, { ensureSessionDir: request => store.ensureSkillSessionDir(request) });
            } finally {
              await store.releaseSkillSessionDirs('session');
              await store.collectSkillCache({ libraryDigests: [] });
            }
          });
          if (failure === 'rules-conflict') {
            expect(result.unavailable).toBe(true);
            expect(result.delivery).toBeUndefined();
            const events: unknown[] = [];
            await publishRunnerSkillNotice({ enqueueSessionEventCommitted: async (event: unknown) => {
              events.push(event); return { persisted: true as const, delivered: false as const };
            } }, result);
            expect(events.map(readSessionCapabilityNoticeV1)).toEqual([{ v: 1, items: [{ kind: 'skill', name: 'Skills',
              code: 'skills_unavailable', detail: 'project_skill_migration_unavailable' }] }]);
          } else {
            if (failure === 'provided-reach') {
              // The different Project excludes its migrated skill; the Everywhere guide remains on.
              expect(result.reach?.context).toEqual({ machineId: 'machine', machinePlatform: 'posix',
                directory: '/elsewhere', projectKey: 'other-project', agentId: 'test' });
              expect(result.delivery?.items.map(item => item.skillId)).toEqual(['happier:happier']);
              expect(result.unavailable).toBeUndefined();
              expect(result.plan.items.find(item => item.skillId === 'skill')).toMatchObject({ state: 'off', reason: 'no_rule' });
              expect(result.plan.items.filter(item => item.state === 'delivered').map(item => item.skillId)).toEqual(['happier:happier']);
            } else expect(result.delivery?.items.map(item => item.skillId)).toEqual(['skill', 'happier:happier']);
            if (operationContext) {
              const daemon = getActiveAccountSettingsSnapshot();
              expect(daemon?.scopeKey === snapshot.scopeKey).toBe(false);
              expect(daemon?.promptLibraryCatalog).toEqual(snapshot.promptLibraryCatalog);
            }
          }
          if (failure !== 'rules-conflict') return;
        }
        const read = await readProjectAccountRows({ credentials, serverId, publication: 'installed' });
        if (failure === 'shared') {
          expect(effects).toEqual([]);
          expect(await resolveSessionProjectPromptStack({ credentials, serverId, machineId: 'machine', directory: '/repo',
            metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } })).toMatchObject({ entries: [entry('old-skill', 'skill')],
            projectKey: 'project', skillMigration: { status: 'ready' } });
        }
        if (!migrationUnavailable) {
          expect(read.organizations[0]?.value).toMatchObject({ label: 'Retained label', promptStack: failure === 'shared'
            ? [entry('generic', 'generic')] : [entry('old-skill', 'skill'), entry('generic', 'generic')] });
          expect(ruleRecord).toMatchObject({ key: 'skill-rules', value: { rules: [{ id: 'migrated-stack:project:project:old-skill',
            skillId: 'skill', enabled: true, target: { t: 'project', projectKey: 'project' } }] } });
          expect(ruleRecord.value).toMatchObject({ consumedLegacyEntryIds: ['migrated-stack:project:project:old-skill'] });
          const firstEffects = [...effects];
          expect(firstEffects).toEqual(['rules']);
          await readProjectAccountRows({ credentials, serverId, publication: 'installed' });
          if (failure === 'shared') await resolveSessionProjectPromptStack({ credentials, serverId, machineId: 'machine', directory: '/repo',
            metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } });
          expect(effects).toEqual(firstEffects);
          if (ruleRecord.key !== 'skill-rules') throw new Error('Missing Project rules');
          const off = applyReachRulesChangeV1(ruleRecord.value.rules, { kind: 'write', write: {
            place: { t: 'project', projectKey: 'project' }, state: 'off',
          } }, { nowMs: 8, newId: () => 'unused' }).map(rule => ({ ...rule, skillId: 'skill' }));
          expect((await createCliPromptLibraryStore({ credentials }).writeRecord({ expectedRevision: rulesRevision,
            record: { key: 'skill-rules', value: { ...ruleRecord.value, rules: off } } })).status).toBe('updated');
          const offEffects = [...effects];
          await readProjectAccountRows({ credentials, serverId, publication: 'installed' });
          if (failure === 'shared') await resolveSessionProjectPromptStack({ credentials, serverId, machineId: 'machine', directory: '/repo',
            metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } });
          expect(effects).toEqual(offEffects);
          expect(ruleRecord).toMatchObject({ key: 'skill-rules', value: { rules: [{ enabled: false }] } });
        } else {
          expect(read.organizations[0]?.value.promptStack).toEqual([entry('old-skill', 'skill'), entry('generic', 'generic')]);
          expect(effects).toEqual([]);
          expect(ruleRecord).toEqual({ key: 'skill-rules', value: { v: 1, rules: [] } });
          expect(await migrateProjectPromptStackSkillRules({ credentials, serverId, serverHttpBaseUrl: base,
            projectKey: 'project', entries: read.organizations[0]?.value.promptStack ?? [] })).toEqual({ status: 'unavailable' });
          expect(await resolveSessionProjectPromptStack({ credentials, serverId, machineId: 'machine', directory: '/repo',
            metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } })).toMatchObject({ entries: [
            entry('old-skill', 'skill'), entry('generic', 'generic'),
          ], skillMigration: { status: 'unavailable' } });
        }
        {
          await refreshActivePromptLibraryCatalog({ credentials });
          if (!migrationUnavailable) {
            if (ruleRecord.key !== 'skill-rules') throw new Error('Missing skill rules');
            const removed = applyReachRulesChangeV1(ruleRecord.value.rules, { kind: 'write', write: {
              place: { t: 'project', projectKey: 'project' }, state: 'inherit',
            } }, { nowMs: 10, newId: () => 'unused' });
            const recreated = applyReachRulesChangeV1(removed, { kind: 'write', write: {
              place: { t: 'project', projectKey: 'project' }, state: 'on',
            } }, { nowMs: 11, newId: () => 'recreated-rule' });
            const store = createCliPromptLibraryStore({ credentials });
            const changed = await store.writeRecord({ expectedRevision: rulesRevision,
              record: { key: 'skill-rules', value: { ...ruleRecord.value, rules: [
                ...recreated.map(rule => ({ ...rule, skillId: 'skill' })),
                ...applyReachRulesChangeV1([], { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
                  { nowMs: 12, newId: () => 'profile-rule' }).map(rule => ({ ...rule, skillId: 'profile-skill' })),
              ] } } });
            expect(changed.status).toBe('updated');
            await refreshActivePromptLibraryCatalog({ credentials });
            const active = getActiveAccountSettingsSnapshot();
            const catalog = active?.promptLibraryCatalog;
            if (!active || !catalog || catalog.status !== 'ready') throw new Error('Missing retained Account context');
            const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
            const scopeKey = resolveAccountSettingsScopeKey(credentials);
            expect(commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog: { ...catalog,
              rows: catalog.rows.map(row => row.record.key === 'coding' ? { ...row,
                record: PromptLibraryRecordV1Schema.parse({ key: 'coding', value: { v: 1, scope: { kind: 'coding' },
                  entries: [entry('account-entry', 'account-skill')] } }) } : row) } })).toBe(true);
            expect(commitActiveProfileCatalog({ scopeKey, lifetimeToken,
              catalog: { status: 'ready', source: 'destination', authority: 'active', referenceGuardRevision: 1,
                controlRevision: 'absent', control: null, diagnostics: [], records: [{ revision: 1,
                  record: ProfileRecordV1Schema.parse({ v: 1, id: 'retained-profile',
                    definition: { kind: 'artifact', artifactId: 'profile-artifact' }, enabled: false,
                    promptStack: [entry('profile-entry', 'profile-skill')], skillSeeds: ['profile-skill'], secretBindings: {} }) }] } })).toBe(true);
            expect(readActiveAccountPromptStackSources({ scopeKey, lifetimeToken, surface: 'coding',
              profileId: 'retained-profile' }).status).toBe('unavailable');
          }
          let metadata: Metadata = Object.assign(createTestMetadata({ path: '/repo', machineId: 'machine', work: {
            promptStack: [entry('session-skill', 'skill'), entry('session-generic', 'generic')],
            disabledInheritedEntryIds: ['old-skill', 'account-entry', 'profile-entry'] },
            ...(!migrationUnavailable ? { profileId: 'retained-profile' } : {}) }),
            { workspaceId: 'checkout', projectId: 'project' });
          const preparation = await prepareSessionStackSkillMigration(metadata, { credentials });
          const prepared = preparation.status === 'ready' ? preparation.migration : undefined;
          if (!migrationUnavailable) expect(prepared?.skillIds.has('profile-skill')).toBe(true);
          const originalWork = metadata.work;
          await applyStartupMetadataUpdateToSession({ session: { updateMetadata: updater => { metadata = updater(metadata); } },
            next: createTestMetadata(), mode: 'attach', permissionModeOverride: null, stackSkillMigration: prepared });
          if (migrationUnavailable && failure !== 'rules-conflict') {
            expect(prepared).toBeUndefined();
            expect(metadata.work).toBe(originalWork);
            expect(metadata.skillSelectionV1).toBeUndefined();
          } else if (failure === 'rules-conflict') {
            expect(metadata.skillSelectionV1?.forceExcludeSkillIds).toEqual(['skill']);
            expect(metadata.work).toEqual({ ...originalWork, promptStack: [
              { ...entry('session-skill', 'skill'), skillMigrationV1: true }, entry('session-generic', 'generic'),
            ] });
          } else {
            expect(SessionSkillSelectionAuthoringV1Schema.parse(metadata.skillSelectionV1)).toMatchObject({
              forceExcludeSkillIds: ['account-skill', 'profile-skill', 'skill'], forceIncludeSkillIds: [] });
            expect(SessionPromptStackV1Schema.parse(metadata.work?.promptStack)).toEqual([
              { ...entry('session-skill', 'skill'), skillMigrationV1: true }, entry('session-generic', 'generic'),
            ]);
            expect(metadata.work?.disabledInheritedEntryIds).toEqual(['old-skill', 'account-entry', 'profile-entry']);
            const owner = createSessionOwnerMetadataV1({ metadata });
            expect(owner.ok).toBe(true);
            if (!owner.ok || ruleRecord.key !== 'skill-rules') throw new Error('Invalid migrated Session');
            const consumed = SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata);
            expect(consumed.runtime?.skillSelectionV1).toEqual(metadata.skillSelectionV1);
            const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix',
              directory: '/repo', projectKey: 'project', agentId: 'codex' }, mcp: null, agentAcceptsUserMcp: true,
              skills: { items: ['skill', 'profile-skill', 'account-skill'].map(skillId => ({ skillId, name: skillId })),
                rules: ruleRecord.value.rules },
              selection: { skills: consumed.runtime?.skillSelectionV1 } });
            expect(selected.skills.items[0]).toMatchObject({ selected: false, reason: 'session_removed' });
            expect(selected.skills.items[1]).toMatchObject({ selected: false, reason: 'session_removed',
              decidedBy: { ruleId: 'profile-rule' } });
            const firstSelection = metadata.skillSelectionV1;
            const repeatedPreparation = await prepareSessionStackSkillMigration(metadata, { credentials });
            await applyStartupMetadataUpdateToSession({ session: { updateMetadata: updater => { metadata = updater(metadata); } },
              next: createTestMetadata(), mode: 'start', permissionModeOverride: null,
              stackSkillMigration: repeatedPreparation.status === 'ready' ? repeatedPreparation.migration : undefined });
            expect(metadata.skillSelectionV1).toEqual(firstSelection);
            expect(metadata.work?.disabledInheritedEntryIds).toEqual(['old-skill', 'account-entry', 'profile-entry']);
          }
        }
        if (failure === 'shared') {
          const firstStore = createCliPromptLibraryStore({ credentials });
          expect(await removeSkillRulesV1({ serverId, ...firstStore,
            readCatalog: async () => ({ catalog: await firstStore.readPromptLibraryCatalog() }),
            listSkills: async () => { throw new Error('Removal does not read the skill inventory'); },
            ruleWriteContext: () => { throw new Error('Removal does not author reach rules'); },
          }, 'skill')).toBe(true);
          const firstViewerRules = structuredClone(ruleRecord);
          const firstViewerRevision = rulesRevision;
          expect(firstViewerRules).toMatchObject({ key: 'skill-rules', value: {
            rules: [{ id: 'profile-rule', skillId: 'profile-skill' }],
            consumedLegacyEntryIds: ['migrated-stack:project:project:old-skill'],
          } });
          const afterRemoval = effects.length;
          consumedArtifactUnavailable = true;
          for (let pass = 0; pass < 2; pass++) expect(await resolveSessionProjectPromptStack({ credentials, serverId,
            machineId: 'machine', directory: '/repo', metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } }))
            .toMatchObject({ skillMigration: { status: 'ready' } });
          expect(effects).toHaveLength(afterRemoval);
          expect(ruleRecord).toEqual(firstViewerRules);
          ruleRecord = PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: { v: 1, rules: [] } });
          consumedArtifactUnavailable = false;
          rulesRevision = 1;
          const otherCredentials = { ...credentials,
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'other-account' })).toString('base64url')}.signature` };
          setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
            settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(otherCredentials) });
          await resolveSessionProjectPromptStack({ credentials: otherCredentials, serverId, machineId: 'machine', directory: '/repo',
            metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } });
          expect(ruleRecord).toMatchObject({ key: 'skill-rules', value: { rules: [{ skillId: 'skill',
            id: 'migrated-stack:project:project:old-skill', target: { t: 'project', projectKey: 'project' }, enabled: true }],
            consumedLegacyEntryIds: ['migrated-stack:project:project:old-skill'] } });
          const secondViewerRules = structuredClone(ruleRecord);
          const secondWrites = effects.length;
          for (let pass = 0; pass < 2; pass++) await resolveSessionProjectPromptStack({ credentials: otherCredentials,
            serverId, machineId: 'machine', directory: '/repo', metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } });
          expect(effects).toHaveLength(secondWrites);
          expect(ruleRecord).toEqual(secondViewerRules);
          ruleRecord = firstViewerRules; rulesRevision = firstViewerRevision;
          setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
            settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
          await resolveSessionProjectPromptStack({ credentials, serverId, machineId: 'machine', directory: '/repo',
            metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } });
          expect(ruleRecord).toEqual(firstViewerRules);
          expect(secondViewerRules).toMatchObject({ value: { rules: [{ skillId: 'skill', enabled: true }] } });
          expect(attachments).toEqual([{ purpose: 'context', entry: entry('old-skill', 'skill') }]);
          expect(effects.every(effect => effect === 'rules')).toBe(true);
        }
      });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}
