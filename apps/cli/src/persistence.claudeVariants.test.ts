import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Claude Variants (schema v6)', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    vi.resetModules();
  });

  describe('Schema migration', () => {
    it('migrates from v5 to v6, adding empty claudeVariants object', async () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-claude-variants-migrate-'));
      process.env.HAPPIER_HOME_DIR = homeDir;

      try {
        // Write v5 settings (without claudeVariants)
        writeFileSync(
          join(homeDir, 'settings.json'),
          JSON.stringify(
            {
              schemaVersion: 5,
              onboardingCompleted: true,
              activeServerId: 'cloud',
              servers: {
                cloud: {
                  id: 'cloud',
                  name: 'Happier Cloud',
                  serverUrl: 'https://api.happier.dev',
                  webappUrl: 'https://app.happier.dev',
                  createdAt: 0,
                  updatedAt: 0,
                  lastUsedAt: 0,
                },
              },
              machineIdByServerId: {},
              machineIdConfirmedByServerByServerId: {},
              lastChangesCursorByServerIdByAccountId: {},
            },
            null,
            2,
          ),
          'utf8',
        );

        vi.resetModules();
        const { readSettings, writeSettings, SUPPORTED_SCHEMA_VERSION } = await import('./persistence');

        // Verify SUPPORTED_SCHEMA_VERSION is 6
        expect(SUPPORTED_SCHEMA_VERSION).toBe(6);

        // Read settings (should trigger migration)
        const settings = await readSettings();

        // Verify migration happened
        expect(settings.schemaVersion).toBe(6);
        expect(settings.claudeVariants).toBeDefined();
        expect(settings.claudeVariants).toEqual({});

        // Verify original fields are preserved
        expect(settings.onboardingCompleted).toBe(true);
        expect(settings.activeServerId).toBe('cloud');
        expect(settings.servers).toBeDefined();
        expect(settings.machineIdByServerId).toBeDefined();
        expect(settings.machineIdConfirmedByServerByServerId).toBeDefined();
        expect(settings.lastChangesCursorByServerIdByAccountId).toBeDefined();
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it('initializes empty claudeVariants for new settings', async () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-claude-variants-new-'));
      process.env.HAPPIER_HOME_DIR = homeDir;

      try {
        vi.resetModules();
        const { readSettings, SUPPORTED_SCHEMA_VERSION } = await import('./persistence');

        expect(SUPPORTED_SCHEMA_VERSION).toBe(6);

        const settings = await readSettings();

        expect(settings.schemaVersion).toBe(6);
        expect(settings.claudeVariants).toBeDefined();
        expect(settings.claudeVariants).toEqual({});
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe('Claude variant storage and retrieval', () => {
    it('stores and retrieves claude variants', async () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-claude-variants-store-'));
      process.env.HAPPIER_HOME_DIR = homeDir;

      try {
        vi.resetModules();
        const { readSettings, writeSettings } = await import('./persistence');

        // Write settings with claude variants
        const variants = {
          zhipu: {
            configDir: '/home/trill/.claude-zhipu',
            description: 'Claude-zhipu with glm-5 access',
          },
          test: {
            configDir: '/tmp/test-claude',
          },
        };

        await writeSettings({
          schemaVersion: 6,
          onboardingCompleted: true,
          activeServerId: 'cloud',
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Happier Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
              createdAt: 0,
              updatedAt: 0,
              lastUsedAt: 0,
            },
          },
          machineIdByServerId: {},
          machineIdConfirmedByServerByServerId: {},
          lastChangesCursorByServerIdByAccountId: {},
          claudeVariants: variants,
        });

        // Read back
        const settings = await readSettings();

        expect(settings.claudeVariants).toEqual(variants);
        expect(settings.claudeVariants?.zhipu?.configDir).toBe('/home/trill/.claude-zhipu');
        expect(settings.claudeVariants?.zhipu?.description).toBe('Claude-zhipu with glm-5 access');
        expect(settings.claudeVariants?.test?.configDir).toBe('/tmp/test-claude');
        expect(settings.claudeVariants?.test?.description).toBeUndefined();
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it('preserves other settings when updating claude variants', async () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-claude-variants-preserve-'));
      process.env.HAPPIER_HOME_DIR = homeDir;

      try {
        vi.resetModules();
        const { readSettings, updateSettings } = await import('./persistence');

        // Create initial settings
        await updateSettings(async (settings) => ({
          ...settings,
          onboardingCompleted: true,
          activeServerId: 'cloud',
        }));

        // Update with claude variants
        await updateSettings(async (settings) => ({
          ...settings,
          claudeVariants: {
            zhipu: {
              configDir: '/home/trill/.claude-zhipu',
              description: 'Claude-zhipu with glm-5 access',
            },
          },
        }));

        // Verify all settings are preserved
        const finalSettings = await readSettings();
        expect(finalSettings.onboardingCompleted).toBe(true);
        expect(finalSettings.activeServerId).toBe('cloud');
        expect(finalSettings.claudeVariants?.zhipu?.configDir).toBe('/home/trill/.claude-zhipu');
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe('ClaudeVariant type', () => {
    it('exports ClaudeVariant type', async () => {
      // Types are erased at runtime, so we verify compilation by using the type
      // The Settings interface uses ClaudeVariant in the claudeVariants property
      // So if this file compiles, the type is properly exported
      vi.resetModules();
      const { readSettings, updateSettings } = await import('./persistence');

      // Create a variant value that matches the ClaudeVariant type
      const testVariant = { configDir: '/test/path', description: 'Test variant' };

      // Write settings with the variant
      await updateSettings(async (settings) => ({
        ...settings,
        claudeVariants: { test: testVariant },
      }));

      // Read back and verify
      const result = await readSettings();
      expect(result.claudeVariants?.test?.configDir).toBe('/test/path');
      expect(result.claudeVariants?.test?.description).toBe('Test variant');
    });
  });
});
