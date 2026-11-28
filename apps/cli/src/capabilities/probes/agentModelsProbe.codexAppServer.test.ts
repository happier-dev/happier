import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
  createCodexAppServerProcessEnv,
  writeFakeCodexAppServerScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import { createProbeTempDir } from './agentModelsProbe.testkit';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (codex app-server)', () => {
  let fixture: Awaited<ReturnType<typeof createProbeTempDir>>;
  beforeEach(async () => {
    resetAgentModelsProbeCacheForTests();
    fixture = await createProbeTempDir('happier-codex-model-probe');
  });
  afterEach(async () => {
    resetAgentModelsProbeCacheForTests();
    await fixture.cleanup();
  });

  async function probe(models: unknown[], options: {
    failFirst?: boolean; accountSettings?: Record<string, unknown>; configuredModel?: string;
    bypassCache?: boolean; includeConfiguredModel?: boolean; nextCursor?: string;
  } = {}) {
    // The installed app-server process is the only substituted boundary. Launch,
    // RPC orchestration, session-control parsing, normalization and caching stay real.
    const command = await writeFakeCodexAppServerScript({
      dir: fixture.dir,
      importLines: ['import { existsSync, writeFileSync } from "node:fs";'],
      setupLines: [
        `const models = ${JSON.stringify(models)};`,
        `const failureMarker = ${JSON.stringify(join(fixture.dir, 'failed-once'))};`,
        `const fail = ${options.failFirst === true} && !existsSync(failureMarker);`,
        'if (fail) writeFileSync(failureMarker, "failed");',
      ],
      bodyLines: [
        'for await (const line of rl) {',
        '  const msg = JSON.parse(line);',
        '  if (msg.id === undefined) continue;',
        '  const response = msg.method === "initialize" && fail',
        '    ? { error: { code: -32000, message: "temporary startup failure" } }',
        `    : { result: msg.method === "model/list" ? { data: models, nextCursor: ${JSON.stringify(options.nextCursor ?? null)} }`,
        '      : msg.method === "collaborationMode/list" ? { data: [] }',
        `      : msg.method === "config/read" ? { config: { model: ${JSON.stringify(options.configuredModel ?? null)}, extra: "private-value" } }`,
        '      : { userAgent: "fake/0.0.0", platformFamily: "unix", platformOs: "linux" } };',
        '  process.stdout.write(JSON.stringify({ id: msg.id, ...response }) + "\\n");',
        '}',
      ],
    });
    return await probeAgentModelsBestEffort({
      agentId: 'codex', cwd: fixture.dir, timeoutMs: 5_000,
      accountSettings: options.accountSettings,
      bypassCache: options.bypassCache,
      includeConfiguredModel: options.includeConfiguredModel,
      processEnv: createCodexAppServerProcessEnv(command, {
        CODEX_HOME: fixture.dir, OPENAI_API_KEY: 'test', CODEX_API_KEY: undefined,
      }),
    });
  }

  it('retries a transient app-server failure within the same probe', async () => {
    const result = await probe([
      { id: 'gpt-5.4', displayName: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini' },
    ], { failFirst: true, accountSettings: { codexBackendMode: 'appServer' } });
    expect(result).toMatchObject({
      source: 'dynamic', observedAt: expect.any(Number),
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT 5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
      ],
    });
  });

  it('uses app-server model capabilities when account settings select appServer', async () => {
    const result = await probe([{
      id: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Latest default',
      supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium',
    }], { accountSettings: { codexBackendMode: 'appServer' } });
    expect(result).toMatchObject({
      source: 'dynamic',
      availableModels: [{ id: 'default', name: 'Default' }, {
        id: 'gpt-5.4', name: 'GPT 5.4', description: 'Latest default',
        modelOptions: [{ id: 'reasoning_effort', currentValue: 'medium', options: [
          { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' },
        ] }],
      }],
    });
  });

  it('reports the effective configured model separately from the discovered catalog', async () => {
    const result = await probe([{ id: 'older-model', displayName: 'Older model' }], {
      configuredModel: 'newer-model',
      includeConfiguredModel: true,
    });

    expect(result).toMatchObject({ source: 'dynamic', configuredModelId: 'newer-model' });
    expect(result.availableModels.map((model) => model.id)).toEqual(['default', 'older-model']);
    expect(JSON.stringify(result)).not.toContain('private-value');

    const cached = await probe([], { configuredModel: 'changed-model' });
    expect(cached.availableModels).toEqual(result.availableModels);
    expect(cached).not.toHaveProperty('configuredModelId');

    const pickerRefresh = await probe([], { configuredModel: 'changed-model', bypassCache: true });
    expect(pickerRefresh).not.toHaveProperty('configuredModelId');

    const refreshed = await probe([], { configuredModel: 'changed-model', includeConfiguredModel: true });
    expect(refreshed).toMatchObject({
      source: 'dynamic',
      configuredModelId: 'changed-model',
      availableModels: [{ id: 'default', name: 'Default' }],
    });
  });

  it('keeps picker models but withholds advisory evidence when more catalog pages exist', async () => {
    const result = await probe([{ id: 'older-model' }], {
      configuredModel: 'newer-model',
      includeConfiguredModel: true,
      nextCursor: 'next-page',
    });
    expect(result.availableModels.map(({ id }) => id)).toEqual(['default', 'older-model']);
    expect(result).not.toHaveProperty('configuredModelId');
  });

  it('uses app-server controls when the shared runtime defaults to appServer', async () => {
    expect(await probe([{ id: 'gpt-5.4', displayName: 'GPT-5.4' }])).toMatchObject({
      source: 'dynamic', observedAt: expect.any(Number),
      availableModels: [{ id: 'default', name: 'Default' }, { id: 'gpt-5.4', name: 'GPT 5.4' }],
    });
  });

  it('filters malformed model entries and unsupported reasoning choice shapes at the provider boundary', async () => {
    const result = await probe([
      { id: 'gpt-5.4', displayName: 'GPT-5.4', supportedReasoningEfforts: [{ invalid: true }, { reasoningEffort: 'medium' }] },
      { name: 'Missing identifier' }, null,
    ], { accountSettings: { codexBackendMode: 'appServer' } });
    expect(result).toMatchObject({
      source: 'dynamic', availableModels: [{ id: 'default', name: 'Default' }, {
        id: 'gpt-5.4', name: 'GPT 5.4',
        modelOptions: [{ id: 'reasoning_effort', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] }],
      }],
    });
  });
});
