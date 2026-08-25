import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { resolveWindowsCommandInvocation } from '../../../../scripts/pipeline/lib/windows/resolveWindowsCommandInvocation.mjs';
import {
  ConversationProviderConnectionReconciliationSnapshotV1JsonSchema,
  ConversationProviderConnectionReconciliationSnapshotV1Schema,
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  parsePluginManifest,
} from '@happier-dev/plugin-sdk/manifest';

import {
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_BRAND_RESOURCE_ID,
  DISCORD_CHANNEL_ACTION_IDS,
  DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
} from './discordPluginConstants.js';
import { DISCORD_AUTOMATION_MESSAGE_ADMIT_ACTION_ID } from './discordAutomationEvent.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { DISCORD_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

// Records the selection basis; it does not make the external source or terms immutable.
const DISCORD_BRAND_ASSET_PROVENANCE = {
  source: {
    publisher: 'Discord',
    document: 'Discord Corebook',
    asset: 'favicon',
    url: 'https://discord.com/branding',
  },
  termsUrl: 'https://discord.com/branding',
  sha256: 'a371c453efbecaaae71b91181008c94d543f550ab9fe1884c1b238d59dc06537',
} as const;

const BRAND_ASSET_ARCHIVE_PATH = 'assets/brand.png';
const NPM_PACK_TIMEOUT_MS = 60_000;
/**
 * The package-wide per-test budget (`--testTimeout 15000`) is shorter than the
 * subprocess cap this one test permits, so vitest would abort it while `npm
 * pack` is still legitimately running. Its budget is therefore the subprocess
 * cap it allows plus the ordinary package budget for the surrounding local
 * temp-directory, extraction and read work.
 */
const PACKED_BRAND_ASSET_TEST_TIMEOUT_MS = NPM_PACK_TIMEOUT_MS + 15_000;

function readDiscordBrandAsset(): Buffer {
  const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
  expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return asset;
}

async function readPackedDiscordBrandAsset(): Promise<Buffer> {
  const destination = await mkdtemp(join(tmpdir(), 'happier-discord-brand-pack-'));
  try {
    const invocation = resolveWindowsCommandInvocation({
      command: 'npm',
      args: ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: NPM_PACK_TIMEOUT_MS,
      ...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
    if (result.error) {
      throw new Error(`npm pack could not start: ${result.error.message}`);
    }
    if (result.signal) {
      throw new Error(`npm pack was terminated by ${result.signal}`);
    }
    if (result.status !== 0) {
      throw new Error(`npm pack exited ${result.status}: ${result.stderr || result.stdout}`);
    }

    const packResults: unknown = JSON.parse(result.stdout);
    const archiveName = Array.isArray(packResults) && typeof packResults[0]?.filename === 'string'
      ? packResults[0].filename
      : null;
    expect(archiveName).not.toBeNull();

    const extractionDirectory = join(destination, 'extracted');
    await mkdir(extractionDirectory);
    await tar.x({ file: join(destination, archiveName!), cwd: extractionDirectory, strict: true });
    return await readFile(join(extractionDirectory, 'package', BRAND_ASSET_ARCHIVE_PATH));
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

describe('Discord Channels manifest', () => {
  it('publishes the complete plugin-owned UI translation bundles', () => {
    expect(PLUGIN_MANIFEST.contributes.ui?.translations).toEqual(DISCORD_UI_TRANSLATION_BUNDLES);
  });

  it('declares and packages the official Discord brand mark through the generic Resource owner', async () => {
    expect(PLUGIN_MANIFEST.brand).toEqual({ iconResourceId: DISCORD_BRAND_RESOURCE_ID });
    expect(PLUGIN_MANIFEST.contributes.resources).toEqual([{
      id: DISCORD_BRAND_RESOURCE_ID,
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    }]);

    const asset = readDiscordBrandAsset();
    expect(asset.readUInt32BE(16)).toBe(288);
    expect(asset.readUInt32BE(20)).toBe(288);
    expect(asset.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(createHash('sha256').update(asset).digest('hex')).toBe(DISCORD_BRAND_ASSET_PROVENANCE.sha256);

    const packedAsset = await readPackedDiscordBrandAsset();
    expect(packedAsset).toEqual(asset);
  }, PACKED_BRAND_ASSET_TEST_TIMEOUT_MS);

  it('publishes the canonical action schemas instead of provider-local lookalikes', () => {
    const actions = new Map((PLUGIN_MANIFEST.contributes.actions ?? []).map((action) => [action.id, action]));
    const providers = ConversationProvidersContributionProtocolV1.operations;

    const expectProtocolDefinedRole = (
      localId: string,
      operation: Exclude<typeof providers[keyof typeof providers], undefined>,
    ) => {
      if (operation.declaration.input.kind !== 'protocolDefined') {
        throw new Error(`Expected '${localId}' to use a protocol-defined input.`);
      }
      expect(actions.get(localId)).toMatchObject({
        inputSchema: operation.declaration.input.schema.jsonSchema,
        resultSchema: operation.declaration.resultSchema.jsonSchema,
        surfaces: operation.declaration.surfaces,
        dangerLevel: operation.declaration.dangerLevel,
        execution: { target: 'daemon' },
      });
    };

    expect(actions.get(DISCORD_CHANNEL_ACTION_IDS.setup)).toMatchObject({
      resultSchema: providers.setup.declaration.resultSchema.jsonSchema,
      surfaces: providers.setup.declaration.surfaces,
      dangerLevel: providers.setup.declaration.dangerLevel,
      execution: { target: 'daemon' },
    });
    expectProtocolDefinedRole(DISCORD_CHANNEL_ACTION_IDS.connectionTest, providers.connectionTest);
    expectProtocolDefinedRole(DISCORD_CHANNEL_ACTION_IDS.endpointResolve, providers.endpointResolve);
    expectProtocolDefinedRole(DISCORD_AUTOMATION_MESSAGE_ADMIT_ACTION_ID, providers.automationEventAdmit);
    expectProtocolDefinedRole(DISCORD_CHANNEL_ACTION_IDS.messageDeliver, providers.messageDeliver);
    expectProtocolDefinedRole(DISCORD_CHANNEL_ACTION_IDS.connectionStop, providers.connectionStop);
    // Discord cannot truthfully resolve a selected endpoint's participant: its
    // former action returned the integration bot regardless of that endpoint.
    // Generic direct-message pairing owns the user-initiated path instead.
    expect(actions.has('discord/inspect-principal')).toBe(false);
    expect(actions.get(DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID)).toMatchObject({
      execution: { target: 'daemon' },
    });
    expect(actions.size).toBe(8);
  });

  it('keeps the Gateway worker Account binding on an object-root wrapper without widening the core reconciliation union', () => {
    const gatewayWorker = PLUGIN_MANIFEST.contributes.actions?.find(
      ({ id }) => id === DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
    );
    if (!gatewayWorker?.inputSchema) {
      throw new Error('Expected the Discord Gateway worker Action input schema.');
    }

    expect(gatewayWorker.connectedAccountPurposeBindings).toEqual([{
      path: 'credentialRef',
      purpose: DISCORD_BOT_CREDENTIAL_PURPOSE,
    }]);
    expect(gatewayWorker.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        credentialRef: expect.any(Object),
      },
      required: ['credentialRef'],
      allOf: [ConversationProviderConnectionReconciliationSnapshotV1JsonSchema],
    });
    expect(parsePluginManifest(PLUGIN_MANIFEST)).toMatchObject({ ok: true });

    const validates = compilePluginJsonSchema(gatewayWorker.inputSchema);
    const activeSnapshot = ConversationProviderConnectionReconciliationSnapshotV1Schema.parse({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'discord:application:application-1',
      providerConfigVersion: 1,
      providerConfig: {
        applicationId: 'application-1',
        botUserId: 'bot-1',
        inviteUrl: 'https://discord.com/oauth2/authorize?client_id=application-1&scope=bot&permissions=274877975552',
      },
      credentialRef: {
        service: { pluginId: 'happier.channel.discord', localId: 'discord-bot' },
        accountId: 'bot:bot-1',
      },
      authorityEpoch: 7,
      enabled: true,
      deletionState: 'none',
      requiresFullSharedMessageContent: false,
    });
    const pendingWithoutCredential = ConversationProviderConnectionReconciliationSnapshotV1Schema.parse({
      ...activeSnapshot,
      credentialRef: null,
      enabled: false,
      deletionState: 'pendingStopReconciliation',
    });

    expect(isValidPluginJsonSchemaValue(validates, activeSnapshot)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validates, pendingWithoutCredential)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validates, {
      ...activeSnapshot,
      deletionState: 'pendingStopReconciliation',
    })).toBe(false);
  });
});
