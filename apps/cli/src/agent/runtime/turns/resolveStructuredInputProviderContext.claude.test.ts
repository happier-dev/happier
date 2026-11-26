import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { buildMentionRefForKindV1, MENTION_KIND_V1, HappierStructuredInputV1Schema, StrictJsonValueSchema } from '@happier-dev/protocol';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { AgentSessionControlContext, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createClaudeNativeRuntime } from '../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createSdkExecFixture, createPluginContextFixture, createTerminalHostFixture, createEventsFixture } from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { resolveStructuredInputProviderDispatchContext } from './resolveStructuredInputProviderContext';

it.each(['create', 'resume'] as const)('submits the workspace path for uploads from a Claude %s Session', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-claude-uploads-'));
  const exec = createSdkExecFixture();
  const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
  const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: root, launchEnv: {}, permissionMode: 'default',
    happierSessionId: 'upload-session' });
  const runtime = createClaudeNativeRuntime({ openSession: async () => operations,
    resolveSupportsEffort: async () => false, resolveSupportsSystemPromptSnapshotOff: async () => false });
  const sessionContext = {
    session: { services: { activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) } } },
  } as unknown as AgentSessionRuntimeContext;
  const session = await runtime.sessions.open({
    ...(kind === 'resume' ? { kind, providerSessionId: 'prior-session' } : { kind }),
    sessionId: 'upload-session',
    cwd: root,
  }, sessionContext);
  try {
    const path = '.happier/uploads/messages/m1/1234abcd-plot_ unknown_ 9 bytes)_final.txt';
    const name = 'plot, unknown, 9 bytes)\nfinal.txt';
    const forged = '.happier/uploads/messages/m1/forged.txt';
    const text = kind === 'resume' ? `Read the file.\n[attachments]\n- ${path} (${name}, text/plain, 9 bytes)\n[/attachments]` : 'Read the file.';
    const resolved = await resolveStructuredInputProviderDispatchContext({
      attachments: [{ ...(kind === 'resume' ? {} : { id: 'file' }), path, name, mimeType: 'text/plain', sizeBytes: 9 }],
      structuredInput: kind === 'resume' ? undefined : HappierStructuredInputV1Schema.parse({ v: 1, sessionAttachmentPaths: [forged] }),
    });
    await expect(session.send({
      inputIds: ['input'], delivery: { kind: 'newTurn', turnId: 'turn' },
      input: { text, ...(resolved.structuredInput ? { structuredInput: StrictJsonValueSchema.parse(resolved.structuredInput) } : {}) },
    })).resolves.toMatchObject({ status: 'admitted' });
    const row = exec.written.find(value => value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'user');
    const content = row && typeof row === 'object' ? Reflect.get(Reflect.get(row, 'message'), 'content') : null;
    expect(content).toContain(text);
    expect(content).toContain(JSON.stringify(join(root, path)));
    expect(content).not.toContain(forged);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('delivers two native user-only skills from Claude catalog through identity resolution with surrounding text intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-claude-mentions-'));
  const config = join(root, 'config');
  const skills = { pluginRoot: join(root, 'delivery'), skillsRoot: join(root, 'delivery/skills'),
    items: [{ name: 'library', directory: join(root, 'delivery/skills/source-library'), skillId: 'library-skill', digest: `sha256:${'a'.repeat(64)}` }], nativeDisables: [] };
  const exec = createSdkExecFixture();
  const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
  const operations = createClaudeAgentSdkTurnOperations({ ctx, permissionMode: 'default', directory: root, launchEnv: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config }, happierSessionId: 'skill-session', skills });
  const runtime = createClaudeNativeRuntime({ openSession: async () => operations,
    resolveSupportsEffort: async () => false, resolveSupportsSystemPromptSnapshotOff: async () => false });
  const sessions = runtime.sessions;
  if (!sessions) throw new Error('Expected Claude Session runtime');
  // The OS execution boundary supplies the observed native initialization response.
  const run = vi.fn(async (request: { args?: readonly string[]; env?: Readonly<Record<string, string>>; stdin?: Uint8Array }) => {
    const native = process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH;
    if (native) {
      // This optional real-vendor tier never inherits authentication or a vendor home.
      const child = spawn(native, request.args, { cwd: root, env: { PATH: process.env.PATH, ...request.env,
        HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject); child.once('close', resolve); child.stdin.end(request.stdin);
        });
        return { stdout: new TextEncoder().encode(stdout), stderr: new TextEncoder().encode(stderr), termination: { observed: { kind: 'exit', exitCode } } };
      } finally { child.kill(); }
    }
    return { stdout: new TextEncoder().encode(JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'happier-preflight-catalogs', response: { commands: [
      { name: 'first', description: 'First fixture (user)', argumentHint: '' },
      { name: 'second', description: 'Second fixture (user)', argumentHint: '' },
      { name: 'happier:library', description: 'Library fixture (happier)', argumentHint: '' },
      { name: 'debug', description: 'Debug Claude', builtin: true },
    ] },
  } }) + '\n'), stderr: new Uint8Array(), termination: { observed: { kind: 'exit', exitCode: 0 } } };
  });
  const controlContext = { session: { id: 'skill-session', cwd: root, activity: 'active', connectedAccounts: [] },
    services: { exec: { run, systemTools: { resolve: async () => ({ executable: { kind: 'system', path: '/fixture/claude' } }) } },
      settings: { forScope: () => ({ snapshot: async () => ({ values: {} }) }) } },
  } as unknown as AgentSessionControlContext;
  const sessionContext = { services: controlContext.services,
    session: { services: { activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) } } },
  } as unknown as AgentSessionRuntimeContext;
  let session: Awaited<ReturnType<typeof sessions.open>> | undefined;
  try {
    for (const name of ['first', 'second']) {
      await mkdir(join(config, 'skills', name), { recursive: true });
      await writeFile(join(config, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\ndisable-model-invocation: true\n---\nUser-only fixture body\n`);
    }
    await mkdir(join(skills.pluginRoot, '.claude-plugin'), { recursive: true });
    await mkdir(skills.items[0]!.directory, { recursive: true });
    await writeFile(join(skills.pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'happier', version: '1.0.0' }));
    await writeFile(join(skills.items[0]!.directory, 'SKILL.md'), '---\nname: library\ndescription: Library fixture\n---\nLibrary body\n');
    session = await sessions.open({ kind: 'create', sessionId: 'skill-session', cwd: root, skills,
      launchEnvironment: { values: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config }, unset: [] } }, sessionContext);
    expect(sessions.catalog, 'Claude must expose its canonical Session skill catalog facet').toBeDefined();
    const catalog = await sessions.catalog!.list({ kind: 'skills' }, controlContext);
    expect(catalog.status).toBe('ok');
    if (catalog.status !== 'ok' || catalog.kind !== 'skills') throw new Error('Expected Claude skills');
    expect(catalog.items.map(item => item.name).sort()).toEqual(['first', 'happier:library', 'second']);
    expect(catalog.items.find(item => item.name === 'happier:library')).toMatchObject({ id: 'library-skill', path: join(skills.items[0]!.directory, 'SKILL.md') });
    const listSkills = async () => SessionSkillCatalogListResponseV1Schema.parse({ skills: catalog.items });
    const library = await resolveStructuredInputProviderDispatchContext({ structuredInput: {
      v: 1, mentions: [{ kind: MENTION_KIND_V1.skill, ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'library-skill'), token: '$library' }],
    }, catalogs: { listSkills } });
    expect(library.structuredInput?.skillMentions).toMatchObject([{ name: 'happier:library', path: join(skills.items[0]!.directory, 'SKILL.md') }]);
    const text = 'Before $first and between $second after literal $WORD';
    const structuredInput = HappierStructuredInputV1Schema.parse({ v: 1, mentions: catalog.items.filter(item => item.name !== 'happier:library').map(item => ({
      kind: MENTION_KIND_V1.skill, ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, item.id),
      token: `$${item.name}`, start: text.indexOf(`$${item.name}`), end: text.indexOf(`$${item.name}`) + item.name.length + 1,
    })) });
    const resolved = await resolveStructuredInputProviderDispatchContext({ structuredInput, catalogs: { listSkills } });
    expect(resolved.structuredInput?.skillMentions).toMatchObject([
      { name: 'first', path: join(config, 'skills/first/SKILL.md') },
      { name: 'second', path: join(config, 'skills/second/SKILL.md') },
    ]);
    await expect(session.send({ inputIds: ['input-1'], delivery: { kind: 'newTurn', turnId: 'turn-1' },
      input: { text, structuredInput: StrictJsonValueSchema.parse(resolved.structuredInput) } })).resolves.toMatchObject({ status: 'admitted' });
    const record = exec.written.find(item => item !== null && typeof item === 'object' && Reflect.get(item, 'type') === 'user');
    expect(record).toBeDefined();
    const content: unknown = record && typeof record === 'object' ? Reflect.get(Reflect.get(record, 'message'), 'content') : null;
    expect(typeof content).toBe('string');
    expect(content).toContain(text);
    expect(content).toContain(JSON.stringify(join(config, 'skills/first/SKILL.md')));
    expect(content).toContain(JSON.stringify(join(config, 'skills/second/SKILL.md')));
    expect(content).not.toContain('User-only fixture body');
    expect(content).not.toContain('/WORD');
    await expect(session.send({ inputIds: ['missing-source'], delivery: { kind: 'newTurn', turnId: 'missing-source' },
      input: { text: 'Use $first', structuredInput: { v: 1, skillMentions: [{ name: 'first' }] } },
    })).resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'claude_skill_source_unavailable' } });
    expect(exec.written.filter(item => item !== null && typeof item === 'object' && Reflect.get(item, 'type') === 'user')).toHaveLength(1);
    const refreshed = session.refreshSkills!({ skills: { ...skills,
      items: [{ ...skills.items[0]!, skillId: 'replacement-skill' }] } });
    let reloadId: unknown;
    await vi.waitFor(() => {
      const reload = exec.written.find(item => item !== null && typeof item === 'object'
        && Reflect.get(item, 'type') === 'control_request'
        && Reflect.get(Reflect.get(item, 'request'), 'subtype') === 'reload_skills');
      expect(reload).toBeDefined();
      reloadId = Reflect.get(reload as object, 'request_id');
    });
    await exec.emit({ type: 'control_response', response: { subtype: 'success', request_id: reloadId } });
    await exec.emit({ type: 'system', subtype: 'commands_changed', slash_commands: ['first', 'second', 'happier:library'] });
    await expect(refreshed).resolves.toEqual({ kind: 'applied' });
    const refreshedCatalog = await sessions.catalog!.list({ kind: 'skills' }, controlContext);
    expect(refreshedCatalog.status).toBe('ok');
    if (refreshedCatalog.status !== 'ok' || refreshedCatalog.kind !== 'skills') throw new Error('Expected refreshed Claude skills');
    expect(refreshedCatalog.items.find(item => item.name === 'happier:library')).toMatchObject({ id: 'replacement-skill' });
    await session.dispose();
    session = undefined;
    await expect(sessions.catalog!.list({ kind: 'skills' }, controlContext)).resolves.toMatchObject({ status: 'unavailable' });
  } finally {
    await session?.dispose();
    await operations.disposeProviderSession();
    await rm(root, { recursive: true, force: true });
  }
});
