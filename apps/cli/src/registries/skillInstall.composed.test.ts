import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRegistryHostV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { PromptLibraryArtifactStore, PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { readSkillLockV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { tryHandleSkillsCliCommand } from '@/cli/actions/skillsNameArgAdapter';
import { createSkillsUpdateTracker } from './updates/trackers/skillsUpdateTracker';
import { createRegistryUpdateCheck } from './updates/registryUpdateTracker';
import * as scm from '@/scm/runtime';
import { createRegistryGitProtocolV1 } from './gitProtocol';
import { installSkills, previewSkillInstall } from '../../../ui/sources/components/settings/skills/add/skillInstall';
import type { MountedAuthoringActionExecute } from '../../../ui/sources/sync/ops/actions/sessionAuthoringActions';

describe('reviewed skill installation through the Add and Git owners', () => {
  it.each(['link', 'registry'] as const)('retains all reviewed %s skills after the branch moves and offers the advance as an update', async kind => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-skill-pin-'));
    const url = 'https://pin-fixture.invalid/skills.git';
    const realRun = scm.runScmCommand;
    const command = async (args: string[]) => {
      const result = await realRun({ bin: 'git', cwd, args });
      if (!result.success) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    // Substitute only the external Git transport destination. All Git commands,
    // object reads, registry integrity checks and Action logic execute for real.
    const transport = vi.spyOn(scm, 'runScmCommand').mockImplementation(input => realRun({ ...input,
      args: ['-c', `url.${pathToFileURL(cwd).href}.insteadOf=${url}`, ...input.args],
    }));
    try {
      await command(['init']);
      await command(['config', 'user.name', 'Pin fixture']);
      await command(['config', 'user.email', 'pin-fixture@example.invalid']);
      const original = '---\nname: primary\n---\nReviewed primary. See [sibling](../sibling/SKILL.md)';
      await mkdir(join(cwd, 'primary'));
      await mkdir(join(cwd, 'sibling'));
      await writeFile(join(cwd, 'primary', 'SKILL.md'), original);
      await writeFile(join(cwd, 'sibling', 'SKILL.md'), '---\nname: sibling\n---\nReviewed sibling');
      await command(['add', 'primary', 'sibling']);
      await command(['commit', '-m', 'reviewed']);
      const reviewed = await command(['rev-parse', 'HEAD']);
      const descriptor: RegistrySourceDescriptorV1 = { id: 'pin-fixture', title: 'Pin fixture', format: 'git', kinds: ['skill'],
        url, enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
      const forbidden = async (): Promise<never> => { throw new Error('This fixture uses real Git, never registry HTTP'); };
      const http = { getJson: forbidden, getText: forbidden, getBytes: forbidden };
      const registry = createRegistryHostV1({ host: 'node', git: createRegistryGitProtocolV1({}), http, readSources: async () => [descriptor] });
      const artifacts = new Map<string, PromptLibraryStoredArtifact>();
      let nextId = 0;
      // Artifact persistence and Account rows are process boundaries. Domain
      // creation, provenance, sibling expansion and update decisions stay real.
      const store: PromptLibraryArtifactStore = {
        list: async () => ({ coverage: 'complete', items: [...artifacts.values()].map(item => ({ id: item.id, header: item.header, updatedAtMs: 1, owned: true })) }),
        read: async id => artifacts.get(id) ?? null,
        create: async input => {
          const id = `skill-${++nextId}`;
          artifacts.set(id, { ...input, id, owned: true, revision: { headerVersion: 1, bodyVersion: 1 } });
          return id;
        },
        update: async input => {
          const before = artifacts.get(input.artifactId)!;
          const revision = { headerVersion: before.revision.headerVersion + 1, bodyVersion: before.revision.bodyVersion + 1 };
          artifacts.set(before.id, { ...before, header: input.header, body: input.body, revision });
          return { revision };
        },
      };
      const action = createSkillActionExecuteV1({ store, randomId: () => 'rule', nowMs: () => 1,
        skillRules: { serverId: 'home', assertCurrent: () => {}, listSkills: async () => [],
          ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }),
          readCatalog: async () => ({ catalog: { status: 'ready', rows: [
            { revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [] } } },
          ], tombstones: [], diagnostics: [] } }),
          writeRecord: async () => ({ status: 'updated', revision: 1, cursor: 1 }) },
        includeInSession: async () => ({ ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } }), readRegistryItem: registry.readRegistryItem,
        readRegistrySource: registry.readRegistrySource, fetchRegistrySkillFiles: registry.filesForPointer,
        readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles,
      });
      const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'skills.install': ['cli', 'agent'] } });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        skillActionExecute: ({ actionId, input, context }) => action(actionId, input, { surface: context.surface ?? null }),
        isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      });
      const execute: MountedAuthoringActionExecute = async (actionId, input) => {
        if (actionId !== 'skills.install') throw new Error(`Unexpected Add Action: ${actionId}`);
        return executor.execute(actionId, input, { surface: 'ui', authority: 'present_user' });
      };
      const source = kind === 'link' ? { kind, url } : { kind, sourceId: descriptor.id, itemId: 'primary', version: reviewed };
      const preview = await previewSkillInstall(execute, source);
      if (!preview.ok) throw new Error(preview.error);
      expect(preview.items.map(item => item.name).sort()).toEqual(['primary', 'sibling']);
      await writeFile(join(cwd, 'primary', 'SKILL.md'), original + '\nUnreviewed advance');
      await writeFile(join(cwd, 'sibling', 'SKILL.md'), '---\nname: sibling\n---\nUnreviewed sibling advance');
      await command(['add', 'primary', 'sibling']);
      await command(['commit', '-m', 'advanced']);
      const advanced = await command(['rev-parse', 'HEAD']);
      expect(advanced).not.toBe(reviewed);
      if (preview.source.kind === 'link') {
        const refs = preview.source.refs!;
        expect(await action('skills.install', { source: { ...preview.source, refs: refs.map(ref => ({ ...ref, treeSha: '0'.repeat(40) })) } }, { surface: 'ui' }))
          .toEqual({ ok: false, code: 'registry_version_mismatch' });
        expect(artifacts.size).toBe(0);
        // Unticking a sibling must not require that unselected tree to be readable.
        const selected = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await action('skills.install', {
          source: { ...preview.source, refs: refs.map(ref => ref.path === 'sibling' ? { ...ref, treeSha: '0'.repeat(40) } : ref) },
          selectPaths: ['primary'], dryRun: true,
        }, { surface: 'ui' }));
        expect(selected).toMatchObject({ items: [{ path: 'primary', provenance: { ref: { commit: reviewed } } }] });
      }
      const outcome = await installSkills(execute, { source: preview.source, selectPaths: preview.items.map(item => item.path), where: { kind: 'replace', rules: [] } });
      expect(outcome.ok).toBe(true);
      expect(artifacts.size).toBe(2);
      for (const artifact of artifacts.values()) {
        const provenance = readSkillLockV1(artifact.header).provenance;
        const ref = provenance.kind === 'registry' ? provenance.registry.ref : provenance.kind === 'link' ? provenance.ref : null;
        expect(ref).toMatchObject({ commit: reviewed });
        const content = JSON.parse(artifact.body!) as { entries: { contentBase64: string }[] };
        expect(content.entries.map(file => Buffer.from(file.contentBase64, 'base64').toString()).join('\n')).not.toContain('Unreviewed');
      }
      if (preview.source.kind === 'link') {
        const agentPreview = await executor.execute('skills.install', { source: preview.source, dryRun: true }, { surface: 'agent' });
        expect(agentPreview).toMatchObject({ ok: true, result: { items: preview.items.map(item => ({ path: item.path, provenance: item.provenance })) } });
        const output = captureConsoleJsonOutput<{ ok: boolean; data: unknown }>();
        try {
          expect(await tryHandleSkillsCliCommand({ argv: ['skills', 'install', url, '--refs-json', JSON.stringify(preview.source.refs),
            '--dry-run', '--off', '--server-id', 'fixture-home', '--json'], actionExecutionDeps: {
            readCredentialsForServerIdFn: async () => ({ token: 'fixture-token', encryption: null }),
            getServerProfileFn: async () => ({ id: 'fixture-home', name: 'Fixture', serverUrl: 'https://home.invalid', webappUrl: 'https://home.invalid', createdAt: 1, updatedAt: 1, lastUsedAt: 1 }),
            createExecutorFn: async () => ({ ...executor, resolveSessionTarget: async () => { throw new Error('No Session in this fixture'); } }),
          } })).toBe(true);
          const receipt = output.json();
          expect(receipt.ok).toBe(true);
          const cliPreview = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(receipt.data);
          expect(cliPreview).toMatchObject({ items: preview.items.map(item => ({ path: item.path, provenance: item.provenance })) });
        } finally { output.restore(); process.exitCode = 0; }
      }
      const checker = createRegistryUpdateCheck({ trackers: [createSkillsUpdateTracker({ execute: action })],
        ctx: { git: createRegistryGitProtocolV1({}), http }, readSources: async () => [descriptor] });
      const updates = await checker.checkNow({ kind: 'skill' });
      expect(updates.results).toHaveLength(2);
      expect(updates.results.every(result => result.upstream.state === 'update_available' && result.upstream.latest?.kind === 'gitTree' && result.upstream.latest.commit === advanced)).toBe(true);
    } finally {
      transport.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
