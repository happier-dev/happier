import type { PluginAgentDefinition } from '@happier-dev/plugin-sdk/agents';
import { MUSE_NATIVE_HOME } from '../connectedAccounts/declarations.js';
import { MUSE_MSP_LAUNCH } from './msp.js';

export const MUSE_DIRECT_AUTH_ENV_KEYS = ['META_API_KEY'] as const;
export const MUSE_LAUNCH_ENV_KEYS = ['HOME', MUSE_NATIVE_HOME.environmentKey, 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  ...MUSE_DIRECT_AUTH_ENV_KEYS, ...Object.keys(MUSE_MSP_LAUNCH.env)] as const;

/** Native Muse 1.4.14 installer locations and reviewed vendor instructions. */
export const museCliSupport = {
  displayName: 'Muse CLI',
  executable: {
    binaryName: 'muse',
    knownUserBinDirSuffixes: ['.local/bin', 'AppData/Local/Programs/muse'],
    knownEnvironmentBinDirs: [
      { envVar: 'MUSE_INSTALL_DIR', relativeDir: '.' },
      { envVar: 'LOCALAPPDATA', relativeDir: 'Programs/muse' },
    ],
    sourcePreference: 'system-first',
  },
  install: {
    manual: {
      kind: 'vendor_recipe',
      recipes: {
        darwin: [{ cmd: 'bash', args: ['-c', 'curl -fsSL https://dev.meta.ai/install.sh | bash'] }],
        linux: [{ cmd: 'bash', args: ['-c', 'curl -fsSL https://dev.meta.ai/install.sh | bash'] }],
        win32: [{ cmd: 'powershell.exe', args: ['-NoProfile', '-Command', 'irm https://dev.meta.ai/install.ps1 | iex'] }],
      },
    },
    guideUrl: 'https://dev.meta.ai/',
    docsUrl: null,
  },
  auth: {
    support: 'login_terminal',
    environmentVariables: [...MUSE_DIRECT_AUTH_ENV_KEYS],
    loginLaunches: [{ kind: 'primary', args: ['login'] }],
  },
} satisfies NonNullable<PluginAgentDefinition['declaration']['cli']>;
