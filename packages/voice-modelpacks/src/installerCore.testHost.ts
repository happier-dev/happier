/**
 * In-memory {@link ModelPackInstallerHost} for installer-core tests.
 *
 * Models a packs-root filesystem (live + staging + backup + per-file resume
 * partials) and a fake HTTP server with Range support, entirely in memory. No
 * `node:*` filesystem or network is touched except `node:crypto` for hashing,
 * which is the digest boundary a real host injects.
 */

import { createHash } from 'node:crypto';

import type { ModelPackManifest } from '@happier-dev/protocol';

import type {
  ModelPackDownloadRequest,
  ModelPackDownloadStream,
  ModelPackHasher,
  ModelPackInstallerHost,
  ModelPackStagingPlan,
  ModelPackStagingHandle,
} from './installerCore.js';

export type MemoryHostState = Readonly<{
  /** Live + staging + backup files, keyed by `<dirKey>/<relPath>`. */
  files: Map<string, Uint8Array>;
}>;

type ServedFile = Readonly<{ bytes: Uint8Array; chunks?: readonly Uint8Array[] }>;

type RangeRequest = Readonly<{ start: number }>;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function createMemoryHasher(): ModelPackHasher {
  const hash = createHash('sha256');
  return {
    update: (chunk) => {
      hash.update(Buffer.from(chunk));
    },
    digestHex: async () => hash.digest('hex').toLowerCase(),
  };
}

export function createMemoryModelPackInstallerHost() {
  // Live install tree: `<packId>/<relPath>` (incl. `pack.json`).
  const live = new Map<string, Uint8Array>();
  // Per-attempt staging tree: `<stagingKey>/<relPath>`.
  const staging = new Map<string, Uint8Array>();
  // Resume partials, keyed by `<packId>/<relPath>`, surviving across attempts.
  const partials = new Map<string, Uint8Array>();
  const resumePlanKeys = new Map<string, string>();
  // Backup tree captured during promote.
  const backup = new Map<string, Uint8Array>();

  const served = new Map<string, ServedFile>();
  const failed = new Set<string>();
  const requestedUrls: string[] = [];
  const rangeRequests = new Map<string, RangeRequest[]>();

  let stagingCounter = 0;

  function openDownload(request: ModelPackDownloadRequest): Promise<ModelPackDownloadStream> {
    requestedUrls.push(request.url);
    if (failed.has(request.url)) {
      return Promise.reject(new Error(`model_pack_download_failed:500:${request.url}`));
    }
    const file = served.get(request.url);
    if (!file) {
      return Promise.reject(new Error(`model_pack_download_failed:404:${request.url}`));
    }

    const start = request.rangeStart && request.rangeStart > 0 ? request.rangeStart : 0;
    const isPartial = start > 0;
    if (isPartial) {
      const list = rangeRequests.get(request.url) ?? [];
      list.push({ start });
      rangeRequests.set(request.url, list);
    }

    const full = file.bytes;
    const sliced = start > 0 ? full.slice(start) : full;
    const chunks =
      file.chunks && start === 0
        ? [...file.chunks]
        : sliced.byteLength > 0
          ? [sliced]
          : [];

    let i = 0;
    const stream: ModelPackDownloadStream = {
      contentLength: sliced.byteLength,
      isPartial,
      read: async () => {
        if (i >= chunks.length) return null;
        return chunks[i++]!;
      },
    };
    return Promise.resolve(stream);
  }

  function beginStaging(packId: string, plan: ModelPackStagingPlan): Promise<ModelPackStagingHandle> {
    const stagingKey = `.staging-${stagingCounter++}-${packId}`;
    const livePrefix = `${packId}/`;
    if (resumePlanKeys.get(packId) !== plan.key) {
      for (const key of [...partials.keys()]) {
        if (key.startsWith(livePrefix)) partials.delete(key);
      }
    }
    resumePlanKeys.set(packId, plan.key);
    const allowedPaths = new Set(plan.filePaths);
    for (const key of [...partials.keys()]) {
      if (key.startsWith(livePrefix) && !allowedPaths.has(key.slice(livePrefix.length))) {
        partials.delete(key);
      }
    }

    function stagedKey(filePath: string): string {
      return `${stagingKey}/${filePath}`;
    }
    function partialKey(filePath: string): string {
      return `${packId}/${filePath}`;
    }

    const handle: ModelPackStagingHandle = {
      partialByteLength: async (filePath) => partials.get(partialKey(filePath))?.byteLength ?? 0,
      streamPartial: async (filePath, onChunk) => {
        const partial = partials.get(partialKey(filePath));
        if (!partial) return 0;
        await onChunk(partial);
        return partial.byteLength;
      },
      resetPartial: async (filePath) => {
        partials.delete(partialKey(filePath));
        staging.delete(stagedKey(filePath));
      },
      appendDownloadedChunk: async (filePath, chunk) => {
        const prior = partials.get(partialKey(filePath)) ?? new Uint8Array();
        const next = concat([prior, chunk]);
        partials.set(partialKey(filePath), next);
        staging.set(stagedKey(filePath), next);
      },
      writeManifest: async (manifest) => {
        staging.set(stagedKey('pack.json'), new TextEncoder().encode(JSON.stringify({ manifest })));
      },
      promote: async () => {
        // Back up the live tree.
        for (const [key, value] of [...live.entries()]) {
          if (key.startsWith(livePrefix)) {
            backup.set(key, value);
            live.delete(key);
          }
        }
        // Promote staged files (incl. those carried from completed partials).
        const stagedPrefix = `${stagingKey}/`;
        // Ensure any partial that completed but was never re-set into staging is present.
        for (const [key, value] of partials.entries()) {
          if (key.startsWith(livePrefix)) {
            const rel = key.slice(livePrefix.length);
            const sk = `${stagingKey}/${rel}`;
            if (!staging.has(sk)) staging.set(sk, value);
          }
        }
        for (const [key, value] of [...staging.entries()]) {
          if (key.startsWith(stagedPrefix)) {
            const rel = key.slice(stagedPrefix.length);
            live.set(`${packId}/${rel}`, value);
            staging.delete(key);
          }
        }
        let settled = false;
        return {
          rootLocation: `mem://${packId}`,
          prepareDurableCommit: async () => undefined,
          markDurableCommitted: async () => undefined,
          commit: async () => {
            if (settled) return;
            settled = true;
            for (const key of [...backup.keys()]) {
              if (key.startsWith(livePrefix)) backup.delete(key);
            }
            for (const key of [...partials.keys()]) {
              if (key.startsWith(livePrefix)) partials.delete(key);
            }
            resumePlanKeys.delete(packId);
          },
          rollback: async () => {
            if (settled) return;
            settled = true;
            for (const key of [...live.keys()]) {
              if (key.startsWith(livePrefix)) live.delete(key);
            }
            for (const [key, value] of [...backup.entries()]) {
              if (key.startsWith(livePrefix)) {
                live.set(key, value);
                backup.delete(key);
              }
            }
          },
          completeRollback: async () => undefined,
        };
      },
      cleanup: async () => {
        const stagedPrefix = `${stagingKey}/`;
        for (const key of [...staging.keys()]) {
          if (key.startsWith(stagedPrefix)) staging.delete(key);
        }
        // Restore any backup that was not consumed by a successful promote.
        const livePrefix = `${packId}/`;
        const hasLive = [...live.keys()].some((k) => k.startsWith(livePrefix));
        if (!hasLive) {
          for (const [key, value] of [...backup.entries()]) {
            if (key.startsWith(livePrefix)) {
              live.set(key, value);
              backup.delete(key);
            }
          }
        } else {
          for (const key of [...backup.keys()]) {
            if (key.startsWith(livePrefix)) backup.delete(key);
          }
        }
      },
    };
    return Promise.resolve(handle);
  }

  const host: ModelPackInstallerHost = {
    openDownload,
    createHasher: createMemoryHasher,
    beginStaging,
  };

  return {
    host,
    state: { files: live } satisfies MemoryHostState,

    serveFile: (url: string, bytes: Uint8Array, opts: { chunks?: readonly Uint8Array[] } = {}) => {
      served.set(url, { bytes, chunks: opts.chunks });
    },
    failUrl: (url: string) => {
      failed.add(url);
    },
    seedPartialDownload: (key: string, bytes: Uint8Array, resumePlanKey?: string) => {
      partials.set(key, bytes);
      const slash = key.indexOf('/');
      if (resumePlanKey && slash > 0) resumePlanKeys.set(key.slice(0, slash), resumePlanKey);
    },
    seedInstalled: (packId: string, files: Record<string, Uint8Array>, manifest: ModelPackManifest) => {
      for (const [rel, bytes] of Object.entries(files)) {
        live.set(`${packId}/${rel}`, bytes);
      }
      live.set(`${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    },

    read: (key: string): Uint8Array | undefined => live.get(key),
    readText: (key: string): string | undefined => {
      const bytes = live.get(key);
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    },
    requestedUrls: (): readonly string[] => requestedUrls,
    rangeRequestsFor: (url: string): readonly RangeRequest[] => rangeRequests.get(url) ?? [],
    /** Any scratch left behind (staging or backup). Empty means clean teardown. */
    leftovers: (): string[] => [...staging.keys(), ...backup.keys()].sort(),
  };
}
