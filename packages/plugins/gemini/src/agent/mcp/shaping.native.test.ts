import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareGeminiNativeMcpShaping } from './shaping.js';
import { readGeminiNativePathEnvironment, resolveGeminiNativePolicyPaths } from '../utils/configPaths.js';

// Observe the real filesystem boundary without replacing native policy parsing.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const cleanups: Array<() => void | Promise<void>> = [];

function createSourceHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'happier-gemini-source-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('prepareGeminiNativeMcpShaping', () => {
  it('disables native sandboxing in the private launch settings without changing approvals or the source policy', async () => {
    const sourceHome = createSourceHome();
    const sourcePath = join(sourceHome, 'system.json');
    const sourceSettings = { tools: { sandbox: true }, security: { toolSandboxing: true,
      auth: { selectedType: 'oauth-personal' } }, approvalMode: 'default' };
    writeFileSync(sourcePath, JSON.stringify(sourceSettings));
    const shaped = await prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: sourcePath }, { nativeSandbox: 'off' });
    cleanups.push(() => shaped.cleanup());
    expect(shaped.env.GEMINI_SANDBOX).toBe('false');
    const effective = JSON.parse(readFileSync(shaped.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, 'utf8'));
    expect(effective).toEqual({ ...sourceSettings, tools: { sandbox: false },
      security: { ...sourceSettings.security, toolSandboxing: false } });
    expect(JSON.parse(readFileSync(sourcePath, 'utf8'))).toEqual(sourceSettings);
  });
  it('inherits only native path selectors and honors explicit launch values and unsets on every platform', () => {
    const inherited = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/native/policy.json',
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/native/defaults.json', UNRELATED_SECRET: 'must-not-forward' };
    expect(readGeminiNativePathEnvironment({}, [], inherited)).toEqual({
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/native/policy.json', GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/native/defaults.json',
    });
    const selected = readGeminiNativePathEnvironment({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/session/policy.json' },
      ['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'], inherited);
    expect(selected).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/session/policy.json' });
    expect(resolveGeminiNativePolicyPaths(selected, 'linux').systemDefaultsPath).toBe('/session/system-defaults.json');
    expect(resolveGeminiNativePolicyPaths({}, 'win32')).toEqual({
      systemSettingsPath: 'C:\\ProgramData\\gemini-cli\\settings.json',
      systemDefaultsPath: 'C:\\ProgramData\\gemini-cli\\system-defaults.json',
    });
    expect(resolveGeminiNativePolicyPaths({}, 'darwin').systemSettingsPath)
      .toBe('/Library/Application Support/GeminiCli/settings.json');
    expect(resolveGeminiNativePolicyPaths({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/native/policy.json ',
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/native/defaults.json ' }, 'linux')).toEqual({
      systemSettingsPath: '/native/policy.json ', systemDefaultsPath: '/native/defaults.json ',
    });
    for (const selector of ['\\policy.json', '/policy.json', 'C:policy.json']) {
      expect(() => resolveGeminiNativePolicyPaths({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: selector }, 'win32'))
        .toThrow(expect.objectContaining({ code: 'gemini_provider_auth_policy_unavailable' }));
    }
    expect(() => resolveGeminiNativePolicyPaths({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: ' ' }, 'linux'))
      .toThrow(expect.objectContaining({ code: 'gemini_provider_auth_policy_unavailable' }));
  });

  it('reads Windows native path selectors with the child environment key identity', () => {
    expect(readGeminiNativePathEnvironment({ gemini_cli_system_settings_path: 'C:\\managed\\settings.json' }, [],
      { GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'C:\\inherited\\settings.json' }, 'win32'))
      .toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'C:\\managed\\settings.json' });
    expect(readGeminiNativePathEnvironment({}, ['gemini_cli_system_settings_path'],
      { GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'C:\\inherited\\settings.json' }, 'win32')).toEqual({});
  });
  it.each(['oauth-personal', 'vertex-ai'])('pins bound API auth in the copied user settings while preserving policy (%s)', async selectedType => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    mkdirSync(join(sourceHome, '.gemini'));
    const settings = { theme: 'dark', tools: { sandbox: true }, security: {
      folderTrust: { enabled: true }, auth: { selectedType, enforcedType: 'gemini-api-key' },
    } };
    const sourcePath = join(sourceHome, '.gemini', 'settings.json');
    writeFileSync(sourcePath, JSON.stringify(settings));
    const prepared = await prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(sourceHome, 'system.json'),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, undefined, undefined, { type: 'gemini-api-key', cwd: workspace });
    cleanups.push(prepared.cleanup);
    expect(JSON.parse(readFileSync(join(prepared.env.HOME, '.gemini', 'settings.json'), 'utf8'))).toEqual({
      ...settings, security: { ...settings.security, auth: { ...settings.security.auth, selectedType: 'gemini-api-key' } },
    });
    expect(JSON.parse(readFileSync(sourcePath, 'utf8'))).toEqual(settings);
    expect(prepared.env).not.toHaveProperty('GEMINI_CLI_SYSTEM_SETTINGS_PATH');
  });

  it('refuses conflicting native System authentication before creating a replacement policy', async () => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    const systemPath = join(sourceHome, 'system.json');
    const policy = { security: { auth: { selectedType: 'oauth-personal' } }, tools: { sandbox: true } };
    writeFileSync(systemPath, JSON.stringify(policy));
    const pending = prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemPath, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, undefined, undefined, { type: 'gemini-api-key', cwd: workspace });
    void pending.then(prepared => cleanups.push(prepared.cleanup), () => undefined);
    await expect(pending).rejects.toMatchObject({ code: 'gemini_provider_auth_policy_conflict', retryable: false });
    expect(JSON.parse(readFileSync(systemPath, 'utf8'))).toEqual(policy);
  });

  it('checks the native verbatim System selector rather than a trimmed neighboring file', async () => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    const systemPath = join(sourceHome, 'system.json ');
    writeFileSync(systemPath.trim(), '{}');
    writeFileSync(systemPath, JSON.stringify({ security: { auth: { selectedType: 'vertex-ai' } } }));
    const pending = prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemPath, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, undefined, undefined, { type: 'gemini-api-key', cwd: workspace });
    void pending.then(prepared => cleanups.push(prepared.cleanup), () => undefined);
    await expect(pending).rejects.toMatchObject({ code: 'gemini_provider_auth_policy_conflict', retryable: false });
  });

  it('does not replace an existing native System policy for a bound no-tools launch', async () => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    const systemPath = join(sourceHome, 'system.json');
    const policy = { security: { auth: { enforcedType: 'gemini-api-key' } }, tools: { sandbox: true } };
    writeFileSync(systemPath, JSON.stringify(policy));
    const pending = prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemPath, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, { allowedTools: [], unlistedTools: 'deny' }, undefined, { type: 'gemini-api-key', cwd: workspace });
    void pending.then(prepared => cleanups.push(prepared.cleanup), () => undefined);
    await expect(pending).rejects.toMatchObject({ code: 'gemini_provider_native_policy_unsupported', retryable: false });
    expect(JSON.parse(readFileSync(systemPath, 'utf8'))).toEqual(policy);
  });

  it('keeps native defaults reachable when bound no-tools restrictions need their own System file', async () => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    const defaultsPath = join(sourceHome, 'defaults.json');
    const systemPath = join(sourceHome, 'system.json');
    const policy = { tools: { sandbox: true }, security: { auth: { enforcedType: 'gemini-api-key' } } };
    writeFileSync(defaultsPath, JSON.stringify(policy));
    writeFileSync(systemPath, '{}');
    const reads = vi.mocked(readFileSync);
    reads.mockClear();
    const prepared = await prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemPath, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaultsPath,
    }, { allowedTools: [], unlistedTools: 'deny' }, undefined, { type: 'gemini-api-key', cwd: workspace });
    cleanups.push(prepared.cleanup);
    expect(reads.mock.calls.filter(([path]) => path === systemPath)).toHaveLength(1);
    expect(reads.mock.calls.filter(([path]) => path === defaultsPath)).toHaveLength(1);
    expect(prepared.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toBe(defaultsPath);
    expect(JSON.parse(readFileSync(defaultsPath, 'utf8'))).toEqual(policy);
  });

  it('refuses a potentially active conflicting workspace auth choice without copying its policy', async () => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    mkdirSync(join(workspace, '.gemini'));
    writeFileSync(join(workspace, '.gemini', 'settings.json'), JSON.stringify({
      security: { auth: { selectedType: 'vertex-ai' } },
    }));
    const pending = prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(sourceHome, 'system.json'),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, undefined, undefined, { type: 'gemini-api-key', cwd: workspace });
    void pending.then(prepared => cleanups.push(prepared.cleanup), () => undefined);
    await expect(pending).rejects.toMatchObject({ code: 'gemini_provider_auth_policy_conflict', retryable: false });
  });

  it('refuses malformed native policy instead of treating it as absent', async () => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    const systemPath = join(sourceHome, 'system.json');
    writeFileSync(systemPath, '[]');
    const pending = prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemPath, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, undefined, undefined, { type: 'gemini-api-key', cwd: workspace });
    void pending.then(prepared => cleanups.push(prepared.cleanup), () => undefined);
    await expect(pending).rejects.toMatchObject({ code: 'gemini_provider_auth_policy_unavailable', retryable: false });
  });

  it('refuses relative native policy selectors rather than inspecting a different working directory', async () => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    const pending = prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'relative-policy.json', GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, undefined, undefined, { type: 'gemini-api-key', cwd: workspace });
    void pending.then(prepared => cleanups.push(prepared.cleanup), () => undefined);
    await expect(pending).rejects.toMatchObject({ code: 'gemini_provider_auth_policy_unavailable', retryable: false });
  });

  it.each([
    { experimental: { dynamicModelConfiguration: true } },
    { modelConfigs: { customOverrides: [{ match: {}, modelConfig: { model: 'native-other-model' } }] } },
  ])('refuses native model-routing configuration without modifying it (%j)', async settings => {
    const sourceHome = createSourceHome();
    const workspace = createSourceHome();
    mkdirSync(join(sourceHome, '.gemini'));
    const settingsPath = join(sourceHome, '.gemini', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings));
    const pending = prepareGeminiNativeMcpShaping({ HOME: sourceHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(sourceHome, 'system.json'), GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(sourceHome, 'defaults.json'),
    }, undefined, undefined, { type: 'gemini-api-key', cwd: workspace });
    void pending.then(prepared => cleanups.push(prepared.cleanup), () => undefined);
    await expect(pending).rejects.toMatchObject({ code: 'gemini_provider_model_policy_unsupported', retryable: false });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(settings);
  });

  it('delivers a linked session skill and unions native disables only in the copied settings', async () => {
    const sourceHome = createSourceHome();
    const deliveryRoot = createSourceHome();
    mkdirSync(join(sourceHome, '.agents', 'skills', 'retained'), { recursive: true });
    writeFileSync(join(sourceHome, '.agents', 'skills', 'retained', 'SKILL.md'), 'native bytes');
    mkdirSync(join(sourceHome, '.gemini'), { recursive: true });
    const settings = { theme: 'dark', skills: { disabled: ['already-disabled'], enabled: true } };
    writeFileSync(join(sourceHome, '.gemini', 'settings.json'), JSON.stringify(settings));
    const skillsRoot = join(deliveryRoot, 'skills');
    mkdirSync(join(skillsRoot, 'session-skill', 'references'), { recursive: true });
    writeFileSync(join(skillsRoot, 'session-skill', 'SKILL.md'), 'Session skill');
    writeFileSync(join(skillsRoot, 'session-skill', 'references', 'note.md'), 'Supporting file');
    const prepared = await prepareGeminiNativeMcpShaping({ HOME: sourceHome }, undefined, {
      pluginRoot: deliveryRoot, skillsRoot,
      items: [{ name: 'session-skill', skillId: 'fixture:skill', digest: 'sha256:fixture', directory: join(skillsRoot, 'session-skill') }],
      nativeDisables: [{ name: 'RETAINED', path: join(sourceHome, '.agents', 'skills', 'retained', 'SKILL.md') }],
    });
    cleanups.push(prepared.cleanup);
    const privateRoot = join(prepared.env.HOME, '.agents', 'skills');
    expect(readFileSync(join(privateRoot, 'session-skill', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
    if (process.platform !== 'win32') {
      expect(realpathSync(join(privateRoot, 'session-skill'))).toBe(realpathSync(join(skillsRoot, 'session-skill')));
    }
    expect(JSON.parse(readFileSync(join(prepared.env.HOME, '.gemini', 'settings.json'), 'utf8'))).toEqual({
      ...settings, skills: { ...settings.skills, disabled: ['already-disabled', 'retained'] },
    });
    expect(readFileSync(join(sourceHome, '.agents', 'skills', 'retained', 'SKILL.md'), 'utf8')).toBe('native bytes');
    expect(JSON.parse(readFileSync(join(sourceHome, '.gemini', 'settings.json'), 'utf8'))).toEqual(settings);
    expect(readdirSync(join(sourceHome, '.agents', 'skills'))).toEqual(['retained']);
  });

  it('links user skills and extensions as children of real private directories without writing native folders', async () => {
    const sourceHome = createSourceHome();
    const entries = [
      ['.gemini', 'skills', 'a', 'SKILL.md'],
      ['.agents', 'skills', 'b', 'SKILL.md'],
      ['.gemini', 'extensions', 'e', 'gemini-extension.json'],
    ];
    for (const segments of entries) {
      mkdirSync(join(sourceHome, ...segments.slice(0, -1)), { recursive: true });
      writeFileSync(join(sourceHome, ...segments), segments[2]!);
    }

    const prepared = await prepareGeminiNativeMcpShaping({ HOME: sourceHome });
    cleanups.push(prepared.cleanup);
    const privateHome = prepared.env.GEMINI_CLI_HOME;
    for (const segments of entries) {
      const parentSegments = segments.slice(0, 2);
      expect(lstatSync(join(privateHome, ...parentSegments)).isDirectory()).toBe(true);
      expect(lstatSync(join(privateHome, ...parentSegments)).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(privateHome, ...segments.slice(0, -1))).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(privateHome, ...segments), 'utf8')).toBe(segments[2]);
      expect(readdirSync(join(sourceHome, ...parentSegments))).toEqual([segments[2]]);
    }
    writeFileSync(join(privateHome, '.gemini', 'skills', 'session-only.md'), 'injected');
    expect(existsSync(join(sourceHome, '.gemini', 'skills', 'session-only.md'))).toBe(false);

    await prepared.cleanup();
    await prepared.cleanup();
    expect(existsSync(privateHome)).toBe(false);
    for (const segments of entries) expect(readFileSync(join(sourceHome, ...segments), 'utf8')).toBe(segments[2]);
  });

  it('copies non-auth settings and scrubs user MCP servers while keeping the source intact', async () => {
    const sourceHome = createSourceHome();
    mkdirSync(join(sourceHome, '.gemini'), { recursive: true });
    mkdirSync(join(sourceHome, '.config', 'gemini'), { recursive: true });
    writeFileSync(join(sourceHome, '.gemini', 'oauth_creds.json'), '{"access_token":"private"}');
    writeFileSync(join(sourceHome, '.gemini', 'auth.json'), '{"mode":"login"}');
    writeFileSync(join(sourceHome, '.config', 'gemini', 'auth.json'), '{"mode":"login"}');
    writeFileSync(join(sourceHome, '.gemini', 'config.json'), '{"apiEndpoint":"https://example.invalid"}');
    writeFileSync(join(sourceHome, '.config', 'gemini', 'config.json'), '{"location":"us-central1"}');
    const settings = { theme: 'dark', mcpServers: { user: { command: 'server', env: { TOKEN: 'private' } } } };
    writeFileSync(join(sourceHome, '.gemini', 'settings.json'), JSON.stringify(settings));

    const prepared = await prepareGeminiNativeMcpShaping({ HOME: sourceHome });
    cleanups.push(prepared.cleanup);
    const privateHome = prepared.env.GEMINI_CLI_HOME;
    expect(prepared.env.HOME).toBe(privateHome);
    expect(prepared.env.XDG_CONFIG_HOME).toBe(join(privateHome, '.config'));
    for (const segments of [['.gemini', 'oauth_creds.json'], ['.gemini', 'auth.json'], ['.config', 'gemini', 'auth.json']]) {
      expect(existsSync(join(privateHome, ...segments))).toBe(false);
    }
    expect(JSON.parse(readFileSync(join(privateHome, '.gemini', 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
    expect(JSON.parse(readFileSync(join(privateHome, '.gemini', 'config.json'), 'utf8'))).toEqual({ apiEndpoint: 'https://example.invalid' });
    expect(JSON.parse(readFileSync(join(privateHome, '.config', 'gemini', 'config.json'), 'utf8'))).toEqual({ location: 'us-central1' });
    expect(JSON.parse(readFileSync(join(sourceHome, '.gemini', 'settings.json'), 'utf8'))).toEqual(settings);
  });

  it('links skills from the effective Gemini CLI home when it differs from HOME', async () => {
    const sourceHome = createSourceHome();
    const geminiHome = createSourceHome();
    mkdirSync(join(geminiHome, '.agents', 'skills', 'configured'), { recursive: true });
    writeFileSync(join(geminiHome, '.agents', 'skills', 'configured', 'SKILL.md'), 'configured home');
    const prepared = await prepareGeminiNativeMcpShaping({ HOME: sourceHome, GEMINI_CLI_HOME: geminiHome });
    cleanups.push(prepared.cleanup);
    expect(readFileSync(join(prepared.env.GEMINI_CLI_HOME, '.agents', 'skills', 'configured', 'SKILL.md'), 'utf8')).toBe('configured home');
    expect(existsSync(join(sourceHome, '.agents'))).toBe(false);
  });

  it('creates real private skill and extension directories when native folders are absent, and scrubs malformed settings', async () => {
    const sourceHome = createSourceHome();
    mkdirSync(join(sourceHome, '.gemini'));
    writeFileSync(join(sourceHome, '.gemini', 'settings.json'), '{"mcpServers":');
    const prepared = await prepareGeminiNativeMcpShaping({ HOME: sourceHome });
    cleanups.push(prepared.cleanup);
    for (const segments of [['.gemini', 'skills'], ['.agents', 'skills'], ['.gemini', 'extensions']]) {
      expect(lstatSync(join(prepared.env.GEMINI_CLI_HOME, ...segments)).isDirectory()).toBe(true);
      expect(readdirSync(join(prepared.env.GEMINI_CLI_HOME, ...segments))).toEqual([]);
      expect(existsSync(join(sourceHome, ...segments))).toBe(false);
    }
    expect(JSON.parse(readFileSync(join(prepared.env.GEMINI_CLI_HOME, '.gemini', 'settings.json'), 'utf8'))).toEqual({});
  });
});
