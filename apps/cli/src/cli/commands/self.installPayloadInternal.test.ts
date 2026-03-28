import { afterEach, describe, expect, it, vi } from 'vitest';

const { installVersionedPayloadMock } = vi.hoisted(() => ({
  installVersionedPayloadMock: vi.fn(async () => ({
    currentVersionId: '1.2.3',
    previousVersionId: null,
  })),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    installVersionedPayload: installVersionedPayloadMock,
  };
});

describe('happier self __install-payload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('promotes an extracted first-party payload through the shared runtime installer', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3'],
        rawArgv: ['happier', 'self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3'],
        terminalRuntime: null,
      });

      expect(installVersionedPayloadMock).toHaveBeenCalledWith({
        channel: 'stable',
        componentId: 'happier-cli',
        payloadRoot: '/tmp/payload',
        processEnv: process.env,
        versionId: '1.2.3',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('forwards the publicdev release ring when payload promotion is scoped to the dev lane', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-dev.4', '--channel', 'publicdev'],
        rawArgv: ['hdev', 'self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-dev.4', '--channel', 'publicdev'],
        terminalRuntime: null,
      });

      expect(installVersionedPayloadMock).toHaveBeenCalledWith({
        channel: 'publicdev',
        componentId: 'happier-cli',
        payloadRoot: '/tmp/payload',
        processEnv: process.env,
        versionId: '1.2.3-dev.4',
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
