import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createStubGithubTransport, createTestGithubApiClient, GITHUB_TEST_ACCOUNT } from '../triage/testkit/githubTriage.test-support.js';
import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import { createGithubApiClient } from '../observations/githubApiClient.js';
import { executeGithubCiAction } from './operations.js';
import { readGithubWorkflowDefinitionV1 } from './workflowInputs.js';
import { readGithubTrigger } from './dispatch.js';
import { ForgeCiActionResultSchemasV1 } from '@happier-dev/triage-protocol/ci/v1';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
describe('immutable workflow acquisition', () => {
  it('reads selected-ref Unicode workflow inputs on a host without Buffer', async () => {
    // CLI owns the browser graph tool, as in the plugin browser-boundary suites.
    const { build } = createRequire(new URL('../../../../../apps/cli/package.json', import.meta.url))('esbuild') as typeof import('esbuild');
    const compiled = await build({
      entryPoints: [fileURLToPath(new URL('./dispatch.ts', import.meta.url))],
      bundle: true, write: false, platform: 'browser', format: 'cjs',
      conditions: ['happier-source'], logLevel: 'silent',
    });
    const module = { exports: {} as Record<string, unknown> };
    // Keep the Node runner's IPC globals intact while the real browser closure has no Buffer.
    runInNewContext(compiled.outputFiles[0]!.text, {
      module, exports: module.exports, TextEncoder, TextDecoder, URL, AbortController, atob, btoa,
    });
    const portableRead = module.exports.readGithubTrigger;
    if (typeof portableRead !== 'function') throw new Error('Missing portable workflow reader');
    const yaml = 'name: Révision 東京 🧪\non:\n  workflow_dispatch:\n    inputs:\n      message:\n        description: Révision 東京 🧪\n        type: string\njobs: {}';
    const content = Buffer.from(yaml, 'utf8').toString('base64');
    const transport = createStubGithubTransport({ respond: request => {
      if (request.url.endsWith('/actions/workflows/12')) return { status: 200, body: { id: 12, name: 'Révision 東京 🧪', state: 'active', path: '.github/workflows/ci.yml' } };
      if (request.url.endsWith('/commits/topic')) return { status: 200, body: { sha: first } };
      if (request.url.includes('/contents/')) {
        expect(new URL(request.url).searchParams.get('ref')).toBe(first);
        return { status: 200, body: { type: 'file', encoding: 'base64', content } };
      }
      return undefined;
    } });
    const context = {
      plugin: transport.context.plugin, signal: transport.context.signal, invokedAtMs: 0,
      services: { http: transport.context.services.http, connectedAccounts: {
        ...transport.context.services.connectedAccounts,
        async materialize(_purpose, _request, options) {
          expect(options?.expectedAccount).toEqual(GITHUB_TEST_ACCOUNT);
          expect(options?.nativeService).toBeUndefined();
          return { kind: 'httpHeaders', headers: { authorization: 'Bearer synthetic-account' } };
        },
      } },
    } satisfies GithubHttpInvocationContextV1;
    const input = { repository, credentialRef: GITHUB_TEST_ACCOUNT, workflowId: '12', ref: 'topic' };
    const expected = { kind: 'value', value: { dispatchable: true,
      inputs: [{ name: 'message', description: 'Révision 東京 🧪', type: 'string' }] } };
    expect(ForgeCiActionResultSchemasV1.readTrigger.parse(await executeGithubCiAction('readTrigger', input, context)))
      .toMatchObject(expected);
    expect(transport.requests).toHaveLength(3);
    const beforePortable = transport.requests.length;
    const client = await createGithubApiClient(context, GITHUB_TEST_ACCOUNT);
    const reply = await portableRead(client, input);
    // Transfer the browser result through the Action's JSON boundary before host validation.
    const result = ForgeCiActionResultSchemasV1.readTrigger.parse(JSON.parse(JSON.stringify(reply)));
    expect(result).toMatchObject(expected);
    expect(transport.requests.slice(beforePortable)).toHaveLength(3);
  });
  it('carries graph facts through the canonical trigger result even for a non-dispatchable workflow', async () => {
    const transport = createStubGithubTransport({ respond: request => {
      if (request.url.endsWith('/actions/workflows/12')) return { status: 200, body: { id: 12, name: 'CI', state: 'active', path: '.github/workflows/ci.yml' } };
      if (request.url.includes('/commits/')) return { status: 200, body: { sha: first } };
      if (request.url.includes('/contents/')) return { status: 200, body: { type: 'file', encoding: 'base64',
        content: Buffer.from('on: push\njobs:\n  build: {runs-on: ubuntu-latest}\n  test: {needs: build, runs-on: [self-hosted, linux]}').toString('base64') } };
      return undefined;
    } });
    const client = await createTestGithubApiClient(transport);
    const result = ForgeCiActionResultSchemasV1.readTrigger.parse(await readGithubTrigger(client, { repository, workflowId: '12', ref: 'topic' }));
    expect(result).toMatchObject({ kind: 'value', value: { dispatchable: false, inputs: [], jobs: [
      { id: 'build', needs: [], runsOn: ['ubuntu-latest'] }, { id: 'test', needs: ['build'], runsOn: ['self-hosted', 'linux'] },
    ] } });
    expect(transport.requests).toHaveLength(3);
  });
  it('does zero work before demand and acquires each repo/path/SHA once, including simultaneous consumers', async () => {
    let current = first;
    const transport = createStubGithubTransport({ respond: request => {
      if (request.url.includes('/commits/')) return { status: 200, body: { sha: current } };
      if (request.url.includes('/contents/')) return { status: 200, body: { type: 'file', encoding: 'base64', content: Buffer.from('on: workflow_dispatch\njobs: {}').toString('base64') } };
      return undefined;
    } });
    const client = await createTestGithubApiClient(transport);
    expect(transport.requests).toHaveLength(0);
    const input = { repository, workflowPath: '.github/workflows/ci.yml', ref: 'topic' };
    const [a, b] = await Promise.all([readGithubWorkflowDefinitionV1(client, input), readGithubWorkflowDefinitionV1(client, input)]);
    expect(a.definition).toBe(b.definition);
    expect((await readGithubWorkflowDefinitionV1(client, input)).definition).toBe(a.definition);
    expect(transport.requests.filter(request => request.url.includes('/contents/'))).toHaveLength(1);
    await readGithubWorkflowDefinitionV1(client, { ...input, workflowPath: '.github/workflows/other.yml' });
    expect(transport.requests.filter(request => request.url.includes('/contents/'))).toHaveLength(2);
    current = second;
    const moved = await readGithubWorkflowDefinitionV1(client, input);
    expect(moved.revision).toBe(second);
    expect(moved.definition).not.toBe(a.definition);
    expect(transport.requests.filter(request => request.url.includes('/contents/'))).toHaveLength(3);
  });
});
