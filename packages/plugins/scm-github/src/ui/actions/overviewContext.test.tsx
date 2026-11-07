// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, activateAccount } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { createStubGithubTransport } from '../../triage/testkit/githubTriage.test-support.js';
import { readGithubOverviewCiContextV1 } from './overviewContext.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
const headSha = 'b'.repeat(40);

describe('Overview through the ordinary mounted Action transport', () => {
  it('joins real activation and native default-ref resolution into exact Overview operands and cancels without a stale green', async () => {
    // Only HTTP/materialization and the UI transport are external boundaries.
    let authenticated = true;
    let credentialRefused = false;
    const transport = createStubGithubTransport({ nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic' } },
      respond: request => {
        if (credentialRefused) throw new PluginError({ code: 'plugin_connected_account_native_unavailable' });
        return !authenticated ? { status: 401, body: { message: 'Bad credentials' } } : request.url.endsWith('/octo-org/example-app')
        ? { status: 200, body: { full_name: repository.repository, default_branch: 'release/current' } }
        : request.url.endsWith('/commits/release%2Fcurrent') ? { status: 200, body: { sha: headSha } } : undefined;
      } });
    const native = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
    let fixture: PluginUiTestkit | undefined;
    try {
      await act(async () => {
        fixture = await createPluginUiTestkit({ identity: { instanceId: 'overview-context', mountNonce: 'overview-context' },
          authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
          surface: defineUiSurface(() => <Text value="Overview" />), surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter(), launchInput: null,
          handlers: { executeAction: async request => {
            if (typeof request.action !== 'object') throw new Error('Expected qualified Action');
            const handler = native.registration('actions', request.action.localId);
            if (typeof handler !== 'function') throw new Error('Missing registered native Action');
            const result = await handler(request.input ?? null, { ...transport.context, signal: request.signal });
            if (result === undefined) throw new Error('Expected a native Action result');
            return result;
          } } });
      });
      const result = await readGithubOverviewCiContextV1(fixture!.context.hostApi, repository);
      expect(result).toEqual({ context: { kind: 'ready', scope: 'overview', input: { repository, filters: { branch: 'release/current', headSha } } }, failure: null });
      expect(transport.requests.map(request => request.url)).toEqual([
        'https://api.github.com/repos/octo-org/example-app',
        'https://api.github.com/repos/octo-org/example-app/commits/release%2Fcurrent',
      ]);
      authenticated = false;
      expect(await readGithubOverviewCiContextV1(fixture!.context.hostApi, repository, undefined, result.context)).toEqual({
        context: { kind: 'unknown' }, failure: { class: 'authentication', code: 'github_unauthorized' },
      });
      expect(transport.requests).toHaveLength(3);
      expect(transport.requests.some(request => request.url.includes('/actions/'))).toBe(false);
      credentialRefused = true;
      expect(await readGithubOverviewCiContextV1(fixture!.context.hostApi, repository, undefined, result.context)).toEqual({
        context: { kind: 'unknown' }, failure: { class: 'authentication', code: 'plugin_connected_account_native_unavailable' },
      });
      expect(transport.requests).toHaveLength(4);
      const cancelled = new AbortController(); cancelled.abort();
      expect(await readGithubOverviewCiContextV1(fixture!.context.hostApi, repository, { signal: cancelled.signal }, result.context)).toEqual({ context: { kind: 'unknown' }, failure: null });
      expect(transport.requests).toHaveLength(4);
      await fixture!.retire();
      expect(await readGithubOverviewCiContextV1(fixture!.context.hostApi, repository, undefined, result.context)).toEqual({ context: { kind: 'unknown' }, failure: null });
      expect(transport.requests).toHaveLength(4);
    } finally { await act(async () => { await fixture?.dispose(); }); await native.dispose(); }
  });
});
