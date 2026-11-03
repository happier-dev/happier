import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillArtifactStore } from '@/prompts/skills/library/readSkillLibraryContent';
import type { AccountArtifact, AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { SpawnCapabilitiesPreviewSuccessV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { projectSpawnMcpServersPreviewInventory } from '@/session/actions/cliActionDeps/resolveSpawnMcpServersPreviewInventory';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import { resolveSessionMcpPreview } from './resolveSessionMcpPreview';

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });

describe('resolveSessionMcpPreview detection warnings', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['codex'] } }); });
  afterAll(async () => { await runtime?.dispose(); });
  it('delivers feature-enabled first-party guides and preserves explicit Session exclusions', async () => {
    const artifacts: SkillArtifactStore = { list: async () => ({ items: [], coverage: 'complete' }), read: async () => null };
    const input = { settings: McpServersSettingsV1Schema.parse({ v: 1 }), machineId: 'machine', directory: null,
      agentId: 'codex', detectedServers: [], skillLibrary: { inventory: [], artifacts, rules: [] },
      isFeatureEnabled: () => true };
    const preview = await resolveSessionMcpPreview(input);
    for (const id of ['happier:deploy', 'happier:workflows']) {
      expect(preview.skills.items.find(item => item.id === id)).toMatchObject({ selected: true, selectable: true, state: 'delivered' });
    }
    const excluded = await resolveSessionMcpPreview({ ...input, capabilitySelection: { skills: {
      v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: ['happier:deploy'], excludeNativeSkillNames: [] } } });
    expect(excluded.skills.items.find(item => item.id === 'happier:deploy'))
      .toMatchObject({ selected: false, reason: 'session_removed', state: 'excluded' });
  });
  it('uses host-published runtime facts instead of the Agent declaration for running Session timing', async () => {
    const preview = await resolveSessionMcpPreview({ settings: McpServersSettingsV1Schema.parse({ v: 1 }),
      machineId: 'machine', directory: null, agentId: 'codex', detectedServers: [], sessionRunning: true,
      sessionMetadata: { agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'unsupported', skillsLiveReload: 'unsupported' } } } });
    expect(preview.applyTiming).toEqual({ mcp: { t: 'new_sessions_only' }, skills: { t: 'new_sessions_only' } });
  });
  it('uses native user roots only at machine level and joins masking onto the real skill plan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-impl-p2c-machine-native-'));
    try {
      const directory = join(home, 'repo');
      await mkdir(join(directory, '.git'), { recursive: true });
      for (const [root, name] of [[join(home, '.native'), 'user-skill'], [join(directory, '.skills'), 'project-skill']] as const) {
        await mkdir(join(root, name), { recursive: true });
        await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\nNative`);
      }
      const artifact = (id: string, name: string): AccountArtifact & AccountArtifactHeader => ({ artifactId: id, ownerAccountId: 'account', access: 'owner',
        revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1,
        headerVersion: 1, bodyVersion: 1,
        header: { v: 1, kind: 'prompt_bundle.v2', title: name, bundleSchemaId: 'skills.skill_md_v1' },
        body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
          contentBase64: Buffer.from(`---\nname: ${name}\n---\nLibrary`).toString('base64') }] }) });
      const inventory = [artifact('user', 'user-skill'), artifact('project', 'project-skill'), artifact('off', 'off')];
      const artifacts: SkillArtifactStore = { list: async () => ({ items: inventory, coverage: 'complete' }),
        read: async id => inventory.find(item => item.artifactId === id) ?? null };
      const input = { settings: McpServersSettingsV1Schema.parse({ v: 1 }), machineId: 'machine', agentId: 'codex',
        detectedServers: [], home, agentSkills: { delivery: 'session_dir' as const, nativeDisable: 'supported' as const,
          liveReload: 'supported' as const, nativeRoots: { user: [['.native']], project: [['.skills']] } },
        skillLibrary: { inventory, artifacts, rules: ['user', 'project'].map(skillId => ({ id: skillId, skillId,
          target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 })) } };
      const machine = await resolveSessionMcpPreview({ ...input, directory: null });
      SpawnCapabilitiesPreviewSuccessV1Schema.parse({ ok: true, machinePlatform: machine.machinePlatform,
        mcp: machine.mcp, skills: machine.skills, applyTiming: machine.applyTiming });
      expect(machine.skills?.plan.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ skillId: 'user', state: 'masked_by_native' }),
        expect.objectContaining({ skillId: 'project', state: 'delivered' }),
        expect.objectContaining({ skillId: 'off', state: 'off' }),
      ]));
      const project = await resolveSessionMcpPreview({ ...input, directory });
      SpawnCapabilitiesPreviewSuccessV1Schema.parse({ ok: true, machinePlatform: project.machinePlatform,
        mcp: project.mcp, skills: project.skills, applyTiming: project.applyTiming });
      expect(project.skills?.plan.items.find(item => item.skillId === 'project')?.state).toBe('masked_by_native');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('includes Off items in the generic machine projection without exposing effective configuration', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{
      id: 'off', name: 'off-tools', transport: 'stdio', stdio: { command: 'echo', args: [] },
      env: { TOKEN: { t: 'literal', v: 'private-preview-token' } }, createdAt: 1, updatedAt: 1,
    }], bindings: [] });
    const preview = await resolveSessionMcpPreview({ settings, machineId: 'machine-1', directory: null,
      agentId: 'codex', detectedServers: [] });
    expect(preview).toMatchObject({ machinePlatform: process.platform === 'win32' ? 'win32' : 'posix',
      mcp: { strictMode: false, items: [{ id: 'off', selected: false, selectable: true, reason: 'no_rule' }], detected: [] },
      skills: { items: [], plan: { items: [] } }, applyTiming: {
        mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' },
      } });
    expect(JSON.stringify(preview)).not.toContain('private-preview-token');
  });
  it('applies the generic carrier MCP override through the canonical preview producer', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{
      id: 'server-a', name: 'example', transport: 'stdio', stdio: { command: 'example', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'everywhere', serverId: 'server-a', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const preview = await resolveSessionMcpPreview({ settings, machineId: 'machine-1', directory: '/repo', agentId: 'codex',
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['server-a'] },
        skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] } },
      detectedServers: [],
    });
    expect(preview.managed).toEqual([expect.objectContaining({ serverId: 'server-a', selected: false, reasonCode: 'forced_excluded' })]);
  });
  it('projects admitted managed options without disclosing env or header material', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'remote', name: 'remote-tools', transport: 'http', remote: { url: 'https://mcp.example.test',
        headers: { Authorization: { t: 'literal', v: 'private-header-material' } } },
      env: { API_TOKEN: { t: 'literal', v: 'private-env-material' } }, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'binding', serverId: 'remote', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const result = projectSpawnMcpServersPreviewInventory(await resolveSessionMcpPreview({ settings, machineId: 'machine-1', directory: '/workspace',
      agentId: 'codex', detectedServers: [{
        provider: 'codex', name: 'detected-tools', transport: 'stdio', stdio: { command: 'echo', args: [] },
        envKeys: ['TOKEN'], enabled: true, source: { kind: 'user', path: '/config/codex' },
      }],
    }));
    expect(result).toMatchObject({ ok: true,
      items: expect.arrayContaining([{ value: 'managed:remote', label: 'remote-tools', selected: true, selectable: true,
        sourceKind: 'managed', authMode: 'plainText', availability: 'active' }]),
      preview: { managed: [expect.objectContaining({ serverId: 'remote', transport: 'http', scopeKind: 'allMachines' })],
        detected: [expect.objectContaining({ key: 'detected:codex:detected-tools', envKeyCount: 1 })] },
    });
    expect(JSON.stringify(result)).not.toContain('private-env-material');
    expect(JSON.stringify(result)).not.toContain('private-header-material');
  });

  it('renders a detection warning that no Agent owns without an undefined Agent id', async () => {
    const preview = await resolveSessionMcpPreview({
      settings: { v: 1, strictMode: false, servers: [], bindings: [] },
      machineId: 'machine-1',
      directory: '/tmp/project',
      agentId: 'gemini',
      detectedServers: [],
      detectedWarnings: [
        { provider: 'gemini', code: 'parse_failed', path: '/tmp/project/.gemini/mcp.json' },
        { code: 'unsupported', path: 'plugin:config' },
      ],
    });

    expect(preview.warnings).toEqual([
      'gemini:parse_failed:/tmp/project/.gemini/mcp.json',
      'unattributed:unsupported:plugin:config',
    ]);
  });
  it('uses Account Project association in preview and reads no Project rows for an Agent without user MCP', async () => {
    const serverId = 'preview-home';
    const key = { kind: 'workspace-ref', serverId, id: 'checkout' };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
    const request = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key, revision: 1, content: { t: 'plain', v: { key, value: { id: 'checkout', serverId, machineId: 'machine-1',
        rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
    ] } });
    const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{
      id: 'tools', name: 'tools', transport: 'stdio', stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'project-rule', serverId: 'tools', enabled: true,
      target: { t: 'project', projectKey: 'project' }, createdAt: 1, updatedAt: 1 }] });
    const input = { settings, machineId: 'machine-1', directory: '/repo', agentId: 'codex', detectedServers: [],
      sessionProject: { credentials: { token: 'preview-project', encryption: null }, serverId,
        metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } } };
    expect((await resolveSessionMcpPreview(input)).managed[0]?.selected).toBe(true);
    // Pending association propagation is owned by resolveSessionCapabilitiesForDirectory.project.test.ts.
    request.mockClear();
    const unsupported = await resolveSessionMcpPreview({ ...input, agentId: 'deepsec' });
    expect(unsupported.managed[0]?.selected).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it('honors an authoritative draft Project key without needing a directory or an Account association read', async () => {
    const request = vi.spyOn(axios, 'post');
    const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{
      id: 'tools', name: 'tools', transport: 'stdio', stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'project-rule', serverId: 'tools', enabled: true,
      target: { t: 'project', projectKey: 'project' }, createdAt: 1, updatedAt: 1 }] });
    const preview = await resolveSessionMcpPreview({ settings, machineId: 'machine-1', directory: null, projectKey: 'project',
      agentId: 'codex', detectedServers: [], sessionProject: { credentials: { token: 'preview-project', encryption: null }, metadata: {} } });
    expect(preview.managed[0]?.selected).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
