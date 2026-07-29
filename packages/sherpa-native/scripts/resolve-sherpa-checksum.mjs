import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * @param {{ checksumsText: string; archive: string }} input
 * @returns {string}
 */
export function resolveSherpaChecksum({ checksumsText, archive }) {
  const targetArchive = String(archive ?? "").trim();
  if (!targetArchive) {
    throw new Error("[HappierSherpaNative] archive name is required");
  }

  for (const rawLine of String(checksumsText ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const [first, second] = parts;
    if (first === targetArchive && SHA256_PATTERN.test(second)) {
      return second.toLowerCase();
    }
    if (second === targetArchive && SHA256_PATTERN.test(first)) {
      return first.toLowerCase();
    }
  }

  throw new Error(`[HappierSherpaNative] sha256 not found for ${targetArchive}`);
}

function runCli() {
  const [checksumPath, archive] = process.argv.slice(2);
  if (!checksumPath || !archive) {
    console.error("Usage: node resolve-sherpa-checksum.mjs <checksum.txt> <archive>");
    process.exit(2);
  }

  try {
    const checksum = resolveSherpaChecksum({
      archive,
      checksumsText: readFileSync(checksumPath, "utf8"),
    });
    process.stdout.write(`${checksum}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function isMainEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  runCli();
}
