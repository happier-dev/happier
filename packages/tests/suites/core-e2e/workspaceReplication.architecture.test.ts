import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../../src/testkit/paths';

const PRODUCTION_FILE_SUFFIXES = ['.ts', '.tsx'] as const;
const UI_BULK_TRANSFER_PIPELINE_DIR_FRAGMENT = '/sync/domains/transfers/runtime/bulkTransferPipeline/' as const;
const UI_BULK_TRANSFER_PIPELINE_PUBLIC_IMPORT = "@/sync/domains/transfers/runtime/bulkTransferPipeline" as const;
const BANNED_HANDOFF_BASE64_TOKENS = [
  "contentBase64",
] as const;
const BANNED_UI_TRANSFER_PLUMBING_TOKENS = [
  'chunkTransferClient',
  'sessionFileTransferRpcCaller',
  'uploadMachineTransferJsonPayload',
  'downloadMachineTransferJsonPayload',
] as const;
const BANNED_UI_TRANSFER_RPC_PREFIXES = [
  'RPC_METHODS.DAEMON_BULK_TRANSFER_',
] as const;
const BANNED_LEGACY_SESSION_TRANSFER_FAMILY_TOKENS = [
  // Legacy app↔daemon transfer family (should be fully deleted, not just unused).
  'DAEMON_SESSION_FILES_',
  'DAEMON_SESSION_ATTACHMENTS_UPLOAD_',
  'RPC_METHODS.DAEMON_SESSION_FILES_',
  'RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_',
  'RPC_METHODS.FILES_',
  'RPC_METHODS.ATTACHMENTS_CONFIGURE',
] as const;
const RETIRED_UI_TRANSFER_MODULE_PATHS = [
  'apps/ui/sources/sync/domains/transfers/runtime/uploadMachineTransferJsonPayload.ts',
  'apps/ui/sources/sync/domains/transfers/runtime/downloadMachineTransferJsonPayload.ts',
  'apps/ui/sources/sync/domains/transfers/runtime/sessionFileTransferRpcCaller.ts',
  'apps/ui/sources/sync/domains/transfers/runtime/chunkTransferClient.ts',
  'apps/ui/sources/sync/domains/transfers/runtime/transferChunkEncryption.ts',
  'apps/ui/sources/sync/domains/transfers/runtime/uploadBulkPayloadFromFile.ts',
  'apps/ui/sources/sync/domains/transfers/runtime/uploadBulkJsonPayload.ts',
  'apps/ui/sources/sync/domains/transfers/runtime/downloadBulkJsonPayload.ts',
] as const;

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(path)));
    } else {
      results.push(path);
    }
  }
  return results;
}

function isProductionSourceFile(filePath: string): boolean {
  if (!PRODUCTION_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) {
    return false;
  }
  if (filePath.endsWith('.d.ts')) return false;
  if (filePath.endsWith('.test.ts')) return false;
  if (filePath.endsWith('.test.tsx')) return false;
  if (filePath.endsWith('.spec.ts')) return false;
  if (filePath.endsWith('.spec.tsx')) return false;
  if (filePath.endsWith('.architecture.test.ts')) return false;
  if (filePath.endsWith('.architecture.test.tsx')) return false;
  if (filePath.endsWith('.importBoundary.test.ts')) return false;
  if (filePath.endsWith('Schema.ts')) return false;
  if (filePath.endsWith('Schemas.ts')) return false;
  return true;
}

function hasInlineBase64PayloadAssembly(content: string): boolean {
  return /Buffer\.from\([^)]*['"](base64|base64url)['"]/.test(content)
    || /\b(?:content|payload|encryptedDataKeyEnvelope)Base64\b/.test(content);
}

async function pathExists(rootRelativePath: string): Promise<boolean> {
  const root = repoRootDir();
  const absolute = join(root, rootRelativePath);
  try {
    await readFile(absolute, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function readProductionSources(rootRelativePath: string): Promise<Array<Readonly<{ path: string; content: string }>>> {
  const root = repoRootDir();
  const sourceRoot = join(root, rootRelativePath);
  const files = (await listFilesRecursively(sourceRoot)).filter(isProductionSourceFile);
  return await Promise.all(
    files.map(async (path) => ({
      path,
      content: await readFile(path, 'utf8'),
    })),
  );
}

async function readProductionSourceFiles(rootRelativePaths: readonly string[]): Promise<Array<Readonly<{ path: string; content: string }>>> {
  const sources: Array<Readonly<{ path: string; content: string }>> = [];
  for (const rootRelativePath of rootRelativePaths) {
    sources.push(...(await readProductionSources(rootRelativePath)));
  }
  return sources;
}

describe('workspace replication architecture closures', () => {
  it('keeps the direct-peer handoff runtime free of inline/base64 bulk payload assembly', async () => {
    const sources = await readProductionSourceFiles([
      'apps/cli/src/session/handoff/prepare',
      'apps/cli/src/session/handoff/metadata',
      'apps/cli/src/session/handoff/state',
      'apps/cli/src/session/handoff/workspaceReplicationAdapter',
      'apps/cli/src/api/machine',
    ]);

    for (const { path, content } of sources) {
      expect(hasInlineBase64PayloadAssembly(content), path).toBe(false);
      for (const token of BANNED_HANDOFF_BASE64_TOKENS) {
        expect(content, path).not.toContain(token);
      }
    }
  });

  it('keeps bulk transfer plumbing scoped to bulkTransferPipeline/** in the UI source tree', async () => {
    const sources = await readProductionSources('apps/ui/sources');

    for (const { path, content } of sources) {
      if (path.includes(UI_BULK_TRANSFER_PIPELINE_DIR_FRAGMENT)) {
        continue;
      }

      for (const token of BANNED_UI_TRANSFER_PLUMBING_TOKENS) {
        expect(content, path).not.toContain(token);
      }
      for (const token of BANNED_UI_TRANSFER_RPC_PREFIXES) {
        expect(content, path).not.toContain(token);
      }
    }
  });

  it('requires UI feature code to import bulk transfer primitives only from the bulkTransferPipeline public entrypoint', async () => {
    const sources = await readProductionSources('apps/ui/sources');
    const internalImportRegex = new RegExp(
      String.raw`from\s+['"]${UI_BULK_TRANSFER_PIPELINE_PUBLIC_IMPORT.replace(/\//g, '\\/')}/`,
      'g',
    );

    for (const { path, content } of sources) {
      if (path.includes(UI_BULK_TRANSFER_PIPELINE_DIR_FRAGMENT)) {
        continue;
      }
      expect(content.match(internalImportRegex), path).toBe(null);
    }
  });

  it('does not reference the legacy app↔daemon session files/attachments transfer family in production sources', async () => {
    const sources = await readProductionSourceFiles([
      'apps/ui/sources',
      'apps/cli/src',
      'packages/protocol/src',
    ]);

    for (const { path, content } of sources) {
      for (const token of BANNED_LEGACY_SESSION_TRANSFER_FAMILY_TOKENS) {
        expect(content, path).not.toContain(token);
      }
    }
  });

  it('keeps retired UI transfer helper modules deleted and the canonical bulkTransferPipeline entrypoint present', async () => {
    expect(await pathExists('apps/ui/sources/sync/domains/transfers/runtime/bulkTransferPipeline/index.ts')).toBe(true);

    for (const rootRelativePath of RETIRED_UI_TRANSFER_MODULE_PATHS) {
      expect(await pathExists(rootRelativePath), rootRelativePath).toBe(false);
    }
  });
});
