import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveGrokAcpAuthentication } from './auth';
import { buildGrokAcpBackendOptions, resolveGrokXaiApiKeyPresence } from './backend';

describe('Grok ACP backend options', () => {
  let root = '';
  let executable = '';
  let originalOverride: string | undefined;

  beforeEach(() => {
    originalOverride = process.env.HAPPIER_GROK_PATH;
    root = mkdtempSync(join(tmpdir(), 'happier-grok-backend-'));
    executable = join(root, process.platform === 'win32' ? 'grok.exe' : 'grok');
    writeFileSync(executable, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    process.env.HAPPIER_GROK_PATH = executable;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.HAPPIER_GROK_PATH;
    else process.env.HAPPIER_GROK_PATH = originalOverride;
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the managed resolver and exact automation argv', () => {
    const options = buildGrokAcpBackendOptions({ cwd: root });
    expect(options.command).toBe(executable);
    expect(options.args).toEqual(['--no-auto-update', 'agent', 'stdio']);
  });

  it('passes provider environment without adding speculative aliases or flags', () => {
    const options = buildGrokAcpBackendOptions({
      cwd: root,
      env: { XAI_API_KEY: '  secret-value  ', GROK_TEST_SENTINEL: 'yes' },
    });
    expect(options.env).toEqual({ XAI_API_KEY: '  secret-value  ', GROK_TEST_SENTINEL: 'yes' });
    expect(options.args).not.toContain('--no-leader');
    expect(options.env).not.toHaveProperty('GROK_CODE_XAI_API_KEY');
    expect(options.env).not.toHaveProperty('GROK_OAUTH2_REFERRER');
  });

  it('captures only API-key presence in the authentication resolver', () => {
    const options = buildGrokAcpBackendOptions({ cwd: root, env: { XAI_API_KEY: 'secret-value' } });
    expect(options.authentication).toMatchObject({ kind: 'resolve-after-initialize' });
    expect(JSON.stringify(options.authentication)).not.toContain('secret-value');
    if (options.authentication?.kind !== 'resolve-after-initialize') {
      throw new Error('Expected dynamic Grok authentication');
    }
    expect(options.authentication.resolve({
      advertisedMethodIds: new Set(['xai.api_key']),
      initializeMeta: null,
    })).toEqual({ methodId: 'xai.api_key', meta: { headless: true } });
  });

  it.each([
    {
      name: 'accepts an inherited exact-case key on POSIX',
      platform: 'linux' as const,
      inheritedEnv: { XAI_API_KEY: '  inherited-secret  ' },
      overrideEnv: undefined,
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: false,
    },
    {
      name: 'ignores an inherited differently-cased key on POSIX',
      platform: 'darwin' as const,
      inheritedEnv: { xai_api_key: 'inherited-secret' },
      overrideEnv: undefined,
      expectedMethodId: 'cached_token',
      expectedUnsetInherited: false,
    },
    {
      name: 'accepts an inherited differently-cased key on Windows',
      platform: 'win32' as const,
      inheritedEnv: { xai_api_key: '  inherited-secret  ' },
      overrideEnv: undefined,
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: false,
    },
    {
      name: 'lets a differently-cased blank Windows override shadow an inherited key',
      platform: 'win32' as const,
      inheritedEnv: { XAI_API_KEY: 'inherited-secret' },
      overrideEnv: { xai_api_key: '   ' },
      expectedMethodId: 'cached_token',
      expectedUnsetInherited: true,
    },
    {
      name: 'does not let a differently-cased POSIX override shadow an inherited key',
      platform: 'linux' as const,
      inheritedEnv: { XAI_API_KEY: 'inherited-secret' },
      overrideEnv: { xai_api_key: '   ' },
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: false,
    },
    {
      name: 'uses a differently-cased nonblank Windows override over an inherited blank value',
      platform: 'win32' as const,
      inheritedEnv: { XAI_API_KEY: '   ' },
      overrideEnv: { Xai_Api_Key: '\t override-secret \n' },
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: true,
    },
    {
      name: 'uses the lexicographically first Windows override when casing variants coexist',
      platform: 'win32' as const,
      inheritedEnv: {},
      overrideEnv: { xai_api_key: '   ', XAI_API_KEY: 'override-secret' },
      expectedMethodId: 'xai.api_key',
      expectedUnsetInherited: true,
    },
  ])('$name', ({ platform, inheritedEnv, overrideEnv, expectedMethodId, expectedUnsetInherited }) => {
    const presence = resolveGrokXaiApiKeyPresence({
      inheritedEnv,
      overrideEnv,
      platform,
    });
    const authentication = resolveGrokAcpAuthentication({
      advertisedMethodIds: new Set(['xai.api_key', 'cached_token']),
      initializeMeta: { defaultAuthMethodId: 'cached_token' },
    }, presence.hasXaiApiKey);

    expect(authentication).toEqual({ methodId: expectedMethodId, meta: { headless: true } });
    expect(presence.unsetInheritedXaiApiKey).toBe(expectedUnsetInherited);
    expect(JSON.stringify({ presence, authentication })).not.toContain('secret');
  });

  it('wires both xAI request methods only when the shared permission owner is present', () => {
    const permissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' as const }),
    };
    const withPermissionOwner = buildGrokAcpBackendOptions({ cwd: root, permissionHandler });
    expect(Object.keys(withPermissionOwner.extensionHandlers?.requests ?? {}).sort()).toEqual([
      '_x.ai/ask_user_question',
      'x.ai/ask_user_question',
    ]);
    expect(withPermissionOwner.permissionHandler).toBe(permissionHandler);
    expect(Object.keys(withPermissionOwner.extensionHandlers?.notifications ?? {})).toEqual([
      '_x.ai/mcp/servers_updated',
    ]);

    const withoutPermissionOwner = buildGrokAcpBackendOptions({ cwd: root });
    expect(withoutPermissionOwner.extensionHandlers?.requests).toBeUndefined();
    expect(Object.keys(withoutPermissionOwner.extensionHandlers?.notifications ?? {})).toEqual([
      '_x.ai/mcp/servers_updated',
    ]);
  });
});
