import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(async () => ({
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array([1, 2, 3]),
    },
  })),
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      listConnectedServiceProfiles: vi.fn(async () => ({
        profiles: [
          {
            status: 'connected',
            providerEmail: 'plugin@example.com',
          },
        ],
      })),
    })),
  },
}));

vi.mock('@/extensions/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/extensions/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: vi.fn(async () => ({
      catalogEntriesById: {
        'plugin-target': {
          id: 'plugin-target',
          cliSubcommand: 'plugin-target',
          vendorResumeSupport: 'unsupported',
          getCloudConnectTarget: async () => ({
            id: 'plugin-target',
            displayName: 'Plugin Target',
            vendorDisplayName: 'Plugin Target',
            vendorKey: 'openai',
            status: 'wired',
            authenticate: async () => ({}),
          }),
        },
      },
      providerDefinitionsById: new Map([
        [
          'plugin-target',
          {
            definition: {
              id: 'plugin-target',
              auth: {
                connectedServiceCompatibility: ['openai'],
              },
            },
          },
        ],
      ]),
    })),
  };
});

describe('handleConnectCommand help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders merged-registry connect targets in help output', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['help']);

      expect(output.logs.join('\n')).toContain('happier connect plugin-target');
    } finally {
      errorSpy.mockRestore();
      output.restore();
    }
  });

  it('uses merged-registry provider metadata for plugin target status', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleConnectCommand } = await import('./connect');
      await handleConnectCommand(['status']);

      const rendered = output.logs.join('\n');
      expect(rendered).toContain('Plugin Target: connected');
      expect(rendered).not.toContain('Plugin Target: not supported');
    } finally {
      errorSpy.mockRestore();
      output.restore();
    }
  });
});
